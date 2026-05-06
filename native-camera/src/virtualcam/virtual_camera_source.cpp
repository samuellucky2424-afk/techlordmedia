#include "virtual_camera_source.h"

#include <algorithm>
#include <array>
#include <chrono>
#include <cstdint>
#include <cstring>
#include <memory>
#include <mutex>
#include <thread>

#include <ks.h>
#include <ksmedia.h>
#include <ksproxy.h>
#include <sddl.h>
#include <strsafe.h>
#include <windows.h>

#include "surevideotool/surevideotool_ids.h"
#include "surevideotool/surevideotool_protocol.h"

namespace surevideotool::virtualcam
{
    namespace
    {
        constexpr long kFrameWidth = 1280;
        constexpr long kFrameHeight = 720;
        constexpr long kFramesPerSecond = 30;
        constexpr long kYuy2StrideBytes = kFrameWidth * 2;
        constexpr long kBgraStrideBytes = kFrameWidth * 4;
        constexpr std::size_t kYuy2FrameBytes = static_cast<std::size_t>(kYuy2StrideBytes) * kFrameHeight;
        constexpr std::size_t kBgraFrameBytes = static_cast<std::size_t>(kBgraStrideBytes) * kFrameHeight;
        constexpr REFERENCE_TIME kFrameDuration = 333333;
        constexpr auto kFrameDurationChrono = std::chrono::nanoseconds(kFrameDuration * 100LL);
        constexpr DWORD kFrameReadWaitMs = 5;
        constexpr DWORD kOpenRetryDelayMs = 250;
        constexpr DWORD kYuy2FourCc = MAKEFOURCC('Y', 'U', 'Y', '2');

#ifdef TEST_PATTERN_MODE
        constexpr bool kUseExternalFrames = false;
#else
        constexpr bool kUseExternalFrames = true;
#endif

        std::array<std::vector<uint8_t>, 2> g_frameBuffers;
        std::mutex g_frameMutex;
        int g_frontBufferIndex = 0;
        int g_backBufferIndex = 1;
        bool g_hasFrame = false;
        std::uint64_t g_latestFrameSequence = 0;

        std::mutex g_frameProviderLock;
        std::thread g_frameProviderThread;
        bool g_stopFrameProvider = false;
        long g_frameProviderUsers = 0;

        void LogVirtualCameraEvent(const wchar_t* message) noexcept
        {
            if (message == nullptr)
            {
                return;
            }

            wchar_t line[256]{};
            if (SUCCEEDED(StringCchPrintfW(line, ARRAYSIZE(line), L"[Surevideotool] %s\r\n", message)))
            {
                OutputDebugStringW(line);
            }
        }

        inline uint8_t ClampToRange(int value, int minimum, int maximum) noexcept
        {
            return static_cast<uint8_t>(std::clamp(value, minimum, maximum));
        }

        struct BridgeNames
        {
            const wchar_t* mappingName = nullptr;
            const wchar_t* mutexName = nullptr;
            const wchar_t* eventName = nullptr;
        };

        const BridgeNames kLocalBridgeNames{
            kPublisherMappingName,
            kPublisherMutexName,
            kPublisherEventName,
        };

        const BridgeNames kGlobalBridgeNames{
            kGlobalPublisherMappingName,
            kGlobalPublisherMutexName,
            kGlobalPublisherEventName,
        };

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

        inline uint8_t ClampLuma(int value) noexcept
        {
            return ClampToRange(value, 16, 235);
        }

        inline uint8_t ClampChroma(int value) noexcept
        {
            return ClampToRange(value, 16, 240);
        }

        inline uint8_t BgraToLuma(uint8_t blue, uint8_t green, uint8_t red) noexcept
        {
            const int value = ((66 * red) + (129 * green) + (25 * blue) + 128) >> 8;
            return ClampLuma(value + 16);
        }

        inline uint8_t BgraToChromaU(uint8_t blue, uint8_t green, uint8_t red) noexcept
        {
            const int value = ((112 * blue) - (74 * green) - (38 * red) + 128) >> 8;
            return ClampChroma(value + 128);
        }

        inline uint8_t BgraToChromaV(uint8_t blue, uint8_t green, uint8_t red) noexcept
        {
            const int value = ((112 * red) - (94 * green) - (18 * blue) + 128) >> 8;
            return ClampChroma(value + 128);
        }

        void EnsureLatestFrameStorageAllocated()
        {
            std::lock_guard<std::mutex> guard(g_frameMutex);
            if (!g_frameBuffers[0].empty() && !g_frameBuffers[1].empty())
            {
                return;
            }

            for (auto& buffer : g_frameBuffers)
            {
                buffer.resize(kBgraFrameBytes, 0);
            }
        }

        void CopyFrameToSharedLatest(const uint8_t* frameBytes) noexcept
        {
            if (frameBytes == nullptr)
            {
                return;
            }

            EnsureLatestFrameStorageAllocated();

            const int writeIndex = g_backBufferIndex;
            std::memcpy(g_frameBuffers[writeIndex].data(), frameBytes, kBgraFrameBytes);

            std::uint64_t frameSequence = 0;
            {
                std::lock_guard<std::mutex> guard(g_frameMutex);
                g_frontBufferIndex = writeIndex;
                g_backBufferIndex = 1 - writeIndex;
                g_hasFrame = true;
                frameSequence = ++g_latestFrameSequence;
            }

            if ((frameSequence % static_cast<std::uint64_t>(kFramesPerSecond)) == 1ULL)
            {
                LogVirtualCameraEvent(L"New frame received");
            }
        }

        void ConvertBgraToYuy2(const uint8_t* bgraBytes, uint8_t* yuy2Bytes) noexcept
        {
            if (bgraBytes == nullptr || yuy2Bytes == nullptr)
            {
                return;
            }

            for (long y = 0; y < kFrameHeight; ++y)
            {
                const uint8_t* sourceRow = bgraBytes + (static_cast<std::size_t>(y) * kBgraStrideBytes);
                uint8_t* destinationRow = yuy2Bytes + (static_cast<std::size_t>(y) * kYuy2StrideBytes);

                for (long x = 0; x < kFrameWidth; x += 2)
                {
                    const uint8_t* pixel0 = sourceRow + (static_cast<std::size_t>(x) * 4);
                    const uint8_t* pixel1 = pixel0 + 4;

                    const uint8_t y0 = BgraToLuma(pixel0[0], pixel0[1], pixel0[2]);
                    const uint8_t y1 = BgraToLuma(pixel1[0], pixel1[1], pixel1[2]);

                    const uint8_t u0 = BgraToChromaU(pixel0[0], pixel0[1], pixel0[2]);
                    const uint8_t u1 = BgraToChromaU(pixel1[0], pixel1[1], pixel1[2]);
                    const uint8_t v0 = BgraToChromaV(pixel0[0], pixel0[1], pixel0[2]);
                    const uint8_t v1 = BgraToChromaV(pixel1[0], pixel1[1], pixel1[2]);

                    const std::size_t outputIndex = static_cast<std::size_t>(x) * 2;
                    destinationRow[outputIndex + 0] = y0;
                    destinationRow[outputIndex + 1] = static_cast<uint8_t>((static_cast<unsigned>(u0) + static_cast<unsigned>(u1)) / 2U);
                    destinationRow[outputIndex + 2] = y1;
                    destinationRow[outputIndex + 3] = static_cast<uint8_t>((static_cast<unsigned>(v0) + static_cast<unsigned>(v1)) / 2U);
                }
            }
        }

        void GenerateAnimatedTestPatternBgra(uint8_t* destination, std::uint64_t frameIndex) noexcept
        {
            if (destination == nullptr)
            {
                return;
            }

            const int phase = static_cast<int>((frameIndex * 4ULL) % 256ULL);
            const long movingBarLeft = static_cast<long>((frameIndex * 12ULL) % static_cast<std::uint64_t>(kFrameWidth));
            const long movingBarRight = std::min<long>(movingBarLeft + 96L, kFrameWidth);

            for (long y = 0; y < kFrameHeight; ++y)
            {
                uint8_t* row = destination + (static_cast<std::size_t>(y) * kBgraStrideBytes);
                const int bandOffset = ((y / 36) + (phase / 16)) % 8;

                for (long x = 0; x < kFrameWidth; ++x)
                {
                    const bool inMovingBar = (x >= movingBarLeft) && (x < movingBarRight);
                    const int band = (((x / 160) + bandOffset) % 8);

                    uint8_t blue = static_cast<uint8_t>(32 + ((x + phase + (y / 2)) % 144));
                    uint8_t green = blue;
                    uint8_t red = blue;

                    switch (band)
                    {
                    case 0:
                        blue = 255; green = 0; red = 255;
                        break;
                    case 1:
                        blue = 255; green = 255; red = 0;
                        break;
                    case 2:
                        blue = 0; green = 255; red = 0;
                        break;
                    case 3:
                        blue = 255; green = 0; red = 0;
                        break;
                    case 4:
                        blue = 0; green = 255; red = 255;
                        break;
                    case 5:
                        blue = 0; green = 0; red = 255;
                        break;
                    case 6:
                        blue = 0; green = 255; red = 0;
                        break;
                    default:
                        blue = 128; green = 128; red = 128;
                        break;
                    }

                    if (inMovingBar)
                    {
                        blue = static_cast<uint8_t>(128 + ((phase / 2) % 40));
                        green = 220;
                        red = static_cast<uint8_t>(128 - ((phase / 3) % 40));
                    }

                    const std::size_t outputIndex = static_cast<std::size_t>(x) * 4;
                    row[outputIndex + 0] = blue;
                    row[outputIndex + 1] = green;
                    row[outputIndex + 2] = red;
                    row[outputIndex + 3] = 0xff;
                }
            }
        }

        void FillFixedVideoInfoHeader(VIDEOINFOHEADER* videoInfoHeader) noexcept
        {
            if (videoInfoHeader == nullptr)
            {
                return;
            }

            std::memset(videoInfoHeader, 0, sizeof(*videoInfoHeader));
            videoInfoHeader->AvgTimePerFrame = kFrameDuration;
            videoInfoHeader->dwBitRate = static_cast<DWORD>(kYuy2FrameBytes * 8 * kFramesPerSecond);
            videoInfoHeader->dwBitErrorRate = 0;
            SetRect(&videoInfoHeader->rcSource, 0, 0, kFrameWidth, kFrameHeight);
            SetRect(&videoInfoHeader->rcTarget, 0, 0, kFrameWidth, kFrameHeight);
            videoInfoHeader->bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
            videoInfoHeader->bmiHeader.biWidth = kFrameWidth;
            videoInfoHeader->bmiHeader.biHeight = kFrameHeight;
            videoInfoHeader->bmiHeader.biPlanes = 1;
            videoInfoHeader->bmiHeader.biBitCount = 16;
            videoInfoHeader->bmiHeader.biCompression = kYuy2FourCc;
            videoInfoHeader->bmiHeader.biSizeImage = static_cast<DWORD>(kYuy2FrameBytes);
        }

        void ApplyYuy2Heartbeat(uint8_t* yuy2Bytes, std::size_t byteCount, std::uint64_t frameIndex) noexcept
        {
            if (yuy2Bytes == nullptr || byteCount < 4)
            {
                return;
            }

            const uint8_t pulse = static_cast<uint8_t>(frameIndex & 0x01ULL);
            const std::size_t tailOffset = byteCount >= 8 ? byteCount - 8 : 0;

            yuy2Bytes[0] = static_cast<uint8_t>((yuy2Bytes[0] & 0xfeU) | pulse);
            yuy2Bytes[2] = static_cast<uint8_t>((yuy2Bytes[2] & 0xfeU) | static_cast<uint8_t>(pulse ^ 0x01U));
            yuy2Bytes[tailOffset + 0] = static_cast<uint8_t>((yuy2Bytes[tailOffset + 0] & 0xfeU) | pulse);
            yuy2Bytes[tailOffset + 2] = static_cast<uint8_t>((yuy2Bytes[tailOffset + 2] & 0xfeU) | static_cast<uint8_t>(pulse ^ 0x01U));
        }

        void FillYuy2NeutralFrame(uint8_t* yuy2Bytes, std::size_t byteCount) noexcept
        {
            if (yuy2Bytes == nullptr)
            {
                return;
            }

            for (std::size_t offset = 0; offset + 3 < byteCount; offset += 4)
            {
                yuy2Bytes[offset + 0] = 16;
                yuy2Bytes[offset + 1] = 128;
                yuy2Bytes[offset + 2] = 16;
                yuy2Bytes[offset + 3] = 128;
            }
        }

        void SleepUntilNextFrame(std::chrono::steady_clock::time_point* nextFrameDue) noexcept
        {
            if (nextFrameDue == nullptr)
            {
                return;
            }

            auto now = std::chrono::steady_clock::now();
            if (nextFrameDue->time_since_epoch().count() == 0)
            {
                *nextFrameDue = now;
            }

            if (*nextFrameDue > now)
            {
                while (true)
                {
                    now = std::chrono::steady_clock::now();
                    if (*nextFrameDue <= now)
                    {
                        break;
                    }

                    const auto remaining = *nextFrameDue - now;
                    if (remaining > std::chrono::milliseconds(2))
                    {
                        const auto sleepFor = std::chrono::duration_cast<std::chrono::milliseconds>(remaining - std::chrono::milliseconds(1));
                        Sleep(static_cast<DWORD>(std::max<long long>(1LL, sleepFor.count())));
                    }
                    else
                    {
                        Sleep(0);
                    }
                }
            }

            *nextFrameDue += kFrameDurationChrono;
            const auto maxLag = kFrameDurationChrono * 2;
            now = std::chrono::steady_clock::now();
            if (*nextFrameDue + maxLag < now)
            {
                *nextFrameDue = now + kFrameDurationChrono;
            }
        }

        void FillFixedYuy2MediaType(CMediaType* mediaType) noexcept
        {
            if (mediaType == nullptr)
            {
                return;
            }

            mediaType->InitMediaType();
            mediaType->SetType(&MEDIATYPE_Video);
            mediaType->SetSubtype(&MEDIASUBTYPE_YUY2);
            mediaType->SetTemporalCompression(FALSE);
            mediaType->SetSampleSize(static_cast<ULONG>(kYuy2FrameBytes));
            mediaType->SetFormatType(&FORMAT_VideoInfo);

            VIDEOINFOHEADER* videoInfoHeader = reinterpret_cast<VIDEOINFOHEADER*>(mediaType->AllocFormatBuffer(sizeof(VIDEOINFOHEADER)));
            FillFixedVideoInfoHeader(videoInfoHeader);
        }

        class SharedFrameReader final
        {
        public:
            SharedFrameReader()
                : bgraScratch_(std::make_unique<uint8_t[]>(kBgraFrameBytes))
            {
            }

            ~SharedFrameReader()
            {
                Close();
            }

            bool Pump() noexcept
            {
                if constexpr (!kUseExternalFrames)
                {
                    return false;
                }

                if (!EnsureOpen())
                {
                    return false;
                }

                if (eventHandle_ != nullptr)
                {
                    (void)WaitForSingleObject(eventHandle_, kFrameReadWaitMs);
                }
                else
                {
                    Sleep(kFrameReadWaitMs);
                }

                return ReadLatestFrame();
            }

        private:
            bool EnsureOpen() noexcept
            {
                if (usingFileBridge_ && bridgeFile_ != nullptr && mappingHandle_ != nullptr && view_ != nullptr)
                {
                    return true;
                }

                if (!usingFileBridge_ && view_ != nullptr && mappingHandle_ != nullptr && mutexHandle_ != nullptr)
                {
                    return true;
                }

                const ULONGLONG now = GetTickCount64();
                if (now < nextOpenAttemptTickMs_)
                {
                    return false;
                }

                Close();
                if (EnsureOpenFileBridge())
                {
                    return true;
                }

                Close();
                if (EnsureOpenWithNamespace(kGlobalBridgeNames, true))
                {
                    return true;
                }

                Close();
                if (EnsureOpenWithNamespace(kLocalBridgeNames, false))
                {
                    return true;
                }

                Close();
                nextOpenAttemptTickMs_ = now + kOpenRetryDelayMs;
                return false;
            }

            bool EnsureOpenFileBridge() noexcept
            {
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
                    return false;
                }

                LARGE_INTEGER fileSize{};
                if (!GetFileSizeEx(bridgeFile_, &fileSize))
                {
                    Close();
                    return false;
                }

                const std::size_t minimumByteCount = sizeof(SharedFrameHeader) + kBgraFrameBytes;
                if (fileSize.QuadPart < static_cast<LONGLONG>(minimumByteCount))
                {
                    Close();
                    return false;
                }

                mappingByteCount_ = static_cast<std::size_t>(fileSize.QuadPart);
                mappingHandle_ = CreateFileMappingW(bridgeFile_, nullptr, PAGE_READONLY, 0, 0, nullptr);
                if (mappingHandle_ == nullptr)
                {
                    Close();
                    return false;
                }

                view_ = MapViewOfFile(mappingHandle_, FILE_MAP_READ, 0, 0, 0);
                if (view_ == nullptr)
                {
                    Close();
                    return false;
                }

                const auto* header = static_cast<const SharedFrameHeader*>(view_);
                if (header == nullptr ||
                    header->magic != kProtocolMagic ||
                    header->version != kProtocolVersion ||
                    header->pixelFormat != kPixelFormatBgra32)
                {
                    Close();
                    return false;
                }

                usingFileBridge_ = true;
                return true;
            }

            bool EnsureOpenWithNamespace(const BridgeNames& names, bool allowCreate) noexcept
            {
                const std::size_t mappingByteCount = sizeof(SharedFrameHeader) + kBgraFrameBytes;

                mappingHandle_ = OpenFileMappingW(FILE_MAP_READ | FILE_MAP_WRITE, FALSE, names.mappingName);
                mutexHandle_ = OpenMutexW(SYNCHRONIZE | MUTEX_MODIFY_STATE, FALSE, names.mutexName);
                eventHandle_ = OpenEventW(SYNCHRONIZE | EVENT_MODIFY_STATE, FALSE, names.eventName);

                bool createdMapping = false;
                if ((mappingHandle_ == nullptr || mutexHandle_ == nullptr) && allowCreate)
                {
                    Close();

                    SecurityDescriptorHolder securityDescriptor;
                    SECURITY_ATTRIBUTES securityAttributes{};
                    if (FAILED(BuildBridgeSecurityAttributes(&securityAttributes, &securityDescriptor)))
                    {
                        Close();
                        return false;
                    }

                    mutexHandle_ = CreateMutexW(&securityAttributes, FALSE, names.mutexName);
                    eventHandle_ = CreateEventW(&securityAttributes, FALSE, FALSE, names.eventName);

                    ULARGE_INTEGER mappingSize{};
                    mappingSize.QuadPart = static_cast<unsigned long long>(mappingByteCount);
                    mappingHandle_ = CreateFileMappingW(
                        INVALID_HANDLE_VALUE,
                        &securityAttributes,
                        PAGE_READWRITE,
                        mappingSize.HighPart,
                        mappingSize.LowPart,
                        names.mappingName);

                    createdMapping = (mappingHandle_ != nullptr) && (GetLastError() != ERROR_ALREADY_EXISTS);
                }

                if (mappingHandle_ == nullptr || mutexHandle_ == nullptr)
                {
                    Close();
                    return false;
                }

                const DWORD desiredAccess = allowCreate ? (FILE_MAP_READ | FILE_MAP_WRITE) : FILE_MAP_READ;
                view_ = MapViewOfFile(mappingHandle_, desiredAccess, 0, 0, mappingByteCount);
                if (view_ == nullptr)
                {
                    Close();
                    return false;
                }

                if (createdMapping || allowCreate)
                {
                    const DWORD waitResult = WaitForSingleObject(mutexHandle_, 2000);
                    if (waitResult == WAIT_OBJECT_0 || waitResult == WAIT_ABANDONED)
                    {
                        auto* header = static_cast<SharedFrameHeader*>(view_);
                        if (header != nullptr &&
                            (createdMapping ||
                             header->magic != kProtocolMagic ||
                             header->version != kProtocolVersion ||
                             header->width != static_cast<uint32_t>(kFrameWidth) ||
                             header->height != static_cast<uint32_t>(kFrameHeight) ||
                             header->stride != static_cast<uint32_t>(kBgraStrideBytes) ||
                             header->payloadBytes != kBgraFrameBytes))
                        {
                            std::memset(view_, 0, mappingByteCount);
                            header->magic = kProtocolMagic;
                            header->version = kProtocolVersion;
                            header->width = static_cast<uint32_t>(kFrameWidth);
                            header->height = static_cast<uint32_t>(kFrameHeight);
                            header->stride = static_cast<uint32_t>(kBgraStrideBytes);
                            header->pixelFormat = kPixelFormatBgra32;
                            header->fpsNumerator = kFramesPerSecond;
                            header->fpsDenominator = 1;
                            header->payloadBytes = static_cast<uint32_t>(kBgraFrameBytes);
                        }

                        ReleaseMutex(mutexHandle_);
                    }
                }

                return true;
            }

            bool ReadLatestFrame() noexcept
            {
                if (usingFileBridge_)
                {
                    return ReadLatestFrameFromFileBridge();
                }

                if (view_ == nullptr || mutexHandle_ == nullptr)
                {
                    return false;
                }

                const DWORD waitResult = WaitForSingleObject(mutexHandle_, 1);
                if (waitResult != WAIT_OBJECT_0 && waitResult != WAIT_ABANDONED)
                {
                    return false;
                }

                bool copied = false;
                const SharedFrameHeader* header = static_cast<const SharedFrameHeader*>(view_);
                if (header != nullptr &&
                    header->magic == kProtocolMagic &&
                    header->version == kProtocolVersion &&
                    header->pixelFormat == kPixelFormatBgra32 &&
                    header->width == static_cast<uint32_t>(kFrameWidth) &&
                    header->height == static_cast<uint32_t>(kFrameHeight) &&
                    header->stride == static_cast<uint32_t>(kBgraStrideBytes) &&
                    header->payloadBytes == kBgraFrameBytes &&
                    header->frameCounter != 0 &&
                    header->frameCounter != lastFrameCounter_)
                {
                    const uint8_t* payload = reinterpret_cast<const uint8_t*>(header + 1);
                    std::memcpy(bgraScratch_.get(), payload, kBgraFrameBytes);
                    lastFrameCounter_ = header->frameCounter;
                    copied = true;
                }

                ReleaseMutex(mutexHandle_);

                if (!copied)
                {
                    return false;
                }

                CopyFrameToSharedLatest(bgraScratch_.get());
                return true;
            }

            bool ReadLatestFrameFromFileBridge() noexcept
            {
                if (view_ == nullptr)
                {
                    return false;
                }

                const auto* header = static_cast<const SharedFrameHeader*>(view_);
                if (header == nullptr ||
                    header->magic != kProtocolMagic ||
                    header->version != kProtocolVersion ||
                    header->pixelFormat != kPixelFormatBgra32)
                {
                    return false;
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
                    const uint64_t frameCounter = header->frameCounter;
                    if (frameCounter == 0 || frameCounter == lastFrameCounter_)
                    {
                        return false;
                    }

                    if (header->width != static_cast<uint32_t>(kFrameWidth) ||
                        header->height != static_cast<uint32_t>(kFrameHeight) ||
                        header->stride != static_cast<uint32_t>(kBgraStrideBytes) ||
                        payloadBytes != kBgraFrameBytes ||
                        mappingByteCount_ < (sizeof(SharedFrameHeader) + static_cast<std::size_t>(payloadBytes)))
                    {
                        return false;
                    }

                    const uint8_t* payload = reinterpret_cast<const uint8_t*>(header + 1);
                    std::memcpy(bgraScratch_.get(), payload, kBgraFrameBytes);

                    MemoryBarrier();

                    const LONG sequenceEnd = static_cast<LONG>(header->reserved);
                    if (sequenceStart == sequenceEnd && (sequenceEnd & 0x1L) == 0)
                    {
                        lastFrameCounter_ = frameCounter;
                        CopyFrameToSharedLatest(bgraScratch_.get());
                        return true;
                    }
                }

                return false;
            }

            void Close() noexcept
            {
                if (view_ != nullptr)
                {
                    UnmapViewOfFile(view_);
                    view_ = nullptr;
                }

                if (eventHandle_ != nullptr)
                {
                    CloseHandle(eventHandle_);
                    eventHandle_ = nullptr;
                }

                if (mutexHandle_ != nullptr)
                {
                    CloseHandle(mutexHandle_);
                    mutexHandle_ = nullptr;
                }

                if (mappingHandle_ != nullptr)
                {
                    CloseHandle(mappingHandle_);
                    mappingHandle_ = nullptr;
                }

                if (bridgeFile_ != nullptr)
                {
                    CloseHandle(bridgeFile_);
                    bridgeFile_ = nullptr;
                }

                usingFileBridge_ = false;
                mappingByteCount_ = 0;
            }

            HANDLE mappingHandle_ = nullptr;
            HANDLE mutexHandle_ = nullptr;
            HANDLE eventHandle_ = nullptr;
            HANDLE bridgeFile_ = nullptr;
            void* view_ = nullptr;
            std::uint64_t lastFrameCounter_ = 0;
            ULONGLONG nextOpenAttemptTickMs_ = 0;
            std::size_t mappingByteCount_ = 0;
            bool usingFileBridge_ = false;
            std::unique_ptr<uint8_t[]> bgraScratch_;
        };

        void FrameProviderThreadProc()
        {
            EnsureLatestFrameStorageAllocated();
            SharedFrameReader reader;

            while (true)
            {
                {
                    std::lock_guard<std::mutex> guard(g_frameProviderLock);
                    if (g_stopFrameProvider)
                    {
                        break;
                    }
                }

                if (!reader.Pump())
                {
                    Sleep(kFrameReadWaitMs);
                }
            }
        }

        void StartFrameProvider()
        {
            EnsureLatestFrameStorageAllocated();

            std::lock_guard<std::mutex> guard(g_frameProviderLock);
            ++g_frameProviderUsers;
            if (g_frameProviderUsers > 1)
            {
                return;
            }

            g_stopFrameProvider = false;
            g_frameProviderThread = std::thread(FrameProviderThreadProc);
        }

        void StopFrameProvider()
        {
            std::thread providerThread;

            {
                std::lock_guard<std::mutex> guard(g_frameProviderLock);
                if (g_frameProviderUsers <= 0)
                {
                    return;
                }

                --g_frameProviderUsers;
                if (g_frameProviderUsers > 0)
                {
                    return;
                }

                g_stopFrameProvider = true;
                providerThread = std::move(g_frameProviderThread);
            }

            if (providerThread.joinable())
            {
                providerThread.join();
            }
        }
    }

    HRESULT ValidateFixedYuy2MediaType(const AM_MEDIA_TYPE* mediaType) noexcept
    {
        if (mediaType == nullptr)
        {
            return E_POINTER;
        }

        if (mediaType->majortype != MEDIATYPE_Video ||
            mediaType->subtype != MEDIASUBTYPE_YUY2 ||
            mediaType->formattype != FORMAT_VideoInfo ||
            mediaType->cbFormat < sizeof(VIDEOINFOHEADER) ||
            mediaType->pbFormat == nullptr)
        {
            return VFW_E_TYPE_NOT_ACCEPTED;
        }

        const VIDEOINFOHEADER* videoInfoHeader = reinterpret_cast<const VIDEOINFOHEADER*>(mediaType->pbFormat);
        if (videoInfoHeader->bmiHeader.biWidth != kFrameWidth ||
            videoInfoHeader->bmiHeader.biHeight != kFrameHeight ||
            videoInfoHeader->bmiHeader.biCompression != kYuy2FourCc ||
            videoInfoHeader->bmiHeader.biBitCount != 16 ||
            videoInfoHeader->bmiHeader.biPlanes != 1 ||
            videoInfoHeader->bmiHeader.biSizeImage != static_cast<DWORD>(kYuy2FrameBytes))
        {
            return VFW_E_TYPE_NOT_ACCEPTED;
        }

        return S_OK;
    }

    HRESULT CreateFixedYuy2MediaType(AM_MEDIA_TYPE** mediaType) noexcept
    {
        if (mediaType == nullptr)
        {
            return E_POINTER;
        }

        *mediaType = nullptr;

        CMediaType fixedMediaType;
        FillFixedYuy2MediaType(&fixedMediaType);

        AM_MEDIA_TYPE* copy = CreateMediaType(&fixedMediaType);
        if (copy == nullptr)
        {
            return E_OUTOFMEMORY;
        }

        *mediaType = copy;
        return S_OK;
    }

    void FillFixedVideoStreamCaps(VIDEO_STREAM_CONFIG_CAPS* capabilities) noexcept
    {
        if (capabilities == nullptr)
        {
            return;
        }

        std::memset(capabilities, 0, sizeof(*capabilities));
        capabilities->guid = FORMAT_VideoInfo;
        capabilities->VideoStandard = AnalogVideo_None;
        capabilities->InputSize.cx = kFrameWidth;
        capabilities->InputSize.cy = kFrameHeight;
        capabilities->MinCroppingSize.cx = kFrameWidth;
        capabilities->MinCroppingSize.cy = kFrameHeight;
        capabilities->MaxCroppingSize.cx = kFrameWidth;
        capabilities->MaxCroppingSize.cy = kFrameHeight;
        capabilities->CropGranularityX = 1;
        capabilities->CropGranularityY = 1;
        capabilities->CropAlignX = 1;
        capabilities->CropAlignY = 1;
        capabilities->MinOutputSize.cx = kFrameWidth;
        capabilities->MinOutputSize.cy = kFrameHeight;
        capabilities->MaxOutputSize.cx = kFrameWidth;
        capabilities->MaxOutputSize.cy = kFrameHeight;
        capabilities->OutputGranularityX = 1;
        capabilities->OutputGranularityY = 1;
        capabilities->StretchTapsX = 0;
        capabilities->StretchTapsY = 0;
        capabilities->ShrinkTapsX = 0;
        capabilities->ShrinkTapsY = 0;
        capabilities->MinFrameInterval = kFrameDuration;
        capabilities->MaxFrameInterval = kFrameDuration;
        capabilities->MinBitsPerSecond = static_cast<LONG>(kYuy2FrameBytes * 8 * kFramesPerSecond);
        capabilities->MaxBitsPerSecond = capabilities->MinBitsPerSecond;
    }

    CUnknown* WINAPI SurevideotoolFilter::CreateInstance(LPUNKNOWN outerUnknown, HRESULT* result)
    {
        if (result != nullptr)
        {
            *result = S_OK;
        }

        SurevideotoolFilter* filter = new SurevideotoolFilter(outerUnknown, result);
        if (filter == nullptr && result != nullptr)
        {
            *result = E_OUTOFMEMORY;
        }

        return filter;
    }

    SurevideotoolFilter::SurevideotoolFilter(LPUNKNOWN outerUnknown, HRESULT* result)
        : CSource(NAME("Surevideotool"), outerUnknown, kVirtualCameraSourceClsid)
    {
        stream_ = new SurevideotoolStream(result, this, L"Output");
        if (stream_ == nullptr && result != nullptr)
        {
            *result = E_OUTOFMEMORY;
            return;
        }

        StartFrameProvider();
    }

    SurevideotoolFilter::~SurevideotoolFilter()
    {
        StopFrameProvider();
    }

    STDMETHODIMP SurevideotoolFilter::NonDelegatingQueryInterface(REFIID interfaceId, void** object)
    {
        CheckPointer(object, E_POINTER);

        if (interfaceId == IID_IAMStreamConfig)
        {
            return GetInterface(static_cast<IAMStreamConfig*>(this), object);
        }

        return CSource::NonDelegatingQueryInterface(interfaceId, object);
    }

    HRESULT STDMETHODCALLTYPE SurevideotoolFilter::SetFormat(AM_MEDIA_TYPE* mediaType)
    {
        return stream_ == nullptr ? E_UNEXPECTED : stream_->SetFormat(mediaType);
    }

    HRESULT STDMETHODCALLTYPE SurevideotoolFilter::GetFormat(AM_MEDIA_TYPE** mediaType)
    {
        return stream_ == nullptr ? E_UNEXPECTED : stream_->GetFormat(mediaType);
    }

    HRESULT STDMETHODCALLTYPE SurevideotoolFilter::GetNumberOfCapabilities(int* count, int* size)
    {
        return stream_ == nullptr ? E_UNEXPECTED : stream_->GetNumberOfCapabilities(count, size);
    }

    HRESULT STDMETHODCALLTYPE SurevideotoolFilter::GetStreamCaps(int index, AM_MEDIA_TYPE** mediaType, BYTE* capabilities)
    {
        return stream_ == nullptr ? E_UNEXPECTED : stream_->GetStreamCaps(index, mediaType, capabilities);
    }

    SurevideotoolStream::SurevideotoolStream(HRESULT* result, SurevideotoolFilter* parentFilter, LPCWSTR pinName)
        : CSourceStream(NAME("Surevideotool Stream"), result, parentFilter, pinName)
    {
        bgraScratch_.resize(kBgraFrameBytes, 0);
    }

    SurevideotoolStream::~SurevideotoolStream() = default;

    STDMETHODIMP SurevideotoolStream::NonDelegatingQueryInterface(REFIID interfaceId, void** object)
    {
        CheckPointer(object, E_POINTER);

        if (interfaceId == IID_IKsPropertySet)
        {
            return GetInterface(static_cast<IKsPropertySet*>(this), object);
        }

        if (interfaceId == IID_IAMStreamConfig)
        {
            return GetInterface(static_cast<IAMStreamConfig*>(this), object);
        }

        return CSourceStream::NonDelegatingQueryInterface(interfaceId, object);
    }

    STDMETHODIMP SurevideotoolStream::Notify(IBaseFilter*, Quality)
    {
        return S_OK;
    }

    HRESULT SurevideotoolStream::DecideBufferSize(IMemAllocator* allocator, ALLOCATOR_PROPERTIES* properties)
    {
        CheckPointer(allocator, E_POINTER);
        CheckPointer(properties, E_POINTER);

        CAutoLock filterLock(m_pFilter->pStateLock());
        CAutoLock sampleLock(&sampleLock_);

        properties->cBuffers = 2;
        properties->cbBuffer = currentSampleBytes_;
        properties->cbAlign = 1;
        properties->cbPrefix = 0;

        ALLOCATOR_PROPERTIES actualProperties{};
        const HRESULT result = allocator->SetProperties(properties, &actualProperties);
        if (FAILED(result))
        {
            return result;
        }

        if (actualProperties.cbBuffer < currentSampleBytes_)
        {
            return E_FAIL;
        }

        return S_OK;
    }

    HRESULT SurevideotoolStream::FillBuffer(IMediaSample* mediaSample)
    {
        CheckPointer(mediaSample, E_POINTER);

        SleepUntilNextFrame(&nextFrameDue_);

        BYTE* sampleBuffer = nullptr;
        HRESULT result = mediaSample->GetPointer(&sampleBuffer);
        if (FAILED(result) || sampleBuffer == nullptr)
        {
            return FAILED(result) ? result : E_POINTER;
        }

        try
        {
            long sampleBytes = currentSampleBytes_;
            std::uint64_t frameSequence = 0;
            bool copiedSharedFrame = false;

            {
                CAutoLock sampleLock(&sampleLock_);
                sampleBytes = currentSampleBytes_;
            }

            if (mediaSample->GetSize() < sampleBytes)
            {
                return E_FAIL;
            }

            {
                std::unique_lock<std::mutex> guard(g_frameMutex, std::try_to_lock);
                if (guard.owns_lock() && g_hasFrame && g_frameBuffers[g_frontBufferIndex].size() >= kBgraFrameBytes)
                {
                    if (bgraScratch_.size() < kBgraFrameBytes)
                    {
                        bgraScratch_.resize(kBgraFrameBytes, 0);
                    }

                    std::memcpy(bgraScratch_.data(), g_frameBuffers[g_frontBufferIndex].data(), kBgraFrameBytes);
                    frameSequence = g_latestFrameSequence;
                    copiedSharedFrame = true;
                    hasBufferedFrame_ = true;
                }
            }

            if (!hasBufferedFrame_)
            {
                GenerateAnimatedTestPatternBgra(bgraScratch_.data(), frameIndex_);
                hasBufferedFrame_ = true;
                loggedCachedFrameReuse_ = false;
            }
            else if (!copiedSharedFrame || frameSequence == lastPresentedFrameSequence_)
            {
                if (!loggedCachedFrameReuse_)
                {
                    LogVirtualCameraEvent(L"Reusing cached frame");
                    loggedCachedFrameReuse_ = true;
                }
            }
            else
            {
                lastPresentedFrameSequence_ = frameSequence;
                loggedCachedFrameReuse_ = false;
            }

            FillYuy2NeutralFrame(sampleBuffer, static_cast<std::size_t>(sampleBytes));
            ConvertBgraToYuy2(bgraScratch_.data(), sampleBuffer);
            ApplyYuy2Heartbeat(sampleBuffer, static_cast<std::size_t>(sampleBytes), frameIndex_);
        }
        catch (...)
        {
            if (bgraScratch_.size() < kBgraFrameBytes)
            {
                bgraScratch_.resize(kBgraFrameBytes, 0);
            }

            GenerateAnimatedTestPatternBgra(bgraScratch_.data(), frameIndex_);
            hasBufferedFrame_ = true;
            FillYuy2NeutralFrame(sampleBuffer, static_cast<std::size_t>(currentSampleBytes_));
            ConvertBgraToYuy2(bgraScratch_.data(), sampleBuffer);
            ApplyYuy2Heartbeat(sampleBuffer, static_cast<std::size_t>(currentSampleBytes_), frameIndex_);
        }

        REFERENCE_TIME start = static_cast<REFERENCE_TIME>(frameIndex_) * kFrameDuration;
        REFERENCE_TIME end = start + kFrameDuration;
        mediaSample->SetTime(&start, &end);
        mediaSample->SetSyncPoint(TRUE);
        mediaSample->SetActualDataLength(currentSampleBytes_);

        ++frameIndex_;
        return S_OK;
    }

    HRESULT SurevideotoolStream::GetMediaType(CMediaType* mediaType)
    {
        CheckPointer(mediaType, E_POINTER);
        FillFixedYuy2MediaType(mediaType);
        return S_OK;
    }

    HRESULT SurevideotoolStream::CheckMediaType(const CMediaType* mediaType)
    {
        return ValidateFixedYuy2MediaType(mediaType);
    }

    HRESULT SurevideotoolStream::OnThreadCreate()
    {
        nextFrameDue_ = std::chrono::steady_clock::now();
        return S_OK;
    }

    HRESULT SurevideotoolStream::SetMediaType(const CMediaType* mediaType)
    {
        CheckPointer(mediaType, E_POINTER);

        const HRESULT result = CSourceStream::SetMediaType(mediaType);
        if (FAILED(result))
        {
            return result;
        }

        {
            CAutoLock sampleLock(&sampleLock_);
            currentSubtype_ = MEDIASUBTYPE_YUY2;
            currentWidth_ = kFrameWidth;
            currentHeight_ = kFrameHeight;
            currentOutputStride_ = kYuy2StrideBytes;
            currentSampleBytes_ = static_cast<long>(kYuy2FrameBytes);
        }

        LogVirtualCameraEvent(L"Media type changed");
        return S_OK;
    }

    HRESULT SurevideotoolStream::OnThreadDestroy()
    {
        return S_OK;
    }

    HRESULT STDMETHODCALLTYPE SurevideotoolStream::Set(REFGUID, DWORD, LPVOID, DWORD, LPVOID, DWORD)
    {
        return E_NOTIMPL;
    }

    HRESULT STDMETHODCALLTYPE SurevideotoolStream::Get(
        REFGUID propertySet,
        DWORD propertyId,
        LPVOID,
        DWORD,
        LPVOID propertyData,
        DWORD propertyDataSize,
        DWORD* bytesReturned)
    {
        if (propertySet != AMPROPSETID_Pin)
        {
            return E_PROP_SET_UNSUPPORTED;
        }

        if (propertyId != AMPROPERTY_PIN_CATEGORY)
        {
            return E_PROP_ID_UNSUPPORTED;
        }

        if (propertyData == nullptr && bytesReturned == nullptr)
        {
            return E_POINTER;
        }

        if (bytesReturned != nullptr)
        {
            *bytesReturned = sizeof(GUID);
        }

        if (propertyData != nullptr)
        {
            if (propertyDataSize < sizeof(GUID))
            {
                return E_UNEXPECTED;
            }

            *reinterpret_cast<GUID*>(propertyData) = PIN_CATEGORY_CAPTURE;
        }

        return S_OK;
    }

    HRESULT STDMETHODCALLTYPE SurevideotoolStream::QuerySupported(REFGUID propertySet, DWORD propertyId, DWORD* typeSupport)
    {
        if (propertySet != AMPROPSETID_Pin)
        {
            return E_PROP_SET_UNSUPPORTED;
        }

        if (propertyId != AMPROPERTY_PIN_CATEGORY)
        {
            return E_PROP_ID_UNSUPPORTED;
        }

        if (typeSupport != nullptr)
        {
            *typeSupport = KSPROPERTY_SUPPORT_GET;
        }

        return S_OK;
    }

    HRESULT STDMETHODCALLTYPE SurevideotoolStream::SetFormat(AM_MEDIA_TYPE* mediaType)
    {
        CheckPointer(mediaType, E_POINTER);

        const HRESULT validationResult = ValidateFixedYuy2MediaType(mediaType);
        if (FAILED(validationResult))
        {
            return validationResult;
        }

        CMediaType requestedType(*mediaType);
        return SetMediaType(&requestedType);
    }

    HRESULT STDMETHODCALLTYPE SurevideotoolStream::GetFormat(AM_MEDIA_TYPE** mediaType)
    {
        return CreateFixedYuy2MediaType(mediaType);
    }

    HRESULT STDMETHODCALLTYPE SurevideotoolStream::GetNumberOfCapabilities(int* count, int* size)
    {
        if (count == nullptr || size == nullptr)
        {
            return E_POINTER;
        }

        *count = 1;
        *size = sizeof(VIDEO_STREAM_CONFIG_CAPS);
        return S_OK;
    }

    HRESULT STDMETHODCALLTYPE SurevideotoolStream::GetStreamCaps(int index, AM_MEDIA_TYPE** mediaType, BYTE* capabilities)
    {
        if (mediaType == nullptr || capabilities == nullptr)
        {
            return E_POINTER;
        }

        if (index != 0)
        {
            return S_FALSE;
        }

        HRESULT result = CreateFixedYuy2MediaType(mediaType);
        if (FAILED(result))
        {
            return result;
        }

        FillFixedVideoStreamCaps(reinterpret_cast<VIDEO_STREAM_CONFIG_CAPS*>(capabilities));
        return S_OK;
    }

    SurevideotoolFilter* SurevideotoolStream::GetParentFilter() const
    {
        return static_cast<SurevideotoolFilter*>(m_pFilter);
    }
}
