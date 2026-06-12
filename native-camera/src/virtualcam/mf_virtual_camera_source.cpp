#include "mf_virtual_camera_source.h"

#include <algorithm>
#include <atomic>
#include <cstdint>
#include <cstring>
#include <mutex>
#include <utility>
#include <vector>

#include <ks.h>
#include <ksmedia.h>
#include <ksproxy.h>
#include <mfapi.h>
#include <mferror.h>
#include <mfidl.h>
#include <mfobjects.h>
#include <mfvirtualcamera.h>
#include <propvarutil.h>
#include <sddl.h>
#include <strsafe.h>
#include <wrl.h>

#include "surevideotool/surevideotool_ids.h"
#include "surevideotool/surevideotool_protocol.h"

using Microsoft::WRL::ComPtr;
using Microsoft::WRL::Make;
using Microsoft::WRL::RuntimeClass;
using Microsoft::WRL::RuntimeClassFlags;

#ifndef RETURN_IF_FAILED
#define RETURN_IF_FAILED(expression)                     \
    do                                                  \
    {                                                   \
        const HRESULT __hr = (expression);              \
        if (FAILED(__hr))                               \
        {                                               \
            return __hr;                                \
        }                                               \
    } while (false)
#endif

namespace surevideotool::virtualcam
{
    namespace
    {
        void AppendMfVirtualCameraLogLine(const wchar_t* message) noexcept
        {
            if (message == nullptr || *message == L'\0')
            {
                return;
            }

            wchar_t wideLine[768]{};
            if (FAILED(StringCchPrintfW(
                    wideLine,
                    ARRAYSIZE(wideLine),
                    L"[pid=%lu] %s\r\n",
                    GetCurrentProcessId(),
                    message)))
            {
                return;
            }

            OutputDebugStringW(wideLine);

            HANDLE file = CreateFileW(
                L"C:\\ProgramData\\Tech Lord Media\\mf_source.log",
                FILE_APPEND_DATA,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                nullptr,
                OPEN_ALWAYS,
                FILE_ATTRIBUTE_NORMAL,
                nullptr);
            if (file == INVALID_HANDLE_VALUE)
            {
                return;
            }

            char utf8Line[1536]{};
            const int utf8Bytes = WideCharToMultiByte(
                CP_UTF8,
                0,
                wideLine,
                -1,
                utf8Line,
                static_cast<int>(sizeof(utf8Line)),
                nullptr,
                nullptr);
            if (utf8Bytes > 1)
            {
                DWORD written = 0;
                WriteFile(file, utf8Line, static_cast<DWORD>(utf8Bytes - 1), &written, nullptr);
            }

            CloseHandle(file);
        }

        void TryEnableCreateGlobalPrivilege() noexcept
        {
            HANDLE token = nullptr;
            if (!OpenProcessToken(GetCurrentProcess(), TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY, &token))
            {
                return;
            }

            TOKEN_PRIVILEGES tp{};
            tp.PrivilegeCount = 1;
            tp.Privileges[0].Attributes = SE_PRIVILEGE_ENABLED;
            if (LookupPrivilegeValueW(nullptr, SE_CREATE_GLOBAL_NAME, &tp.Privileges[0].Luid))
            {
                AdjustTokenPrivileges(token, FALSE, &tp, 0, nullptr, nullptr);
            }

            CloseHandle(token);
        }

        constexpr uint32_t kDefaultWidth = 1280;
        constexpr uint32_t kDefaultHeight = 720;
        constexpr uint32_t kDefaultStride = kDefaultWidth * 4;
        constexpr uint32_t kDefaultFpsNumerator = 30;
        constexpr uint32_t kDefaultFpsDenominator = 1;
        constexpr DWORD kStreamId = 0;
        constexpr LONGLONG kHundredsOfNsPerSecond = 10'000'000LL;

    const GUID kMfVirtualCameraProvideAssociatedCameraSources =
    { 0xF0273718, 0x4A4D, 0x4AC5, { 0xA1, 0x5D, 0x30, 0x5E, 0xB5, 0xE9, 0x06, 0x67 } };

        std::atomic_ulong g_objectCount = 0;
        std::atomic_ulong g_lockCount = 0;

        enum class SourceState
        {
            Invalid,
            Stopped,
            Started,
            Shutdown,
        };

        struct MediaConfig
        {
            uint32_t width = kDefaultWidth;
            uint32_t height = kDefaultHeight;
            uint32_t stride = kDefaultStride;
            uint32_t fpsNumerator = kDefaultFpsNumerator;
            uint32_t fpsDenominator = kDefaultFpsDenominator;
        };

        void AddObjectRef() noexcept
        {
            ++g_objectCount;
        }

        void ReleaseObjectRef() noexcept
        {
            --g_objectCount;
        }

        HRESULT WaitForOwnedMutex(HANDLE mutex) noexcept
        {
            // Must never block the FrameServer thread — the camera pipeline has a hard
            // budget per RequestSample call. If the publisher is busy, fall back to the
            // last cached frame (or a black frame) instead of stalling.
            const DWORD waitResult = WaitForSingleObject(mutex, 50);
            if (waitResult == WAIT_OBJECT_0 || waitResult == WAIT_ABANDONED)
            {
                return S_OK;
            }

            if (waitResult == WAIT_TIMEOUT)
            {
                return HRESULT_FROM_WIN32(WAIT_TIMEOUT);
            }

            return HRESULT_FROM_WIN32(GetLastError());
        }

        HRESULT EnsureBridgeDirectoryExists(const wchar_t* directoryPath)
        {
            if (directoryPath == nullptr || *directoryPath == L'\0')
            {
                return E_INVALIDARG;
            }

            if (CreateDirectoryW(directoryPath, nullptr) || GetLastError() == ERROR_ALREADY_EXISTS)
            {
                return S_OK;
            }

            return HRESULT_FROM_WIN32(GetLastError());
        }

        struct SecurityDescriptorHolder
        {
            ~SecurityDescriptorHolder()
            {
                if (descriptor != nullptr)
                {
                    LocalFree(descriptor);
                }
            }

            PSECURITY_DESCRIPTOR descriptor = nullptr;
        };

        HRESULT BuildBridgeSecurityAttributes(SECURITY_ATTRIBUTES* attributes, SecurityDescriptorHolder* descriptorHolder)
        {
            if (attributes == nullptr || descriptorHolder == nullptr)
            {
                return E_POINTER;
            }

            static constexpr wchar_t kBridgeSecurityDescriptor[] =
                L"D:P"
                L"(A;;GA;;;SY)"
                L"(A;;GA;;;BA)"
                L"(A;;GA;;;LS)"
                L"(A;;GA;;;AU)";

            if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(
                    kBridgeSecurityDescriptor,
                    SDDL_REVISION_1,
                    &descriptorHolder->descriptor,
                    nullptr))
            {
                return HRESULT_FROM_WIN32(GetLastError());
            }

            attributes->nLength = sizeof(*attributes);
            attributes->lpSecurityDescriptor = descriptorHolder->descriptor;
            attributes->bInheritHandle = FALSE;
            return S_OK;
        }

        uint32_t ClampToByte(int value) noexcept
        {
            return static_cast<uint32_t>(std::clamp(value, 0, 255));
        }

        uint8_t ToLuma(uint8_t red, uint8_t green, uint8_t blue) noexcept
        {
            const int value = ((66 * red) + (129 * green) + (25 * blue) + 128) >> 8;
            return static_cast<uint8_t>(ClampToByte(value + 16));
        }

        uint8_t ToChromaU(uint8_t red, uint8_t green, uint8_t blue) noexcept
        {
            const int value = ((-38 * red) - (74 * green) + (112 * blue) + 128) >> 8;
            return static_cast<uint8_t>(ClampToByte(value + 128));
        }

        uint8_t ToChromaV(uint8_t red, uint8_t green, uint8_t blue) noexcept
        {
            const int value = ((112 * red) - (94 * green) - (18 * blue) + 128) >> 8;
            return static_cast<uint8_t>(ClampToByte(value + 128));
        }

        uint32_t GetSubtypeStride(const GUID& subtype, uint32_t width) noexcept
        {
            if (subtype == MFVideoFormat_YUY2)
            {
                return width * 2;
            }

            if (subtype == MFVideoFormat_RGB32)
            {
                return width * 4;
            }

            if (subtype == MFVideoFormat_NV12)
            {
                return width;
            }

            return 0;
        }

        uint32_t GetSubtypeSampleSize(const GUID& subtype, uint32_t width, uint32_t height) noexcept
        {
            if (subtype == MFVideoFormat_YUY2)
            {
                return width * height * 2;
            }

            if (subtype == MFVideoFormat_RGB32)
            {
                return width * height * 4;
            }

            if (subtype == MFVideoFormat_NV12)
            {
                return width * height * 3 / 2;
            }

            return 0;
        }

        HRESULT CreateVideoType(const GUID& subtype, const MediaConfig& config, IMFMediaType** mediaType)
        {
            if (mediaType == nullptr)
            {
                return E_POINTER;
            }

            if (subtype != MFVideoFormat_YUY2 && subtype != MFVideoFormat_NV12 && subtype != MFVideoFormat_RGB32)
            {
                return MF_E_INVALIDMEDIATYPE;
            }

            *mediaType = nullptr;

            ComPtr<IMFMediaType> value;
            RETURN_IF_FAILED(MFCreateMediaType(&value));
            RETURN_IF_FAILED(value->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video));
            RETURN_IF_FAILED(value->SetGUID(MF_MT_SUBTYPE, subtype));
            RETURN_IF_FAILED(value->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive));
            RETURN_IF_FAILED(value->SetUINT32(MF_MT_ALL_SAMPLES_INDEPENDENT, TRUE));
            RETURN_IF_FAILED(value->SetUINT32(MF_MT_FIXED_SIZE_SAMPLES, TRUE));
            RETURN_IF_FAILED(MFSetAttributeSize(value.Get(), MF_MT_FRAME_SIZE, config.width, config.height));
            RETURN_IF_FAILED(MFSetAttributeRatio(value.Get(), MF_MT_FRAME_RATE, config.fpsNumerator, config.fpsDenominator));
            RETURN_IF_FAILED(MFSetAttributeRatio(value.Get(), MF_MT_PIXEL_ASPECT_RATIO, 1, 1));

            const uint32_t sampleSize = GetSubtypeSampleSize(subtype, config.width, config.height);
            const uint32_t stride = GetSubtypeStride(subtype, config.width);
            RETURN_IF_FAILED(value->SetUINT32(MF_MT_DEFAULT_STRIDE, stride));

            RETURN_IF_FAILED(value->SetUINT32(MF_MT_SAMPLE_SIZE, sampleSize));

            *mediaType = value.Detach();
            return S_OK;
        }

        bool IsSupportedStartPosition(const PROPVARIANT* startPosition) noexcept
        {
            if (startPosition == nullptr)
            {
                return false;
            }

            if (startPosition->vt == VT_EMPTY)
            {
                return true;
            }

            return startPosition->vt == VT_I8 && startPosition->hVal.QuadPart == 0;
        }

        void FillSyntheticBgra(const MediaConfig& config, uint64_t frameIndex, std::vector<uint8_t>* bgra)
        {
            const size_t payloadSize = static_cast<size_t>(config.stride) * config.height;
            bgra->resize(payloadSize);

            for (uint32_t y = 0; y < config.height; ++y)
            {
                uint8_t* row = bgra->data() + (static_cast<size_t>(y) * config.stride);
                for (uint32_t x = 0; x < config.width; ++x)
                {
                    const uint8_t phase = static_cast<uint8_t>((frameIndex * 3) & 0xff);
                    row[(x * 4) + 0] = static_cast<uint8_t>((x + phase) & 0xff);
                    row[(x * 4) + 1] = static_cast<uint8_t>((y + phase) & 0xff);
                    row[(x * 4) + 2] = static_cast<uint8_t>(((x / 2) + (y / 3) + phase) & 0xff);
                    row[(x * 4) + 3] = 0xff;
                }
            }
        }

        void ConvertBgraToYuy2(const MediaConfig& config, const uint8_t* bgra, std::vector<uint8_t>* yuy2)
        {
            const uint32_t outputStride = config.width * 2;
            yuy2->resize(static_cast<size_t>(outputStride) * config.height);

            for (uint32_t y = 0; y < config.height; ++y)
            {
                const uint8_t* srcRow = bgra + (static_cast<size_t>(y) * config.stride);
                uint8_t* dstRow = yuy2->data() + (static_cast<size_t>(y) * outputStride);

                for (uint32_t x = 0; x < config.width; x += 2)
                {
                    const uint8_t* pixel0 = srcRow + (x * 4);
                    const uint8_t* pixel1 = srcRow + (std::min(x + 1, config.width - 1) * 4);

                    const uint8_t blue0 = pixel0[0];
                    const uint8_t green0 = pixel0[1];
                    const uint8_t red0 = pixel0[2];

                    const uint8_t blue1 = pixel1[0];
                    const uint8_t green1 = pixel1[1];
                    const uint8_t red1 = pixel1[2];

                    const uint8_t y0 = ToLuma(red0, green0, blue0);
                    const uint8_t y1 = ToLuma(red1, green1, blue1);
                    const uint8_t u0 = ToChromaU(red0, green0, blue0);
                    const uint8_t u1 = ToChromaU(red1, green1, blue1);
                    const uint8_t v0 = ToChromaV(red0, green0, blue0);
                    const uint8_t v1 = ToChromaV(red1, green1, blue1);

                    const size_t outIndex = static_cast<size_t>(x) * 2;
                    dstRow[outIndex + 0] = y0;
                    dstRow[outIndex + 1] = static_cast<uint8_t>((static_cast<uint16_t>(u0) + u1) / 2);
                    dstRow[outIndex + 2] = y1;
                    dstRow[outIndex + 3] = static_cast<uint8_t>((static_cast<uint16_t>(v0) + v1) / 2);
                }
            }
        }

        void ConvertBgraToNv12(const MediaConfig& config, const uint8_t* bgra, std::vector<uint8_t>* nv12)
        {
            const uint32_t yStride = config.width;
            const size_t yPlaneBytes = static_cast<size_t>(yStride) * config.height;
            nv12->resize(yPlaneBytes + (yPlaneBytes / 2));

            uint8_t* yPlane = nv12->data();
            uint8_t* uvPlane = nv12->data() + yPlaneBytes;

            for (uint32_t y = 0; y < config.height; ++y)
            {
                const uint8_t* srcRow = bgra + (static_cast<size_t>(y) * config.stride);
                uint8_t* yRow = yPlane + (static_cast<size_t>(y) * yStride);

                for (uint32_t x = 0; x < config.width; ++x)
                {
                    const uint8_t* pixel = srcRow + (static_cast<size_t>(x) * 4);
                    yRow[x] = ToLuma(pixel[2], pixel[1], pixel[0]);
                }
            }

            for (uint32_t y = 0; y < config.height; y += 2)
            {
                const uint8_t* srcRow0 = bgra + (static_cast<size_t>(y) * config.stride);
                const uint8_t* srcRow1 = bgra + (static_cast<size_t>(std::min(y + 1, config.height - 1)) * config.stride);
                uint8_t* uvRow = uvPlane + (static_cast<size_t>(y / 2) * yStride);

                for (uint32_t x = 0; x < config.width; x += 2)
                {
                    const uint8_t* pixel00 = srcRow0 + (static_cast<size_t>(x) * 4);
                    const uint8_t* pixel01 = srcRow0 + (static_cast<size_t>(std::min(x + 1, config.width - 1)) * 4);
                    const uint8_t* pixel10 = srcRow1 + (static_cast<size_t>(x) * 4);
                    const uint8_t* pixel11 = srcRow1 + (static_cast<size_t>(std::min(x + 1, config.width - 1)) * 4);

                    const uint8_t u00 = ToChromaU(pixel00[2], pixel00[1], pixel00[0]);
                    const uint8_t u01 = ToChromaU(pixel01[2], pixel01[1], pixel01[0]);
                    const uint8_t u10 = ToChromaU(pixel10[2], pixel10[1], pixel10[0]);
                    const uint8_t u11 = ToChromaU(pixel11[2], pixel11[1], pixel11[0]);

                    const uint8_t v00 = ToChromaV(pixel00[2], pixel00[1], pixel00[0]);
                    const uint8_t v01 = ToChromaV(pixel01[2], pixel01[1], pixel01[0]);
                    const uint8_t v10 = ToChromaV(pixel10[2], pixel10[1], pixel10[0]);
                    const uint8_t v11 = ToChromaV(pixel11[2], pixel11[1], pixel11[0]);

                    const size_t uvIndex = x;
                    uvRow[uvIndex + 0] = static_cast<uint8_t>((static_cast<uint16_t>(u00) + u01 + u10 + u11) / 4);
                    uvRow[uvIndex + 1] = static_cast<uint8_t>((static_cast<uint16_t>(v00) + v01 + v10 + v11) / 4);
                }
            }
        }

        // Required NV12 byte count for a given resolution.
        constexpr size_t Nv12FrameBytes(uint32_t width, uint32_t height) noexcept
        {
            return static_cast<size_t>(width) * height * 3 / 2;
        }

        constexpr size_t Yuy2FrameBytes(uint32_t width, uint32_t height) noexcept
        {
            return static_cast<size_t>(width) * height * 2;
        }

        constexpr size_t Rgb32FrameBytes(uint32_t width, uint32_t height) noexcept
        {
            return static_cast<size_t>(width) * height * 4;
        }

        void FillBlackYuy2(uint8_t* dst, uint32_t width, uint32_t height) noexcept
        {
            if (dst == nullptr || width == 0 || height == 0)
            {
                return;
            }

            const size_t byteCount = Yuy2FrameBytes(width, height);
            for (size_t offset = 0; offset + 3 < byteCount; offset += 4)
            {
                dst[offset + 0] = 16;
                dst[offset + 1] = 128;
                dst[offset + 2] = 16;
                dst[offset + 3] = 128;
            }
        }

        void FillBlackRgb32(uint8_t* dst, uint32_t width, uint32_t height) noexcept
        {
            if (dst == nullptr || width == 0 || height == 0)
            {
                return;
            }

            const size_t byteCount = Rgb32FrameBytes(width, height);
            for (size_t offset = 0; offset + 3 < byteCount; offset += 4)
            {
                dst[offset + 0] = 0;
                dst[offset + 1] = 0;
                dst[offset + 2] = 0;
                dst[offset + 3] = 0xff;
            }
        }

        // Fill an NV12 buffer with limited-range black (Y=16, UV=128). Cheap, safe
        // fallback that always satisfies the FrameServer when no real frame is ready.
        void FillBlackNv12(uint8_t* dst, uint32_t width, uint32_t height) noexcept
        {
            if (dst == nullptr || width == 0 || height == 0)
            {
                return;
            }

            const size_t yPlane = static_cast<size_t>(width) * height;
            std::memset(dst, 16, yPlane);
            std::memset(dst + yPlane, 128, yPlane / 2);
        }

        // Direct CPU BGRA -> NV12 conversion that writes straight into the locked
        // IMFMediaBuffer. Caller must have already verified destBytes >= width*h*3/2.
        // srcStride is the source BGRA row pitch in bytes; width/height are pixels.
        bool WriteBgraToNv12Buffer(
            const uint8_t* bgra,
            uint32_t srcStride,
            uint8_t* dst,
            size_t destBytes,
            uint32_t width,
            uint32_t height) noexcept
        {
            if (bgra == nullptr || dst == nullptr || width == 0 || height == 0)
            {
                return false;
            }

            const size_t yPlaneBytes = static_cast<size_t>(width) * height;
            if (destBytes < yPlaneBytes + (yPlaneBytes / 2))
            {
                return false;
            }

            uint8_t* yPlane = dst;
            uint8_t* uvPlane = dst + yPlaneBytes;

            for (uint32_t y = 0; y < height; ++y)
            {
                const uint8_t* srcRow = bgra + (static_cast<size_t>(y) * srcStride);
                uint8_t* yRow = yPlane + (static_cast<size_t>(y) * width);
                for (uint32_t x = 0; x < width; ++x)
                {
                    const uint8_t* p = srcRow + (static_cast<size_t>(x) * 4);
                    yRow[x] = ToLuma(p[2], p[1], p[0]);
                }
            }

            for (uint32_t y = 0; y < height; y += 2)
            {
                const uint8_t* srcRow0 = bgra + (static_cast<size_t>(y) * srcStride);
                const uint8_t* srcRow1 = bgra + (static_cast<size_t>(std::min(y + 1, height - 1)) * srcStride);
                uint8_t* uvRow = uvPlane + (static_cast<size_t>(y / 2) * width);
                for (uint32_t x = 0; x < width; x += 2)
                {
                    const uint8_t* p00 = srcRow0 + (static_cast<size_t>(x) * 4);
                    const uint8_t* p01 = srcRow0 + (static_cast<size_t>(std::min(x + 1, width - 1)) * 4);
                    const uint8_t* p10 = srcRow1 + (static_cast<size_t>(x) * 4);
                    const uint8_t* p11 = srcRow1 + (static_cast<size_t>(std::min(x + 1, width - 1)) * 4);

                    const uint16_t uSum =
                        static_cast<uint16_t>(ToChromaU(p00[2], p00[1], p00[0])) +
                        ToChromaU(p01[2], p01[1], p01[0]) +
                        ToChromaU(p10[2], p10[1], p10[0]) +
                        ToChromaU(p11[2], p11[1], p11[0]);
                    const uint16_t vSum =
                        static_cast<uint16_t>(ToChromaV(p00[2], p00[1], p00[0])) +
                        ToChromaV(p01[2], p01[1], p01[0]) +
                        ToChromaV(p10[2], p10[1], p10[0]) +
                        ToChromaV(p11[2], p11[1], p11[0]);

                    uvRow[x + 0] = static_cast<uint8_t>(uSum / 4);
                    uvRow[x + 1] = static_cast<uint8_t>(vSum / 4);
                }
            }

            return true;
        }

        bool WriteBgraToYuy2Buffer(
            const uint8_t* bgra,
            uint32_t srcStride,
            uint8_t* dst,
            size_t destBytes,
            uint32_t width,
            uint32_t height) noexcept
        {
            if (bgra == nullptr || dst == nullptr || width == 0 || height == 0)
            {
                return false;
            }

            const size_t requiredBytes = Yuy2FrameBytes(width, height);
            if (destBytes < requiredBytes)
            {
                return false;
            }

            const uint32_t dstStride = width * 2;
            for (uint32_t y = 0; y < height; ++y)
            {
                const uint8_t* srcRow = bgra + (static_cast<size_t>(y) * srcStride);
                uint8_t* dstRow = dst + (static_cast<size_t>(y) * dstStride);

                for (uint32_t x = 0; x < width; x += 2)
                {
                    const uint8_t* pixel0 = srcRow + (static_cast<size_t>(x) * 4);
                    const uint8_t* pixel1 = srcRow + (static_cast<size_t>(std::min(x + 1, width - 1)) * 4);

                    const uint8_t blue0 = pixel0[0];
                    const uint8_t green0 = pixel0[1];
                    const uint8_t red0 = pixel0[2];
                    const uint8_t blue1 = pixel1[0];
                    const uint8_t green1 = pixel1[1];
                    const uint8_t red1 = pixel1[2];

                    const uint8_t y0 = ToLuma(red0, green0, blue0);
                    const uint8_t y1 = ToLuma(red1, green1, blue1);
                    const uint8_t u0 = ToChromaU(red0, green0, blue0);
                    const uint8_t u1 = ToChromaU(red1, green1, blue1);
                    const uint8_t v0 = ToChromaV(red0, green0, blue0);
                    const uint8_t v1 = ToChromaV(red1, green1, blue1);

                    const size_t dstIndex = static_cast<size_t>(x) * 2;
                    dstRow[dstIndex + 0] = y0;
                    dstRow[dstIndex + 1] = static_cast<uint8_t>((static_cast<uint16_t>(u0) + static_cast<uint16_t>(u1)) / 2);
                    dstRow[dstIndex + 2] = y1;
                    dstRow[dstIndex + 3] = static_cast<uint8_t>((static_cast<uint16_t>(v0) + static_cast<uint16_t>(v1)) / 2);
                }
            }

            return true;
        }

        bool WriteBgraToRgb32Buffer(
            const uint8_t* bgra,
            uint32_t srcStride,
            uint8_t* dst,
            size_t destBytes,
            uint32_t width,
            uint32_t height) noexcept
        {
            if (bgra == nullptr || dst == nullptr || width == 0 || height == 0)
            {
                return false;
            }

            const size_t requiredBytes = Rgb32FrameBytes(width, height);
            if (destBytes < requiredBytes)
            {
                return false;
            }

            const size_t rowBytes = static_cast<size_t>(width) * 4;
            for (uint32_t y = 0; y < height; ++y)
            {
                const uint8_t* srcRow = bgra + (static_cast<size_t>(y) * srcStride);
                uint8_t* dstRow = dst + (static_cast<size_t>(y) * rowBytes);
                std::memcpy(dstRow, srcRow, rowBytes);
                for (uint32_t x = 0; x < width; ++x)
                {
                    dstRow[(static_cast<size_t>(x) * 4) + 3] = 0xff;
                }
            }

            return true;
        }

        void ApplyYuy2Heartbeat(uint8_t* yuy2Bytes, size_t byteCount, uint64_t frameIndex) noexcept
        {
            if (yuy2Bytes == nullptr || byteCount < 4)
            {
                return;
            }

            const uint8_t pulse = static_cast<uint8_t>(frameIndex & 0x01ULL);
            const size_t tailOffset = byteCount >= 8 ? byteCount - 8 : 0;

            yuy2Bytes[0] = static_cast<uint8_t>((yuy2Bytes[0] & 0xfeU) | pulse);
            yuy2Bytes[2] = static_cast<uint8_t>((yuy2Bytes[2] & 0xfeU) | static_cast<uint8_t>(pulse ^ 0x01U));
            yuy2Bytes[tailOffset + 0] = static_cast<uint8_t>((yuy2Bytes[tailOffset + 0] & 0xfeU) | pulse);
            yuy2Bytes[tailOffset + 2] = static_cast<uint8_t>((yuy2Bytes[tailOffset + 2] & 0xfeU) | static_cast<uint8_t>(pulse ^ 0x01U));
        }

        void ApplyNv12Heartbeat(uint8_t* nv12Bytes, size_t byteCount, uint32_t width, uint32_t height, uint64_t frameIndex) noexcept
        {
            if (nv12Bytes == nullptr || width == 0 || height == 0)
            {
                return;
            }

            const size_t yPlaneBytes = static_cast<size_t>(width) * height;
            if (byteCount < yPlaneBytes + 2)
            {
                return;
            }

            const uint8_t pulse = static_cast<uint8_t>(frameIndex & 0x01ULL);
            nv12Bytes[0] = static_cast<uint8_t>((nv12Bytes[0] & 0xfeU) | pulse);
            nv12Bytes[yPlaneBytes - 1] = static_cast<uint8_t>((nv12Bytes[yPlaneBytes - 1] & 0xfeU) | static_cast<uint8_t>(pulse ^ 0x01U));
        }

        void ApplyRgb32Heartbeat(uint8_t* rgb32Bytes, size_t byteCount, uint64_t frameIndex) noexcept
        {
            if (rgb32Bytes == nullptr || byteCount < 8)
            {
                return;
            }

            const uint8_t pulse = static_cast<uint8_t>(frameIndex & 0x01ULL);
            rgb32Bytes[0] = static_cast<uint8_t>((rgb32Bytes[0] & 0xfeU) | pulse);
            rgb32Bytes[4] = static_cast<uint8_t>((rgb32Bytes[4] & 0xfeU) | static_cast<uint8_t>(pulse ^ 0x01U));
        }

        class SharedFrameReader
        {
        public:
            SharedFrameReader() = default;

            ~SharedFrameReader()
            {
                Close();
            }

            void SetDefaultConfig(const MediaConfig& config)
            {
                std::lock_guard<std::mutex> guard(lock_);
                defaultConfig_ = config;
            }

            HRESULT GetConfig(MediaConfig* config)
            {
                if (config == nullptr)
                {
                    return E_POINTER;
                }

                std::lock_guard<std::mutex> guard(lock_);
                RETURN_IF_FAILED(EnsureOpenLocked());
                return ReadConfigLocked(config);
            }

            HRESULT ReadFrame(std::vector<uint8_t>* bgra, MediaConfig* config, int64_t* timestampHundredsOfNs, uint64_t* frameCounter)
            {
                if (bgra == nullptr || config == nullptr || timestampHundredsOfNs == nullptr || frameCounter == nullptr)
                {
                    return E_POINTER;
                }

                std::lock_guard<std::mutex> guard(lock_);
                RETURN_IF_FAILED(EnsureOpenLocked());

                if (usingFileBridge_)
                {
                    return ReadFrameFromFileBridgeLocked(bgra, config, timestampHundredsOfNs, frameCounter);
                }

                RETURN_IF_FAILED(WaitForOwnedMutex(mutex_));

                auto unlock = [&]() noexcept
                {
                    if (mutex_ != nullptr)
                    {
                        ReleaseMutex(mutex_);
                    }
                };

                auto* header = static_cast<const SharedFrameHeader*>(view_);
                if (header == nullptr || header->magic != kProtocolMagic || header->version != kProtocolVersion)
                {
                    unlock();
                    return HRESULT_FROM_WIN32(ERROR_INVALID_DATA);
                }

                if (header->frameCounter == 0 || header->payloadBytes == 0)
                {
                    *frameCounter = 0;
                    *timestampHundredsOfNs = 0;
                    unlock();
                    return S_FALSE;
                }

                config->width = header->width;
                config->height = header->height;
                config->stride = header->stride;
                config->fpsNumerator = header->fpsNumerator == 0 ? kDefaultFpsNumerator : header->fpsNumerator;
                config->fpsDenominator = header->fpsDenominator == 0 ? kDefaultFpsDenominator : header->fpsDenominator;

                const uint8_t* payload = reinterpret_cast<const uint8_t*>(header + 1);
                bgra->resize(header->payloadBytes);
                std::memcpy(bgra->data(), payload, header->payloadBytes);
                *timestampHundredsOfNs = header->timestampHundredsOfNs;
                *frameCounter = header->frameCounter;

                unlock();
                return S_OK;
            }

            void Close() noexcept
            {
                std::lock_guard<std::mutex> guard(lock_);
                CloseLocked();
            }

            void CloseLocked() noexcept
            {
                if (view_ != nullptr)
                {
                    UnmapViewOfFile(view_);
                    view_ = nullptr;
                }

                if (mapping_ != nullptr)
                {
                    CloseHandle(mapping_);
                    mapping_ = nullptr;
                }

                if (bridgeFile_ != nullptr && bridgeFile_ != INVALID_HANDLE_VALUE)
                {
                    CloseHandle(bridgeFile_);
                    bridgeFile_ = nullptr;
                }

                if (mutex_ != nullptr)
                {
                    CloseHandle(mutex_);
                    mutex_ = nullptr;
                }

                if (event_ != nullptr)
                {
                    CloseHandle(event_);
                    event_ = nullptr;
                }

                usingFileBridge_ = false;
                mappingByteCount_ = 0;
            }

        private:
            // EnsureOpenLocked must only be called while lock_ is held.
            HRESULT EnsureOpenLocked()
            {
                if (mapping_ != nullptr && mutex_ != nullptr && view_ != nullptr)
                {
                    return S_OK;
                }

                if (mapping_ != nullptr && usingFileBridge_ && view_ != nullptr)
                {
                    return S_OK;
                }

                HRESULT fileBridgeHr = EnsureOpenFileBridgeLocked();
                if (SUCCEEDED(fileBridgeHr))
                {
                    AppendMfVirtualCameraLogLine(L"Using file-backed Tech Lord Media camera bridge.");
                    return S_OK;
                }

                wchar_t fileBridgeFailureLine[256]{};
                if (SUCCEEDED(StringCchPrintfW(
                        fileBridgeFailureLine,
                        ARRAYSIZE(fileBridgeFailureLine),
                        L"File-backed bridge open failed with hr=0x%08X.",
                        static_cast<unsigned int>(fileBridgeHr))))
                {
                    AppendMfVirtualCameraLogLine(fileBridgeFailureLine);
                }

                TryEnableCreateGlobalPrivilege();

                HRESULT globalHr = EnsureOpenWithNamespace(
                    kGlobalPublisherMappingName,
                    kGlobalPublisherMutexName,
                    kGlobalPublisherEventName);
                if (SUCCEEDED(globalHr))
                {
                    AppendMfVirtualCameraLogLine(L"Using Global Tech Lord Media camera bridge.");
                    return S_OK;
                }

                wchar_t globalFailureLine[256]{};
                if (SUCCEEDED(StringCchPrintfW(
                        globalFailureLine,
                        ARRAYSIZE(globalFailureLine),
                        L"Global bridge open failed with hr=0x%08X. Falling back to Local bridge.",
                        static_cast<unsigned int>(globalHr))))
                {
                    AppendMfVirtualCameraLogLine(globalFailureLine);
                }

                // Close without re-acquiring lock_ (we already hold it).
                CloseLocked();

                RETURN_IF_FAILED(EnsureOpenWithNamespace(
                    kPublisherMappingName,
                    kPublisherMutexName,
                    kPublisherEventName));

                AppendMfVirtualCameraLogLine(L"Using Local Tech Lord Media camera bridge.");

                return S_OK;
            }

            HRESULT EnsureOpenFileBridgeLocked()
            {
                RETURN_IF_FAILED(EnsureBridgeDirectoryExists(kMfPublisherBridgeDirectoryPath));

                bridgeFile_ = CreateFileW(
                    kMfPublisherBridgeFilePath,
                    GENERIC_READ,
                    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                    nullptr,
                    OPEN_EXISTING,
                    FILE_ATTRIBUTE_NORMAL,
                    nullptr);
                if (bridgeFile_ == INVALID_HANDLE_VALUE)
                {
                    bridgeFile_ = nullptr;
                    return HRESULT_FROM_WIN32(GetLastError());
                }

                LARGE_INTEGER fileSize{};
                if (!GetFileSizeEx(bridgeFile_, &fileSize))
                {
                    const HRESULT sizeHr = HRESULT_FROM_WIN32(GetLastError());
                    CloseLocked();
                    return sizeHr;
                }

                if (fileSize.QuadPart < static_cast<LONGLONG>(sizeof(SharedFrameHeader)))
                {
                    CloseLocked();
                    return HRESULT_FROM_WIN32(ERROR_INVALID_DATA);
                }

                mappingByteCount_ = static_cast<size_t>(fileSize.QuadPart);
                mapping_ = CreateFileMappingW(bridgeFile_, nullptr, PAGE_READONLY, 0, 0, nullptr);
                if (mapping_ == nullptr)
                {
                    const HRESULT mappingHr = HRESULT_FROM_WIN32(GetLastError());
                    CloseLocked();
                    return mappingHr;
                }

                view_ = MapViewOfFile(mapping_, FILE_MAP_READ, 0, 0, 0);
                if (view_ == nullptr)
                {
                    const HRESULT viewHr = HRESULT_FROM_WIN32(GetLastError());
                    CloseLocked();
                    return viewHr;
                }

                const auto* header = static_cast<const SharedFrameHeader*>(view_);
                if (header == nullptr || header->magic != kProtocolMagic || header->version != kProtocolVersion)
                {
                    CloseLocked();
                    return HRESULT_FROM_WIN32(ERROR_INVALID_DATA);
                }

                usingFileBridge_ = true;
                return S_OK;
            }

            HRESULT EnsureOpenWithNamespace(
                const wchar_t* mappingName,
                const wchar_t* mutexName,
                const wchar_t* eventName)
            {
                SecurityDescriptorHolder securityDescriptor;
                SECURITY_ATTRIBUTES securityAttributes{};
                RETURN_IF_FAILED(BuildBridgeSecurityAttributes(&securityAttributes, &securityDescriptor));

                if (mutex_ == nullptr)
                {
                    mutex_ = CreateMutexW(&securityAttributes, FALSE, mutexName);
                    if (mutex_ == nullptr)
                    {
                        return HRESULT_FROM_WIN32(GetLastError());
                    }
                }

                bool createdMapping = false;
                if (mapping_ == nullptr)
                {
                    const uint32_t width = defaultConfig_.width == 0 ? kDefaultWidth : defaultConfig_.width;
                    const uint32_t height = defaultConfig_.height == 0 ? kDefaultHeight : defaultConfig_.height;
                    const uint32_t stride = defaultConfig_.stride == 0 ? (width * 4) : defaultConfig_.stride;
                    const size_t mappingByteCount = sizeof(SharedFrameHeader) + (static_cast<size_t>(stride) * height);

                    ULARGE_INTEGER mappingSize{};
                    mappingSize.QuadPart = static_cast<unsigned long long>(mappingByteCount);
                    mapping_ = CreateFileMappingW(
                        INVALID_HANDLE_VALUE,
                        &securityAttributes,
                        PAGE_READWRITE,
                        mappingSize.HighPart,
                        mappingSize.LowPart,
                        mappingName);
                    if (mapping_ == nullptr)
                    {
                        return HRESULT_FROM_WIN32(GetLastError());
                    }

                    createdMapping = GetLastError() != ERROR_ALREADY_EXISTS;
                }

                if (event_ == nullptr)
                {
                    event_ = CreateEventW(&securityAttributes, FALSE, FALSE, eventName);
                    if (event_ == nullptr)
                    {
                        return HRESULT_FROM_WIN32(GetLastError());
                    }
                }

                if (view_ == nullptr)
                {
                    view_ = MapViewOfFile(mapping_, FILE_MAP_READ | FILE_MAP_WRITE, 0, 0, 0);
                    if (view_ == nullptr)
                    {
                        return HRESULT_FROM_WIN32(GetLastError());
                    }
                }

                auto* header = static_cast<const SharedFrameHeader*>(view_);
                if (createdMapping
                    || header == nullptr
                    || header->magic != kProtocolMagic
                    || header->version != kProtocolVersion)
                {
                    RETURN_IF_FAILED(InitializeSharedState());
                }

                return S_OK;
            }

            HRESULT ReadConfigLocked(MediaConfig* config)
            {
                if (usingFileBridge_)
                {
                    return ReadConfigFromFileBridgeLocked(config);
                }

                RETURN_IF_FAILED(WaitForOwnedMutex(mutex_));

                auto unlock = [&]() noexcept
                {
                    if (mutex_ != nullptr)
                    {
                        ReleaseMutex(mutex_);
                    }
                };

                auto* header = static_cast<const SharedFrameHeader*>(view_);
                if (header == nullptr || header->magic != kProtocolMagic || header->version != kProtocolVersion)
                {
                    unlock();
                    return HRESULT_FROM_WIN32(ERROR_INVALID_DATA);
                }

                config->width = header->width == 0 ? kDefaultWidth : header->width;
                config->height = header->height == 0 ? kDefaultHeight : header->height;
                config->stride = header->stride == 0 ? (config->width * 4) : header->stride;
                config->fpsNumerator = header->fpsNumerator == 0 ? kDefaultFpsNumerator : header->fpsNumerator;
                config->fpsDenominator = header->fpsDenominator == 0 ? kDefaultFpsDenominator : header->fpsDenominator;
                unlock();
                return S_OK;
            }

            HRESULT ReadConfigFromFileBridgeLocked(MediaConfig* config)
            {
                if (config == nullptr)
                {
                    return E_POINTER;
                }

                const auto* header = static_cast<const SharedFrameHeader*>(view_);
                if (header == nullptr || header->magic != kProtocolMagic || header->version != kProtocolVersion)
                {
                    return HRESULT_FROM_WIN32(ERROR_INVALID_DATA);
                }

                config->width = header->width == 0 ? kDefaultWidth : header->width;
                config->height = header->height == 0 ? kDefaultHeight : header->height;
                config->stride = header->stride == 0 ? (config->width * 4) : header->stride;
                config->fpsNumerator = header->fpsNumerator == 0 ? kDefaultFpsNumerator : header->fpsNumerator;
                config->fpsDenominator = header->fpsDenominator == 0 ? kDefaultFpsDenominator : header->fpsDenominator;
                return S_OK;
            }

            HRESULT ReadFrameFromFileBridgeLocked(
                std::vector<uint8_t>* bgra,
                MediaConfig* config,
                int64_t* timestampHundredsOfNs,
                uint64_t* frameCounter)
            {
                const auto* header = static_cast<const SharedFrameHeader*>(view_);
                if (header == nullptr || header->magic != kProtocolMagic || header->version != kProtocolVersion)
                {
                    return HRESULT_FROM_WIN32(ERROR_INVALID_DATA);
                }

                for (int attempt = 0; attempt < 3; ++attempt)
                {
                    const LONG sequenceStart = static_cast<LONG>(header->reserved);
                    if ((sequenceStart & 0x1L) != 0)
                    {
                        continue;
                    }

                    MemoryBarrier();

                    const uint32_t payloadBytes = header->payloadBytes;
                    if (payloadBytes == 0 || header->frameCounter == 0)
                    {
                        *frameCounter = 0;
                        *timestampHundredsOfNs = 0;
                        return S_FALSE;
                    }

                    if (mappingByteCount_ < (sizeof(SharedFrameHeader) + static_cast<size_t>(payloadBytes)))
                    {
                        return HRESULT_FROM_WIN32(ERROR_INVALID_DATA);
                    }

                    config->width = header->width == 0 ? kDefaultWidth : header->width;
                    config->height = header->height == 0 ? kDefaultHeight : header->height;
                    config->stride = header->stride == 0 ? (config->width * 4) : header->stride;
                    config->fpsNumerator = header->fpsNumerator == 0 ? kDefaultFpsNumerator : header->fpsNumerator;
                    config->fpsDenominator = header->fpsDenominator == 0 ? kDefaultFpsDenominator : header->fpsDenominator;

                    const uint64_t snapshotFrameCounter = header->frameCounter;
                    const int64_t snapshotTimestamp = header->timestampHundredsOfNs;
                    const uint8_t* payload = reinterpret_cast<const uint8_t*>(header + 1);
                    bgra->resize(payloadBytes);
                    std::memcpy(bgra->data(), payload, payloadBytes);

                    MemoryBarrier();

                    const LONG sequenceEnd = static_cast<LONG>(header->reserved);
                    if (sequenceStart == sequenceEnd && (sequenceEnd & 0x1L) == 0)
                    {
                        *frameCounter = snapshotFrameCounter;
                        *timestampHundredsOfNs = snapshotTimestamp;
                        return S_OK;
                    }
                }

                return S_FALSE;
            }

            HRESULT InitializeSharedState()
            {
                RETURN_IF_FAILED(WaitForOwnedMutex(mutex_));

                auto unlock = [&]() noexcept
                {
                    if (mutex_ != nullptr)
                    {
                        ReleaseMutex(mutex_);
                    }
                };

                const uint32_t width = defaultConfig_.width == 0 ? kDefaultWidth : defaultConfig_.width;
                const uint32_t height = defaultConfig_.height == 0 ? kDefaultHeight : defaultConfig_.height;
                const uint32_t stride = defaultConfig_.stride == 0 ? (width * 4) : defaultConfig_.stride;
                const uint32_t fpsNumerator = defaultConfig_.fpsNumerator == 0 ? kDefaultFpsNumerator : defaultConfig_.fpsNumerator;
                const uint32_t fpsDenominator = defaultConfig_.fpsDenominator == 0 ? kDefaultFpsDenominator : defaultConfig_.fpsDenominator;

                auto* header = static_cast<SharedFrameHeader*>(view_);
                if (header == nullptr)
                {
                    unlock();
                    return HRESULT_FROM_WIN32(ERROR_INVALID_ADDRESS);
                }

                const size_t payloadBytes = static_cast<size_t>(stride) * height;
                std::memset(header, 0, sizeof(SharedFrameHeader) + payloadBytes);
                header->magic = kProtocolMagic;
                header->version = kProtocolVersion;
                header->width = width;
                header->height = height;
                header->stride = stride;
                header->pixelFormat = kPixelFormatBgra32;
                header->fpsNumerator = fpsNumerator;
                header->fpsDenominator = fpsDenominator;
                header->payloadBytes = static_cast<uint32_t>(payloadBytes);

                unlock();
                return S_OK;
            }

            std::mutex lock_;
            HANDLE mapping_ = nullptr;
            HANDLE bridgeFile_ = nullptr;
            HANDLE mutex_ = nullptr;
            HANDLE event_ = nullptr;
            void* view_ = nullptr;
            bool usingFileBridge_ = false;
            size_t mappingByteCount_ = 0;
            MediaConfig defaultConfig_{};
        };

        class SurevideotoolMediaSource;

        class SurevideotoolMediaStream final : public RuntimeClass<RuntimeClassFlags<Microsoft::WRL::ClassicCom>, IMFMediaStream2>
        {
        public:
            SurevideotoolMediaStream()
            {
                AddObjectRef();
            }

            ~SurevideotoolMediaStream() override
            {
                ReleaseObjectRef();
            }

            HRESULT Initialize(SurevideotoolMediaSource* parent, const MediaConfig& config);
            HRESULT Start(IMFMediaType* mediaType, bool sendEvents);
            HRESULT Stop(bool sendEvents);
            HRESULT ShutdownStream();
            bool IsSelected() const noexcept;
            DWORD StreamIdentifier() const noexcept;
            HRESULT CopyAttributes(IMFAttributes** attributes);

            IFACEMETHODIMP QueryInterface(REFIID interfaceId, void** object) override;
            IFACEMETHODIMP BeginGetEvent(IMFAsyncCallback* callback, IUnknown* state) override;
            IFACEMETHODIMP EndGetEvent(IMFAsyncResult* result, IMFMediaEvent** eventValue) override;
            IFACEMETHODIMP GetEvent(DWORD flags, IMFMediaEvent** eventValue) override;
            IFACEMETHODIMP QueueEvent(MediaEventType eventType, REFGUID extendedType, HRESULT status, const PROPVARIANT* value) override;
            IFACEMETHODIMP GetMediaSource(IMFMediaSource** mediaSource) override;
            IFACEMETHODIMP GetStreamDescriptor(IMFStreamDescriptor** streamDescriptor) override;
            IFACEMETHODIMP RequestSample(IUnknown* token) override;
            IFACEMETHODIMP SetStreamState(MF_STREAM_STATE value) override;
            IFACEMETHODIMP GetStreamState(MF_STREAM_STATE* value) override;

        private:
            HRESULT CreateNextSample(IMFMediaType* mediaType, IMFSample** sample);

            mutable std::mutex lock_;
            SurevideotoolMediaSource* parent_ = nullptr;
            ComPtr<IMFMediaEventQueue> eventQueue_;
            ComPtr<IMFAttributes> attributes_;
            ComPtr<IMFStreamDescriptor> streamDescriptor_;
            ComPtr<IMFMediaType> currentMediaType_;
            MediaConfig mediaConfig_{};
            SharedFrameReader frameReader_;
            std::vector<uint8_t> cachedBgraFrame_;
            MediaConfig cachedBgraConfig_{};
            bool isShutdown_ = false;
            bool isSelected_ = false;
            bool hasCachedFrame_ = false;
            MF_STREAM_STATE streamState_ = MF_STREAM_STATE_STOPPED;
            uint64_t sampleFrameIndex_ = 0;
            uint64_t syntheticFrameIndex_ = 0;
        };

        class SurevideotoolMediaSource final : public RuntimeClass<RuntimeClassFlags<Microsoft::WRL::ClassicCom>, IMFMediaSourceEx, IMFGetService, IKsControl, IMFSampleAllocatorControl>
        {
        public:
            SurevideotoolMediaSource()
            {
                AddObjectRef();
            }

            ~SurevideotoolMediaSource() override
            {
                ReleaseObjectRef();
            }

            HRESULT Initialize(IMFAttributes* activateAttributes = nullptr);

            IFACEMETHODIMP QueryInterface(REFIID interfaceId, void** object) override;
            IFACEMETHODIMP BeginGetEvent(IMFAsyncCallback* callback, IUnknown* state) override;
            IFACEMETHODIMP EndGetEvent(IMFAsyncResult* result, IMFMediaEvent** eventValue) override;
            IFACEMETHODIMP GetEvent(DWORD flags, IMFMediaEvent** eventValue) override;
            IFACEMETHODIMP QueueEvent(MediaEventType eventType, REFGUID extendedType, HRESULT status, const PROPVARIANT* value) override;
            IFACEMETHODIMP GetCharacteristics(DWORD* characteristics) override;
            IFACEMETHODIMP CreatePresentationDescriptor(IMFPresentationDescriptor** presentationDescriptor) override;
            IFACEMETHODIMP Start(IMFPresentationDescriptor* presentationDescriptor, const GUID* timeFormat, const PROPVARIANT* startPosition) override;
            IFACEMETHODIMP Stop() override;
            IFACEMETHODIMP Pause() override;
            IFACEMETHODIMP Shutdown() override;
            IFACEMETHODIMP GetSourceAttributes(IMFAttributes** attributes) override;
            IFACEMETHODIMP GetStreamAttributes(DWORD streamIdentifier, IMFAttributes** attributes) override;
            IFACEMETHODIMP SetD3DManager(IUnknown* manager) override;
            IFACEMETHODIMP GetService(REFGUID serviceGuid, REFIID interfaceId, void** object) override;
            IFACEMETHODIMP KsProperty(PKSPROPERTY property, ULONG propertyLength, void* propertyData, ULONG dataLength, ULONG* bytesReturned) override;
            IFACEMETHODIMP KsMethod(PKSMETHOD method, ULONG methodLength, void* methodData, ULONG dataLength, ULONG* bytesReturned) override;
            IFACEMETHODIMP KsEvent(PKSEVENT eventValue, ULONG eventLength, void* eventData, ULONG dataLength, ULONG* bytesReturned) override;
            IFACEMETHODIMP SetDefaultAllocator(DWORD outputStreamId, IUnknown* allocator) override;
            IFACEMETHODIMP GetAllocatorUsage(DWORD outputStreamId, DWORD* inputStreamId, MFSampleAllocatorUsage* usage) override;

        private:
            mutable std::mutex lock_;
            bool initialized_ = false;
            SourceState state_ = SourceState::Invalid;
            MediaConfig mediaConfig_{};
            ComPtr<IMFMediaEventQueue> eventQueue_;
            ComPtr<IMFAttributes> sourceAttributes_;
            ComPtr<IMFPresentationDescriptor> presentationDescriptor_;
            ComPtr<SurevideotoolMediaStream> stream_;

            HRESULT CreateSourceAttributes(IMFAttributes* activateAttributes);
        };

        class SurevideotoolMediaSourceActivate final : public RuntimeClass<RuntimeClassFlags<Microsoft::WRL::ClassicCom>, IMFActivate>
        {
        public:
            SurevideotoolMediaSourceActivate()
            {
                AddObjectRef();
            }

            ~SurevideotoolMediaSourceActivate() override
            {
                ReleaseObjectRef();
            }

            HRESULT Initialize()
            {
                AppendMfVirtualCameraLogLine(L"[Activate::Initialize] called.");
                RETURN_IF_FAILED(MFCreateAttributes(&attributes_, 1));
                return S_OK;
            }

            IFACEMETHODIMP QueryInterface(REFIID interfaceId, void** object) override;

            IFACEMETHODIMP ActivateObject(REFIID interfaceId, void** object) override;
            IFACEMETHODIMP ShutdownObject() override;
            IFACEMETHODIMP DetachObject() override;

            IFACEMETHODIMP GetItem(REFGUID key, PROPVARIANT* value) override;
            IFACEMETHODIMP GetItemType(REFGUID key, MF_ATTRIBUTE_TYPE* type) override;
            IFACEMETHODIMP CompareItem(REFGUID key, REFPROPVARIANT value, BOOL* result) override;
            IFACEMETHODIMP Compare(IMFAttributes* theirs, MF_ATTRIBUTES_MATCH_TYPE matchType, BOOL* result) override;
            IFACEMETHODIMP GetUINT32(REFGUID key, UINT32* value) override;
            IFACEMETHODIMP GetUINT64(REFGUID key, UINT64* value) override;
            IFACEMETHODIMP GetDouble(REFGUID key, double* value) override;
            IFACEMETHODIMP GetGUID(REFGUID key, GUID* value) override;
            IFACEMETHODIMP GetStringLength(REFGUID key, UINT32* length) override;
            IFACEMETHODIMP GetString(REFGUID key, LPWSTR value, UINT32 valueSize, UINT32* length) override;
            IFACEMETHODIMP GetAllocatedString(REFGUID key, LPWSTR* value, UINT32* length) override;
            IFACEMETHODIMP GetBlobSize(REFGUID key, UINT32* size) override;
            IFACEMETHODIMP GetBlob(REFGUID key, UINT8* buffer, UINT32 bufferSize, UINT32* size) override;
            IFACEMETHODIMP GetAllocatedBlob(REFGUID key, UINT8** buffer, UINT32* size) override;
            IFACEMETHODIMP GetUnknown(REFGUID key, REFIID interfaceId, void** object) override;
            IFACEMETHODIMP SetItem(REFGUID key, REFPROPVARIANT value) override;
            IFACEMETHODIMP DeleteItem(REFGUID key) override;
            IFACEMETHODIMP DeleteAllItems() override;
            IFACEMETHODIMP SetUINT32(REFGUID key, UINT32 value) override;
            IFACEMETHODIMP SetUINT64(REFGUID key, UINT64 value) override;
            IFACEMETHODIMP SetDouble(REFGUID key, double value) override;
            IFACEMETHODIMP SetGUID(REFGUID key, REFGUID value) override;
            IFACEMETHODIMP SetString(REFGUID key, LPCWSTR value) override;
            IFACEMETHODIMP SetBlob(REFGUID key, const UINT8* buffer, UINT32 bufferSize) override;
            IFACEMETHODIMP SetUnknown(REFGUID key, IUnknown* value) override;
            IFACEMETHODIMP LockStore() override;
            IFACEMETHODIMP UnlockStore() override;
            IFACEMETHODIMP GetCount(UINT32* items) override;
            IFACEMETHODIMP GetItemByIndex(UINT32 index, GUID* key, PROPVARIANT* value) override;
            IFACEMETHODIMP CopyAllItems(IMFAttributes* destination) override;

        private:
            ComPtr<IMFAttributes> attributes_;
            ComPtr<SurevideotoolMediaSource> activeSource_;
        };

        class SurevideotoolClassFactory final : public RuntimeClass<RuntimeClassFlags<Microsoft::WRL::ClassicCom>, IClassFactory>
        {
        public:
            SurevideotoolClassFactory()
            {
                AddObjectRef();
            }

            ~SurevideotoolClassFactory() override
            {
                ReleaseObjectRef();
            }

            IFACEMETHODIMP CreateInstance(IUnknown* outer, REFIID interfaceId, void** object) override
            {
                AppendMfVirtualCameraLogLine(L"[ClassFactory::CreateInstance] called.");

                if (object == nullptr)
                {
                    return E_POINTER;
                }

                *object = nullptr;

                if (outer != nullptr)
                {
                    return CLASS_E_NOAGGREGATION;
                }

                auto activate = Make<SurevideotoolMediaSourceActivate>();
                if (!activate)
                {
                    return E_OUTOFMEMORY;
                }

                RETURN_IF_FAILED(activate->Initialize());
                return activate.CopyTo(interfaceId, object);
            }

            IFACEMETHODIMP LockServer(BOOL lock) override
            {
                if (lock)
                {
                    ++g_lockCount;
                }
                else
                {
                    --g_lockCount;
                }

                return S_OK;
            }
        };

        HRESULT SurevideotoolMediaStream::Initialize(SurevideotoolMediaSource* parent, const MediaConfig& config)
        {
            if (parent == nullptr)
            {
                return E_INVALIDARG;
            }

            std::lock_guard<std::mutex> guard(lock_);

            parent_ = parent;
            // Offer RGB32, NV12, and YUY2. Some WebRTC clients reject cameras that
            // don't expose RGB32 during capability negotiation.
            mediaConfig_ = config;
            mediaConfig_.width = kDefaultWidth;
            mediaConfig_.height = kDefaultHeight;
            mediaConfig_.stride = kDefaultStride;
            mediaConfig_.fpsNumerator = kDefaultFpsNumerator;
            mediaConfig_.fpsDenominator = kDefaultFpsDenominator;
            frameReader_.SetDefaultConfig(mediaConfig_);

            RETURN_IF_FAILED(MFCreateEventQueue(&eventQueue_));
            RETURN_IF_FAILED(MFCreateAttributes(&attributes_, 4));
            RETURN_IF_FAILED(attributes_->SetGUID(MF_DEVICESTREAM_STREAM_CATEGORY, PINNAME_VIDEO_CAPTURE));
            RETURN_IF_FAILED(attributes_->SetUINT32(MF_DEVICESTREAM_STREAM_ID, kStreamId));
            RETURN_IF_FAILED(attributes_->SetUINT32(MF_DEVICESTREAM_FRAMESERVER_SHARED, 1));
            RETURN_IF_FAILED(attributes_->SetUINT32(MF_DEVICESTREAM_ATTRIBUTE_FRAMESOURCE_TYPES, static_cast<UINT32>(MFFrameSourceTypes::MFFrameSourceTypes_Color)));

            ComPtr<IMFMediaType> rgb32MediaType;
            RETURN_IF_FAILED(CreateVideoType(MFVideoFormat_RGB32, mediaConfig_, &rgb32MediaType));
            ComPtr<IMFMediaType> nv12MediaType;
            RETURN_IF_FAILED(CreateVideoType(MFVideoFormat_NV12, mediaConfig_, &nv12MediaType));
            ComPtr<IMFMediaType> yuy2MediaType;
            RETURN_IF_FAILED(CreateVideoType(MFVideoFormat_YUY2, mediaConfig_, &yuy2MediaType));
            IMFMediaType* mediaTypePointers[] = { rgb32MediaType.Get(), nv12MediaType.Get(), yuy2MediaType.Get() };
            RETURN_IF_FAILED(MFCreateStreamDescriptor(kStreamId, ARRAYSIZE(mediaTypePointers), mediaTypePointers, &streamDescriptor_));
            RETURN_IF_FAILED(attributes_->CopyAllItems(streamDescriptor_.Get()));

            ComPtr<IMFMediaTypeHandler> handler;
            RETURN_IF_FAILED(streamDescriptor_->GetMediaTypeHandler(&handler));
            RETURN_IF_FAILED(handler->SetCurrentMediaType(rgb32MediaType.Get()));
            currentMediaType_ = rgb32MediaType;

            streamState_ = MF_STREAM_STATE_STOPPED;
            isSelected_ = false;

            return S_OK;
        }

        IFACEMETHODIMP SurevideotoolMediaStream::QueryInterface(REFIID interfaceId, void** object)
        {
            if (object == nullptr)
            {
                return E_POINTER;
            }

            *object = nullptr;

            if (interfaceId == __uuidof(IUnknown) ||
                interfaceId == __uuidof(IMFMediaEventGenerator) ||
                interfaceId == __uuidof(IMFMediaStream))
            {
                *object = static_cast<IMFMediaStream*>(static_cast<IMFMediaStream2*>(this));
            }
            else if (interfaceId == __uuidof(IMFMediaStream2))
            {
                *object = static_cast<IMFMediaStream2*>(this);
            }
            else
            {
                return E_NOINTERFACE;
            }

            AddRef();
            return S_OK;
        }

        HRESULT SurevideotoolMediaStream::Start(IMFMediaType* mediaType, bool sendEvents)
        {
            std::lock_guard<std::mutex> guard(lock_);

            if (isShutdown_)
            {
                return MF_E_SHUTDOWN;
            }

            if (mediaType == nullptr)
            {
                return E_INVALIDARG;
            }

            // Accept the formats we advertise in the stream descriptor.
            GUID requestedSubtype = GUID_NULL;
            if (FAILED(mediaType->GetGUID(MF_MT_SUBTYPE, &requestedSubtype))
                || (requestedSubtype != MFVideoFormat_YUY2 && requestedSubtype != MFVideoFormat_NV12 && requestedSubtype != MFVideoFormat_RGB32))
            {
                return MF_E_INVALIDMEDIATYPE;
            }

            ComPtr<IMFMediaTypeHandler> handler;
            RETURN_IF_FAILED(streamDescriptor_->GetMediaTypeHandler(&handler));
            RETURN_IF_FAILED(handler->SetCurrentMediaType(mediaType));
            currentMediaType_ = mediaType;
            streamState_ = MF_STREAM_STATE_RUNNING;
            isSelected_ = true;
            sampleFrameIndex_ = 0;
            syntheticFrameIndex_ = 0;
            cachedBgraFrame_.clear();
            cachedBgraConfig_ = {};
            hasCachedFrame_ = false;

            if (sendEvents)
            {
                RETURN_IF_FAILED(eventQueue_->QueueEventParamVar(MEStreamStarted, GUID_NULL, S_OK, nullptr));
            }

            return S_OK;
        }

        HRESULT SurevideotoolMediaStream::Stop(bool sendEvents)
        {
            std::lock_guard<std::mutex> guard(lock_);

            if (isShutdown_)
            {
                return MF_E_SHUTDOWN;
            }

            isSelected_ = false;
            streamState_ = MF_STREAM_STATE_STOPPED;

            if (sendEvents)
            {
                RETURN_IF_FAILED(eventQueue_->QueueEventParamVar(MEStreamStopped, GUID_NULL, S_OK, nullptr));
            }

            return S_OK;
        }

        HRESULT SurevideotoolMediaStream::ShutdownStream()
        {
            std::lock_guard<std::mutex> guard(lock_);

            if (isShutdown_)
            {
                return S_OK;
            }

            isShutdown_ = true;
            if (eventQueue_)
            {
                eventQueue_->Shutdown();
                eventQueue_.Reset();
            }
            attributes_.Reset();
            currentMediaType_.Reset();
            streamDescriptor_.Reset();
            frameReader_.Close();
            parent_ = nullptr;
            return S_OK;
        }

        bool SurevideotoolMediaStream::IsSelected() const noexcept
        {
            std::lock_guard<std::mutex> guard(lock_);
            return isSelected_;
        }

        DWORD SurevideotoolMediaStream::StreamIdentifier() const noexcept
        {
            return kStreamId;
        }

        HRESULT SurevideotoolMediaStream::CopyAttributes(IMFAttributes** attributes)
        {
            if (attributes == nullptr)
            {
                return E_POINTER;
            }

            *attributes = nullptr;

            return attributes_.CopyTo(attributes);
        }

        IFACEMETHODIMP SurevideotoolMediaStream::BeginGetEvent(IMFAsyncCallback* callback, IUnknown* state)
        {
            std::lock_guard<std::mutex> guard(lock_);
            if (isShutdown_)
            {
                return MF_E_SHUTDOWN;
            }

            return eventQueue_->BeginGetEvent(callback, state);
        }

        IFACEMETHODIMP SurevideotoolMediaStream::EndGetEvent(IMFAsyncResult* result, IMFMediaEvent** eventValue)
        {
            std::lock_guard<std::mutex> guard(lock_);
            if (isShutdown_)
            {
                return MF_E_SHUTDOWN;
            }

            return eventQueue_->EndGetEvent(result, eventValue);
        }

        IFACEMETHODIMP SurevideotoolMediaStream::GetEvent(DWORD flags, IMFMediaEvent** eventValue)
        {
            ComPtr<IMFMediaEventQueue> eventQueue;
            {
                std::lock_guard<std::mutex> guard(lock_);
                if (isShutdown_)
                {
                    return MF_E_SHUTDOWN;
                }

                eventQueue = eventQueue_;
            }

            return eventQueue ? eventQueue->GetEvent(flags, eventValue) : MF_E_SHUTDOWN;
        }

        IFACEMETHODIMP SurevideotoolMediaStream::QueueEvent(MediaEventType eventType, REFGUID extendedType, HRESULT status, const PROPVARIANT* value)
        {
            std::lock_guard<std::mutex> guard(lock_);
            if (isShutdown_)
            {
                return MF_E_SHUTDOWN;
            }

            return eventQueue_->QueueEventParamVar(eventType, extendedType, status, value);
        }

        IFACEMETHODIMP SurevideotoolMediaStream::GetMediaSource(IMFMediaSource** mediaSource)
        {
            if (mediaSource == nullptr)
            {
                return E_POINTER;
            }

            *mediaSource = nullptr;

            std::lock_guard<std::mutex> guard(lock_);
            if (isShutdown_)
            {
                return MF_E_SHUTDOWN;
            }

            return parent_->QueryInterface(IID_PPV_ARGS(mediaSource));
        }

        IFACEMETHODIMP SurevideotoolMediaStream::GetStreamDescriptor(IMFStreamDescriptor** streamDescriptor)
        {
            if (streamDescriptor == nullptr)
            {
                return E_POINTER;
            }

            *streamDescriptor = nullptr;

            std::lock_guard<std::mutex> guard(lock_);
            if (isShutdown_)
            {
                return MF_E_SHUTDOWN;
            }

            return streamDescriptor_.CopyTo(streamDescriptor);
        }

        IFACEMETHODIMP SurevideotoolMediaStream::RequestSample(IUnknown* token)
        {
            AppendMfVirtualCameraLogLine(L"[Stream::RequestSample] called.");
            ComPtr<IMFMediaEventQueue> eventQueue;
            ComPtr<IMFMediaType> mediaType;

            {
                std::lock_guard<std::mutex> guard(lock_);
                if (isShutdown_)
                {
                    return MF_E_SHUTDOWN;
                }

                if (!isSelected_ || streamState_ != MF_STREAM_STATE_RUNNING)
                {
                    return MF_E_INVALIDREQUEST;
                }

                eventQueue = eventQueue_;
                mediaType = currentMediaType_;
            }

            ComPtr<IMFSample> sample;
            HRESULT createHr = CreateNextSample(mediaType.Get(), &sample);
            if (FAILED(createHr) || sample == nullptr)
            {
                // Never propagate per-sample failures — the FrameServer will tear down
                // the entire source. Log and skip; the next RequestSample will retry.
                wchar_t logLine[160]{};
                if (SUCCEEDED(StringCchPrintfW(
                        logLine,
                        ARRAYSIZE(logLine),
                        L"[Stream::RequestSample] CreateNextSample failed hr=0x%08X — skipping (will retry).",
                        static_cast<unsigned int>(createHr))))
                {
                    AppendMfVirtualCameraLogLine(logLine);
                }
                return S_OK;
            }

            if (token != nullptr)
            {
                if (FAILED(sample->SetUnknown(MFSampleExtension_Token, token)))
                {
                    AppendMfVirtualCameraLogLine(L"[Stream::RequestSample] SetUnknown(token) failed — continuing.");
                }
            }

            HRESULT queueHr = eventQueue->QueueEventParamUnk(MEMediaSample, GUID_NULL, S_OK, sample.Get());
            if (FAILED(queueHr))
            {
                wchar_t logLine[160]{};
                if (SUCCEEDED(StringCchPrintfW(
                        logLine,
                        ARRAYSIZE(logLine),
                        L"[Stream::RequestSample] QueueEvent failed hr=0x%08X.",
                        static_cast<unsigned int>(queueHr))))
                {
                    AppendMfVirtualCameraLogLine(logLine);
                }
            }
            return S_OK;
        }

        IFACEMETHODIMP SurevideotoolMediaStream::SetStreamState(MF_STREAM_STATE value)
        {
            std::lock_guard<std::mutex> guard(lock_);
            if (isShutdown_)
            {
                return MF_E_SHUTDOWN;
            }

            streamState_ = value;
            isSelected_ = value == MF_STREAM_STATE_RUNNING;
            return S_OK;
        }

        IFACEMETHODIMP SurevideotoolMediaStream::GetStreamState(MF_STREAM_STATE* value)
        {
            if (value == nullptr)
            {
                return E_POINTER;
            }

            std::lock_guard<std::mutex> guard(lock_);
            if (isShutdown_)
            {
                return MF_E_SHUTDOWN;
            }

            *value = streamState_;
            return S_OK;
        }

        HRESULT SurevideotoolMediaStream::CreateNextSample(IMFMediaType* mediaType, IMFSample** sample)
        {
            if (sample == nullptr || mediaType == nullptr)
            {
                return E_POINTER;
            }

            *sample = nullptr;

            // Verify the negotiated subtype matches one of the formats we advertise.
            GUID subtype = GUID_NULL;
            RETURN_IF_FAILED(mediaType->GetGUID(MF_MT_SUBTYPE, &subtype));
            if (subtype != MFVideoFormat_YUY2 && subtype != MFVideoFormat_NV12 && subtype != MFVideoFormat_RGB32)
            {
                return MF_E_INVALIDMEDIATYPE;
            }

            MediaConfig currentConfig = mediaConfig_;
            uint32_t width = currentConfig.width;
            uint32_t height = currentConfig.height;
            uint32_t fpsNum = currentConfig.fpsNumerator;
            uint32_t fpsDen = currentConfig.fpsDenominator;

            if (FAILED(MFGetAttributeSize(mediaType, MF_MT_FRAME_SIZE, &width, &height))
                || width == 0 || height == 0)
            {
                width = currentConfig.width;
                height = currentConfig.height;
            }
            if (FAILED(MFGetAttributeRatio(mediaType, MF_MT_FRAME_RATE, &fpsNum, &fpsDen))
                || fpsNum == 0 || fpsDen == 0)
            {
                fpsNum = kDefaultFpsNumerator;
                fpsDen = kDefaultFpsDenominator;
            }

            // Round width/height to even numbers — required for YUY2 packing and
            // NV12 4:2:0 chroma.
            width &= ~1u;
            height &= ~1u;
            if (width == 0 || height == 0)
            {
                return MF_E_INVALIDMEDIATYPE;
            }

            const size_t outputBytes = subtype == MFVideoFormat_YUY2
                ? Yuy2FrameBytes(width, height)
                : (subtype == MFVideoFormat_NV12 ? Nv12FrameBytes(width, height) : Rgb32FrameBytes(width, height));
            const DWORD outputBytesDword = static_cast<DWORD>(outputBytes);

            // 1) Allocate the exact-size output buffer up-front so we can guarantee a
            //    valid frame even if the bridge read fails.
            ComPtr<IMFMediaBuffer> buffer;
            RETURN_IF_FAILED(MFCreateMemoryBuffer(outputBytesDword, &buffer));

            BYTE* destination = nullptr;
            DWORD maxLength = 0;
            RETURN_IF_FAILED(buffer->Lock(&destination, &maxLength, nullptr));

            if (destination == nullptr || maxLength < outputBytesDword)
            {
                buffer->Unlock();
                return E_UNEXPECTED;
            }

            // 2) Pre-fill with limited-range black. Worst case (no publisher, slow
            //    publisher, mismatched dims) the consumer still gets a valid frame on
            //    time — far better than the source being torn down with a timeout.
            if (subtype == MFVideoFormat_YUY2)
            {
                FillBlackYuy2(destination, width, height);
            }
            else if (subtype == MFVideoFormat_NV12)
            {
                FillBlackNv12(destination, width, height);
            }
            else
            {
                FillBlackRgb32(destination, width, height);
            }

            // 3) Try a single non-blocking read from the publisher's shared frame
            //    bridge. ReadFrame uses a 50 ms mutex timeout so it never stalls the
            //    FrameServer thread.
            std::vector<uint8_t> bgra;
            MediaConfig sharedConfig{};
            int64_t timestampHundredsOfNs = 0;
            uint64_t frameCounter = 0;
            const HRESULT readHr = frameReader_.ReadFrame(&bgra, &sharedConfig, &timestampHundredsOfNs, &frameCounter);
            const bool hasFreshBridgeFrame =
                SUCCEEDED(readHr)
                && readHr != S_FALSE
                && sharedConfig.width == width
                && sharedConfig.height == height
                && sharedConfig.stride >= (width * 4)
                && bgra.size() >= static_cast<size_t>(sharedConfig.stride) * sharedConfig.height;

            auto writeBgraFrame = [&](const uint8_t* frameData, const MediaConfig& frameConfig) -> bool
            {
                if (frameData == nullptr
                    || frameConfig.width != width
                    || frameConfig.height != height
                    || frameConfig.stride < (width * 4))
                {
                    return false;
                }

                return subtype == MFVideoFormat_YUY2
                    ? WriteBgraToYuy2Buffer(
                        frameData,
                        frameConfig.stride,
                        destination,
                        static_cast<size_t>(maxLength),
                        width,
                        height)
                    : (subtype == MFVideoFormat_NV12
                        ? WriteBgraToNv12Buffer(
                            frameData,
                            frameConfig.stride,
                            destination,
                            static_cast<size_t>(maxLength),
                            width,
                            height)
                        : WriteBgraToRgb32Buffer(
                            frameData,
                            frameConfig.stride,
                            destination,
                            static_cast<size_t>(maxLength),
                            width,
                            height));
            };

            bool wroteBridgeFrame = false;
            bool wroteCachedFrame = false;
            if (hasFreshBridgeFrame)
            {
                cachedBgraFrame_ = std::move(bgra);
                cachedBgraConfig_ = sharedConfig;
                hasCachedFrame_ = true;
                wroteBridgeFrame = writeBgraFrame(cachedBgraFrame_.data(), cachedBgraConfig_);
            }

            bool wroteOutputFrame = wroteBridgeFrame;
            if (!wroteOutputFrame && hasCachedFrame_)
            {
                wroteCachedFrame = writeBgraFrame(cachedBgraFrame_.data(), cachedBgraConfig_);
                wroteOutputFrame = wroteCachedFrame;
            }

            bool wroteFallbackFrame = false;
            if (!wroteOutputFrame)
            {
                MediaConfig fallbackConfig = currentConfig;
                fallbackConfig.width = width;
                fallbackConfig.height = height;
                fallbackConfig.stride = width * 4;

                std::vector<uint8_t> fallbackBgra;
                FillSyntheticBgra(fallbackConfig, sampleFrameIndex_, &fallbackBgra);
                wroteFallbackFrame = writeBgraFrame(fallbackBgra.data(), fallbackConfig);
                wroteOutputFrame = wroteFallbackFrame;
            }

            // 4) Per-frame heartbeat for diagnostics (single byte tweak; overwrites a
            //    couple of luma samples).
            if (subtype == MFVideoFormat_YUY2)
            {
                ApplyYuy2Heartbeat(destination, outputBytes, sampleFrameIndex_);
            }
            else if (subtype == MFVideoFormat_NV12)
            {
                ApplyNv12Heartbeat(destination, outputBytes, width, height, sampleFrameIndex_);
            }
            else
            {
                ApplyRgb32Heartbeat(destination, outputBytes, sampleFrameIndex_);
            }

            // 5) Throttled diagnostic log (every 90 frames or when state changes).
            if ((sampleFrameIndex_ % 90) == 0 || FAILED(readHr) || !hasFreshBridgeFrame || !wroteOutputFrame)
            {
                wchar_t logLine[640]{};
                if (SUCCEEDED(StringCchPrintfW(
                        logLine,
                        ARRAYSIZE(logLine),
                        L"CreateNextSample hr=0x%08X fresh=%u bridge=%u cached=%u fallback=%u output=%u frameCounter=%llu sampleIndex=%llu shared=%ux%u stride=%u bgraBytes=%zu out=%zu",
                        static_cast<unsigned int>(readHr),
                        hasFreshBridgeFrame ? 1u : 0u,
                        wroteBridgeFrame ? 1u : 0u,
                        wroteCachedFrame ? 1u : 0u,
                        wroteFallbackFrame ? 1u : 0u,
                        wroteOutputFrame ? 1u : 0u,
                        static_cast<unsigned long long>(frameCounter),
                        static_cast<unsigned long long>(sampleFrameIndex_),
                        sharedConfig.width,
                        sharedConfig.height,
                        sharedConfig.stride,
                        bgra.size(),
                        outputBytes)))
                {
                    AppendMfVirtualCameraLogLine(logLine);
                }
            }

            RETURN_IF_FAILED(buffer->SetCurrentLength(outputBytesDword));
            RETURN_IF_FAILED(buffer->Unlock());

            ComPtr<IMFSample> value;
            RETURN_IF_FAILED(MFCreateSample(&value));
            RETURN_IF_FAILED(value->AddBuffer(buffer.Get()));

            // 6) FrameServer's virtual-camera path expects device-clock sample times.
            //    Microsoft's SimpleMediaSource sample uses MFGetSystemTime() here; a
            //    zero-based stream time works for direct readers but can leave the
            //    FrameServer pipeline requesting frames forever without completing
            //    activation.
            const LONGLONG duration = (kHundredsOfNsPerSecond * fpsDen) / fpsNum;
            const LONGLONG sampleTime = MFGetSystemTime();
            ++sampleFrameIndex_;

            RETURN_IF_FAILED(value->SetSampleTime(sampleTime));
            RETURN_IF_FAILED(value->SetSampleDuration(duration));

            // FrameServer also reads a device timestamp for clock alignment; pass the
            // same monotonic value (units are 100-ns).
            RETURN_IF_FAILED(value->SetUINT64(MFSampleExtension_DeviceTimestamp,
                static_cast<UINT64>(sampleTime)));

            // Every raw NV12 frame is a clean point — without this the FrameServer
            // pipeline waits forever for a "keyframe".
            RETURN_IF_FAILED(value->SetUINT32(MFSampleExtension_CleanPoint, TRUE));

            *sample = value.Detach();
            return S_OK;
        }

        HRESULT SurevideotoolMediaSource::Initialize(IMFAttributes* activateAttributes)
        {
            std::lock_guard<std::mutex> guard(lock_);

            AppendMfVirtualCameraLogLine(L"[Source::Initialize] called.");

            if (initialized_)
            {
                AppendMfVirtualCameraLogLine(L"[Source::Initialize] already initialized.");
                return MF_E_ALREADY_INITIALIZED;
            }

            SharedFrameReader reader;
            MediaConfig detected{};
            if (SUCCEEDED(reader.GetConfig(&detected)))
            {
                mediaConfig_ = detected;
            }

            HRESULT hr = MFCreateEventQueue(&eventQueue_);
            if (FAILED(hr))
            {
                wchar_t message[160]{};
                if (SUCCEEDED(StringCchPrintfW(message, ARRAYSIZE(message),
                    L"[Source::Initialize] MFCreateEventQueue failed hr=0x%08X.", hr)))
                {
                    AppendMfVirtualCameraLogLine(message);
                }

                return hr;
            }

            hr = CreateSourceAttributes(activateAttributes);
            if (FAILED(hr))
            {
                wchar_t message[160]{};
                if (SUCCEEDED(StringCchPrintfW(message, ARRAYSIZE(message),
                    L"[Source::Initialize] CreateSourceAttributes failed hr=0x%08X.", hr)))
                {
                    AppendMfVirtualCameraLogLine(message);
                }

                return hr;
            }

            stream_ = Make<SurevideotoolMediaStream>();
            if (!stream_)
            {
                AppendMfVirtualCameraLogLine(L"[Source::Initialize] stream allocation failed.");
                return E_OUTOFMEMORY;
            }

            hr = stream_->Initialize(this, mediaConfig_);
            if (FAILED(hr))
            {
                wchar_t message[160]{};
                if (SUCCEEDED(StringCchPrintfW(message, ARRAYSIZE(message),
                    L"[Source::Initialize] stream initialization failed hr=0x%08X.", hr)))
                {
                    AppendMfVirtualCameraLogLine(message);
                }

                return hr;
            }

            ComPtr<IMFStreamDescriptor> streamDescriptor;
            hr = stream_->GetStreamDescriptor(&streamDescriptor);
            if (FAILED(hr))
            {
                wchar_t message[160]{};
                if (SUCCEEDED(StringCchPrintfW(message, ARRAYSIZE(message),
                    L"[Source::Initialize] GetStreamDescriptor failed hr=0x%08X.", hr)))
                {
                    AppendMfVirtualCameraLogLine(message);
                }

                return hr;
            }

            IMFStreamDescriptor* descriptors[] = { streamDescriptor.Get() };
            hr = MFCreatePresentationDescriptor(ARRAYSIZE(descriptors), descriptors, &presentationDescriptor_);
            if (FAILED(hr))
            {
                wchar_t message[160]{};
                if (SUCCEEDED(StringCchPrintfW(message, ARRAYSIZE(message),
                    L"[Source::Initialize] MFCreatePresentationDescriptor failed hr=0x%08X.", hr)))
                {
                    AppendMfVirtualCameraLogLine(message);
                }

                return hr;
            }

            hr = presentationDescriptor_->SelectStream(0);
            if (FAILED(hr))
            {
                wchar_t message[160]{};
                if (SUCCEEDED(StringCchPrintfW(message, ARRAYSIZE(message),
                    L"[Source::Initialize] SelectStream failed hr=0x%08X.", hr)))
                {
                    AppendMfVirtualCameraLogLine(message);
                }

                return hr;
            }

            state_ = SourceState::Stopped;
            initialized_ = true;
            AppendMfVirtualCameraLogLine(L"[Source::Initialize] completed.");
            return S_OK;
        }

        HRESULT SurevideotoolMediaSource::CreateSourceAttributes(IMFAttributes* activateAttributes)
        {
            RETURN_IF_FAILED(MFCreateAttributes(&sourceAttributes_, 4));
            if (activateAttributes != nullptr)
            {
                RETURN_IF_FAILED(activateAttributes->CopyAllItems(sourceAttributes_.Get()));
            }

            RETURN_IF_FAILED(sourceAttributes_->SetGUID(MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE, MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_GUID));
            RETURN_IF_FAILED(sourceAttributes_->SetGUID(MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_CATEGORY, KSCATEGORY_VIDEO_CAMERA));
            RETURN_IF_FAILED(sourceAttributes_->SetString(MF_DEVSOURCE_ATTRIBUTE_FRIENDLY_NAME, kVirtualCameraFriendlyName));

            ComPtr<IMFSensorProfileCollection> profileCollection;
            ComPtr<IMFSensorProfile> profile;

            HRESULT profileHr = MFCreateSensorProfileCollection(&profileCollection);
            if (SUCCEEDED(profileHr))
            {
                profileHr = MFCreateSensorProfile(KSCAMERAPROFILE_Legacy, 0, nullptr, &profile);
            }

            if (SUCCEEDED(profileHr))
            {
                profileHr = profile->AddProfileFilter(kStreamId, L"((RES==;FRT<=30,1;SUT==))");
            }

            if (SUCCEEDED(profileHr))
            {
                profileHr = profileCollection->AddProfile(profile.Get());
            }

            if (SUCCEEDED(profileHr))
            {
                profileHr = sourceAttributes_->SetUnknown(MF_DEVICEMFT_SENSORPROFILE_COLLECTION, profileCollection.Get());
            }

            if (FAILED(profileHr))
            {
                wchar_t message[192]{};
                if (SUCCEEDED(StringCchPrintfW(message, ARRAYSIZE(message),
                    L"[Source::CreateSourceAttributes] Sensor profile setup failed hr=0x%08X. Continuing without sensor profiles.",
                    profileHr)))
                {
                    AppendMfVirtualCameraLogLine(message);
                }
            }

            return S_OK;
        }

        IFACEMETHODIMP SurevideotoolMediaSource::QueryInterface(REFIID interfaceId, void** object)
        {
            AppendMfVirtualCameraLogLine(L"[Source::QueryInterface] called.");

            if (object == nullptr)
            {
                return E_POINTER;
            }

            *object = nullptr;

            if (interfaceId == __uuidof(IUnknown) ||
                interfaceId == __uuidof(IMFMediaEventGenerator) ||
                interfaceId == __uuidof(IMFMediaSource))
            {
                *object = static_cast<IMFMediaSource*>(static_cast<IMFMediaSourceEx*>(this));
            }
            else if (interfaceId == __uuidof(IMFMediaSourceEx))
            {
                *object = static_cast<IMFMediaSourceEx*>(this);
            }
            else if (interfaceId == __uuidof(IMFGetService))
            {
                *object = static_cast<IMFGetService*>(this);
            }
            else if (interfaceId == __uuidof(IKsControl))
            {
                *object = static_cast<IKsControl*>(this);
            }
            else if (interfaceId == __uuidof(IMFSampleAllocatorControl))
            {
                *object = static_cast<IMFSampleAllocatorControl*>(this);
            }
            else
            {
                return E_NOINTERFACE;
            }

            AddRef();
            return S_OK;
        }

        IFACEMETHODIMP SurevideotoolMediaSourceActivate::QueryInterface(REFIID interfaceId, void** object)
        {
            if (object == nullptr)
            {
                return E_POINTER;
            }

            *object = nullptr;

            if (interfaceId == __uuidof(IUnknown) || interfaceId == __uuidof(IMFActivate))
            {
                *object = static_cast<IMFActivate*>(this);
            }
            else if (interfaceId == __uuidof(IMFAttributes))
            {
                *object = static_cast<IMFAttributes*>(this);
            }
            else
            {
                return E_NOINTERFACE;
            }

            AddRef();
            return S_OK;
        }

        IFACEMETHODIMP SurevideotoolMediaSourceActivate::ActivateObject(REFIID interfaceId, void** object)
        {
            if (object == nullptr)
            {
                return E_POINTER;
            }

            *object = nullptr;

            AppendMfVirtualCameraLogLine(L"[ActivateObject] called.");

            auto source = Make<SurevideotoolMediaSource>();
            if (!source)
            {
                AppendMfVirtualCameraLogLine(L"[ActivateObject] source allocation failed.");
                return E_OUTOFMEMORY;
            }

            HRESULT hr = source->Initialize(attributes_.Get());
            if (FAILED(hr))
            {
                wchar_t message[160]{};
                if (SUCCEEDED(StringCchPrintfW(message, ARRAYSIZE(message),
                    L"[ActivateObject] source initialization failed hr=0x%08X.", hr)))
                {
                    AppendMfVirtualCameraLogLine(message);
                }

                return hr;
            }

            activeSource_ = source;
            hr = source->QueryInterface(interfaceId, object);
            if (FAILED(hr))
            {
                wchar_t message[160]{};
                if (SUCCEEDED(StringCchPrintfW(message, ARRAYSIZE(message),
                    L"[ActivateObject] QueryInterface failed hr=0x%08X.", hr)))
                {
                    AppendMfVirtualCameraLogLine(message);
                }
            }
            else
            {
                AppendMfVirtualCameraLogLine(L"[ActivateObject] completed.");
            }

            return hr;
        }

        IFACEMETHODIMP SurevideotoolMediaSourceActivate::ShutdownObject()
        {
            if (activeSource_)
            {
                activeSource_->Shutdown();
                activeSource_.Reset();
            }

            return S_OK;
        }

        IFACEMETHODIMP SurevideotoolMediaSourceActivate::DetachObject()
        {
            activeSource_.Reset();
            return S_OK;
        }

        IFACEMETHODIMP SurevideotoolMediaSourceActivate::GetItem(REFGUID key, PROPVARIANT* value)
        {
            return attributes_->GetItem(key, value);
        }

        IFACEMETHODIMP SurevideotoolMediaSourceActivate::GetItemType(REFGUID key, MF_ATTRIBUTE_TYPE* type)
        {
            return attributes_->GetItemType(key, type);
        }

        IFACEMETHODIMP SurevideotoolMediaSourceActivate::CompareItem(REFGUID key, REFPROPVARIANT value, BOOL* result)
        {
            return attributes_->CompareItem(key, value, result);
        }

        IFACEMETHODIMP SurevideotoolMediaSourceActivate::Compare(IMFAttributes* theirs, MF_ATTRIBUTES_MATCH_TYPE matchType, BOOL* result)
        {
            return attributes_->Compare(theirs, matchType, result);
        }

        IFACEMETHODIMP SurevideotoolMediaSourceActivate::GetUINT32(REFGUID key, UINT32* value)
        {
            return attributes_->GetUINT32(key, value);
        }

        IFACEMETHODIMP SurevideotoolMediaSourceActivate::GetUINT64(REFGUID key, UINT64* value)
        {
            return attributes_->GetUINT64(key, value);
        }

        IFACEMETHODIMP SurevideotoolMediaSourceActivate::GetDouble(REFGUID key, double* value)
        {
            return attributes_->GetDouble(key, value);
        }

        IFACEMETHODIMP SurevideotoolMediaSourceActivate::GetGUID(REFGUID key, GUID* value)
        {
            return attributes_->GetGUID(key, value);
        }

        IFACEMETHODIMP SurevideotoolMediaSourceActivate::GetStringLength(REFGUID key, UINT32* length)
        {
            return attributes_->GetStringLength(key, length);
        }

        IFACEMETHODIMP SurevideotoolMediaSourceActivate::GetString(REFGUID key, LPWSTR value, UINT32 valueSize, UINT32* length)
        {
            return attributes_->GetString(key, value, valueSize, length);
        }

        IFACEMETHODIMP SurevideotoolMediaSourceActivate::GetAllocatedString(REFGUID key, LPWSTR* value, UINT32* length)
        {
            return attributes_->GetAllocatedString(key, value, length);
        }

        IFACEMETHODIMP SurevideotoolMediaSourceActivate::GetBlobSize(REFGUID key, UINT32* size)
        {
            return attributes_->GetBlobSize(key, size);
        }

        IFACEMETHODIMP SurevideotoolMediaSourceActivate::GetBlob(REFGUID key, UINT8* buffer, UINT32 bufferSize, UINT32* size)
        {
            return attributes_->GetBlob(key, buffer, bufferSize, size);
        }

        IFACEMETHODIMP SurevideotoolMediaSourceActivate::GetAllocatedBlob(REFGUID key, UINT8** buffer, UINT32* size)
        {
            return attributes_->GetAllocatedBlob(key, buffer, size);
        }

        IFACEMETHODIMP SurevideotoolMediaSourceActivate::GetUnknown(REFGUID key, REFIID interfaceId, void** object)
        {
            return attributes_->GetUnknown(key, interfaceId, object);
        }

        IFACEMETHODIMP SurevideotoolMediaSourceActivate::SetItem(REFGUID key, REFPROPVARIANT value)
        {
            return attributes_->SetItem(key, value);
        }

        IFACEMETHODIMP SurevideotoolMediaSourceActivate::DeleteItem(REFGUID key)
        {
            return attributes_->DeleteItem(key);
        }

        IFACEMETHODIMP SurevideotoolMediaSourceActivate::DeleteAllItems()
        {
            return attributes_->DeleteAllItems();
        }

        IFACEMETHODIMP SurevideotoolMediaSourceActivate::SetUINT32(REFGUID key, UINT32 value)
        {
            return attributes_->SetUINT32(key, value);
        }

        IFACEMETHODIMP SurevideotoolMediaSourceActivate::SetUINT64(REFGUID key, UINT64 value)
        {
            return attributes_->SetUINT64(key, value);
        }

        IFACEMETHODIMP SurevideotoolMediaSourceActivate::SetDouble(REFGUID key, double value)
        {
            return attributes_->SetDouble(key, value);
        }

        IFACEMETHODIMP SurevideotoolMediaSourceActivate::SetGUID(REFGUID key, REFGUID value)
        {
            return attributes_->SetGUID(key, value);
        }

        IFACEMETHODIMP SurevideotoolMediaSourceActivate::SetString(REFGUID key, LPCWSTR value)
        {
            return attributes_->SetString(key, value);
        }

        IFACEMETHODIMP SurevideotoolMediaSourceActivate::SetBlob(REFGUID key, const UINT8* buffer, UINT32 bufferSize)
        {
            return attributes_->SetBlob(key, buffer, bufferSize);
        }

        IFACEMETHODIMP SurevideotoolMediaSourceActivate::SetUnknown(REFGUID key, IUnknown* value)
        {
            return attributes_->SetUnknown(key, value);
        }

        IFACEMETHODIMP SurevideotoolMediaSourceActivate::LockStore()
        {
            return attributes_->LockStore();
        }

        IFACEMETHODIMP SurevideotoolMediaSourceActivate::UnlockStore()
        {
            return attributes_->UnlockStore();
        }

        IFACEMETHODIMP SurevideotoolMediaSourceActivate::GetCount(UINT32* items)
        {
            return attributes_->GetCount(items);
        }

        IFACEMETHODIMP SurevideotoolMediaSourceActivate::GetItemByIndex(UINT32 index, GUID* key, PROPVARIANT* value)
        {
            return attributes_->GetItemByIndex(index, key, value);
        }

        IFACEMETHODIMP SurevideotoolMediaSourceActivate::CopyAllItems(IMFAttributes* destination)
        {
            return attributes_->CopyAllItems(destination);
        }

        IFACEMETHODIMP SurevideotoolMediaSource::BeginGetEvent(IMFAsyncCallback* callback, IUnknown* state)
        {
            AppendMfVirtualCameraLogLine(L"[Source::BeginGetEvent] called.");

            std::lock_guard<std::mutex> guard(lock_);
            if (state_ == SourceState::Shutdown)
            {
                return MF_E_SHUTDOWN;
            }

            return eventQueue_->BeginGetEvent(callback, state);
        }

        IFACEMETHODIMP SurevideotoolMediaSource::EndGetEvent(IMFAsyncResult* result, IMFMediaEvent** eventValue)
        {
            AppendMfVirtualCameraLogLine(L"[Source::EndGetEvent] called.");

            std::lock_guard<std::mutex> guard(lock_);
            if (state_ == SourceState::Shutdown)
            {
                return MF_E_SHUTDOWN;
            }

            return eventQueue_->EndGetEvent(result, eventValue);
        }

        IFACEMETHODIMP SurevideotoolMediaSource::GetEvent(DWORD flags, IMFMediaEvent** eventValue)
        {
            AppendMfVirtualCameraLogLine(L"[Source::GetEvent] called.");

            ComPtr<IMFMediaEventQueue> eventQueue;
            {
                std::lock_guard<std::mutex> guard(lock_);
                if (state_ == SourceState::Shutdown)
                {
                    return MF_E_SHUTDOWN;
                }

                eventQueue = eventQueue_;
            }

            return eventQueue ? eventQueue->GetEvent(flags, eventValue) : MF_E_SHUTDOWN;
        }

        IFACEMETHODIMP SurevideotoolMediaSource::QueueEvent(MediaEventType eventType, REFGUID extendedType, HRESULT status, const PROPVARIANT* value)
        {
            AppendMfVirtualCameraLogLine(L"[Source::QueueEvent] called.");

            std::lock_guard<std::mutex> guard(lock_);
            if (state_ == SourceState::Shutdown)
            {
                return MF_E_SHUTDOWN;
            }

            return eventQueue_->QueueEventParamVar(eventType, extendedType, status, value);
        }

        IFACEMETHODIMP SurevideotoolMediaSource::GetCharacteristics(DWORD* characteristics)
        {
            AppendMfVirtualCameraLogLine(L"[Source::GetCharacteristics] called.");

            if (characteristics == nullptr)
            {
                return E_POINTER;
            }

            std::lock_guard<std::mutex> guard(lock_);
            if (state_ == SourceState::Shutdown)
            {
                return MF_E_SHUTDOWN;
            }

            *characteristics = MFMEDIASOURCE_IS_LIVE;
            return S_OK;
        }

        IFACEMETHODIMP SurevideotoolMediaSource::CreatePresentationDescriptor(IMFPresentationDescriptor** presentationDescriptor)
        {
            AppendMfVirtualCameraLogLine(L"[Source::CreatePresentationDescriptor] called.");

            if (presentationDescriptor == nullptr)
            {
                return E_POINTER;
            }

            *presentationDescriptor = nullptr;

            std::lock_guard<std::mutex> guard(lock_);
            if (state_ == SourceState::Shutdown)
            {
                return MF_E_SHUTDOWN;
            }

            return presentationDescriptor_->Clone(presentationDescriptor);
        }

        IFACEMETHODIMP SurevideotoolMediaSource::Start(IMFPresentationDescriptor* presentationDescriptor, const GUID* timeFormat, const PROPVARIANT* startPosition)
        {
            AppendMfVirtualCameraLogLine(L"[Source::Start] called.");
            if (presentationDescriptor == nullptr || startPosition == nullptr)
            {
                return E_INVALIDARG;
            }

            std::lock_guard<std::mutex> guard(lock_);
            if (state_ == SourceState::Shutdown)
            {
                return MF_E_SHUTDOWN;
            }

            if (timeFormat != nullptr && *timeFormat != GUID_NULL)
            {
                return MF_E_UNSUPPORTED_TIME_FORMAT;
            }

            if (!IsSupportedStartPosition(startPosition))
            {
                return MF_E_INVALIDREQUEST;
            }

            const bool isSeek = state_ == SourceState::Started && startPosition->vt != VT_EMPTY;
            const MediaEventType sourceEventType = isSeek ? MESourceSeeked : MESourceStarted;
            const MediaEventType streamEventType = isSeek ? MEStreamSeeked : MEStreamStarted;
            BOOL selected = FALSE;
            ComPtr<IMFStreamDescriptor> requestedStream;
            RETURN_IF_FAILED(presentationDescriptor->GetStreamDescriptorByIndex(0, &selected, &requestedStream));

            if (selected)
            {
                ComPtr<IMFMediaTypeHandler> mediaTypeHandler;
                ComPtr<IMFMediaType> mediaType;
                RETURN_IF_FAILED(requestedStream->GetMediaTypeHandler(&mediaTypeHandler));
                RETURN_IF_FAILED(mediaTypeHandler->GetCurrentMediaType(&mediaType));

                const bool wasSelected = stream_->IsSelected();
                RETURN_IF_FAILED(stream_->Start(mediaType.Get(), false));
                RETURN_IF_FAILED(presentationDescriptor_->SelectStream(0));
                RETURN_IF_FAILED(eventQueue_->QueueEventParamUnk(wasSelected ? MEUpdatedStream : MENewStream, GUID_NULL, S_OK, stream_.Get()));
            }
            else
            {
                RETURN_IF_FAILED(stream_->Stop(false));
                RETURN_IF_FAILED(presentationDescriptor_->DeselectStream(0));
            }

            state_ = SourceState::Started;

            // When starting (not seeking) and the requested position is VT_EMPTY,
            // the spec requires MF_EVENT_SOURCE_ACTUAL_START to be set on the event.
            if (sourceEventType == MESourceStarted &&
                (startPosition == nullptr || startPosition->vt == VT_EMPTY))
            {
                PROPVARIANT zeroStart{};
                PropVariantInit(&zeroStart);
                zeroStart.vt = VT_I8;
                zeroStart.hVal.QuadPart = 0;
                ComPtr<IMFMediaEvent> startEvent;
                RETURN_IF_FAILED(MFCreateMediaEvent(MESourceStarted, GUID_NULL, S_OK,
                    &zeroStart, &startEvent));
                RETURN_IF_FAILED(startEvent->SetUINT64(MF_EVENT_SOURCE_ACTUAL_START, 0));
                RETURN_IF_FAILED(eventQueue_->QueueEvent(startEvent.Get()));
            }
            else
            {
                RETURN_IF_FAILED(eventQueue_->QueueEventParamVar(sourceEventType, GUID_NULL,
                    S_OK, startPosition));
            }

            if (selected)
            {
                RETURN_IF_FAILED(stream_->QueueEvent(streamEventType, GUID_NULL, S_OK, startPosition));
            }

            return S_OK;
        }

        IFACEMETHODIMP SurevideotoolMediaSource::Stop()
        {
            std::lock_guard<std::mutex> guard(lock_);
            if (state_ == SourceState::Shutdown)
            {
                return MF_E_SHUTDOWN;
            }

            if (state_ != SourceState::Started)
            {
                return S_OK;
            }

            RETURN_IF_FAILED(stream_->Stop(true));
            state_ = SourceState::Stopped;
            return eventQueue_->QueueEventParamVar(MESourceStopped, GUID_NULL, S_OK, nullptr);
        }

        IFACEMETHODIMP SurevideotoolMediaSource::Pause()
        {
            return MF_E_INVALID_STATE_TRANSITION;
        }

        IFACEMETHODIMP SurevideotoolMediaSource::Shutdown()
        {
            std::lock_guard<std::mutex> guard(lock_);

            if (state_ == SourceState::Shutdown)
            {
                return S_OK;
            }

            state_ = SourceState::Shutdown;

            if (stream_)
            {
                stream_->ShutdownStream();
                stream_.Reset();
            }

            if (eventQueue_)
            {
                eventQueue_->Shutdown();
                eventQueue_.Reset();
            }

            presentationDescriptor_.Reset();
            sourceAttributes_.Reset();
            return S_OK;
        }

        IFACEMETHODIMP SurevideotoolMediaSource::GetSourceAttributes(IMFAttributes** attributes)
        {
            AppendMfVirtualCameraLogLine(L"[Source::GetSourceAttributes] called.");

            if (attributes == nullptr)
            {
                return E_POINTER;
            }

            *attributes = nullptr;

            std::lock_guard<std::mutex> guard(lock_);
            if (state_ == SourceState::Shutdown)
            {
                return MF_E_SHUTDOWN;
            }

            return sourceAttributes_.CopyTo(attributes);
        }

        IFACEMETHODIMP SurevideotoolMediaSource::GetStreamAttributes(DWORD streamIdentifier, IMFAttributes** attributes)
        {
            AppendMfVirtualCameraLogLine(L"[Source::GetStreamAttributes] called.");

            if (attributes == nullptr)
            {
                return E_POINTER;
            }

            *attributes = nullptr;

            std::lock_guard<std::mutex> guard(lock_);
            if (state_ == SourceState::Shutdown)
            {
                return MF_E_SHUTDOWN;
            }

            if (streamIdentifier != kStreamId)
            {
                return MF_E_INVALIDSTREAMNUMBER;
            }

            return stream_->CopyAttributes(attributes);
        }

        IFACEMETHODIMP SurevideotoolMediaSource::SetD3DManager(IUnknown* /*manager*/)
        {
            AppendMfVirtualCameraLogLine(L"[Source::SetD3DManager] called.");
            return S_OK;
        }

        IFACEMETHODIMP SurevideotoolMediaSource::GetService(REFGUID /*serviceGuid*/, REFIID /*interfaceId*/, void** object)
        {
            AppendMfVirtualCameraLogLine(L"[Source::GetService] called.");

            if (object == nullptr)
            {
                return E_POINTER;
            }

            *object = nullptr;
            return MF_E_UNSUPPORTED_SERVICE;
        }

        IFACEMETHODIMP SurevideotoolMediaSource::KsProperty(PKSPROPERTY /*property*/, ULONG /*propertyLength*/, void* /*propertyData*/, ULONG /*dataLength*/, ULONG* bytesReturned)
        {
            AppendMfVirtualCameraLogLine(L"[Source::KsProperty] called.");

            if (bytesReturned != nullptr)
            {
                *bytesReturned = 0;
            }

            return HRESULT_FROM_WIN32(ERROR_SET_NOT_FOUND);
        }

        IFACEMETHODIMP SurevideotoolMediaSource::KsMethod(PKSMETHOD /*method*/, ULONG /*methodLength*/, void* /*methodData*/, ULONG /*dataLength*/, ULONG* bytesReturned)
        {
            if (bytesReturned != nullptr)
            {
                *bytesReturned = 0;
            }

            return HRESULT_FROM_WIN32(ERROR_SET_NOT_FOUND);
        }

        IFACEMETHODIMP SurevideotoolMediaSource::KsEvent(PKSEVENT /*eventValue*/, ULONG /*eventLength*/, void* /*eventData*/, ULONG /*dataLength*/, ULONG* bytesReturned)
        {
            if (bytesReturned != nullptr)
            {
                *bytesReturned = 0;
            }

            return HRESULT_FROM_WIN32(ERROR_SET_NOT_FOUND);
        }

        IFACEMETHODIMP SurevideotoolMediaSource::SetDefaultAllocator(DWORD outputStreamId, IUnknown* /*allocator*/)
        {
            if (outputStreamId != kStreamId)
            {
                return MF_E_INVALIDSTREAMNUMBER;
            }

            return S_OK;
        }

        IFACEMETHODIMP SurevideotoolMediaSource::GetAllocatorUsage(DWORD outputStreamId, DWORD* inputStreamId, MFSampleAllocatorUsage* usage)
        {
            if (inputStreamId == nullptr || usage == nullptr)
            {
                return E_POINTER;
            }

            if (outputStreamId != kStreamId)
            {
                return MF_E_INVALIDSTREAMNUMBER;
            }

            *inputStreamId = kStreamId;
            *usage = MFSampleAllocatorUsage_UsesCustomAllocator;
            return S_OK;
        }
    }

    bool CanUnloadMfModule() noexcept
    {
        return g_objectCount.load() == 0 && g_lockCount.load() == 0;
    }

    HRESULT CreateMfClassFactory(REFCLSID classId, REFIID interfaceId, void** object) noexcept
    {
        AppendMfVirtualCameraLogLine(L"[CreateMfClassFactory] called.");

        if (object == nullptr)
        {
            return E_POINTER;
        }

        *object = nullptr;

        if (!IsEqualGUID(classId, kWindowsVirtualCameraSourceClsid))
        {
            return CLASS_E_CLASSNOTAVAILABLE;
        }

        auto factory = Make<SurevideotoolClassFactory>();
        if (!factory)
        {
            return E_OUTOFMEMORY;
        }

        return factory.CopyTo(interfaceId, object);
    }
}
