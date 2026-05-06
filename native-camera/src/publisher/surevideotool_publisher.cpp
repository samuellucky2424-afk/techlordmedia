#include "surevideotool/surevideotool_publisher.h"

#include <cstdio>
#include <cstring>
#include <sddl.h>
#include <winnt.h>

#include "surevideotool/surevideotool_ids.h"
#include "surevideotool/surevideotool_protocol.h"

namespace surevideotool
{
    namespace
    {
        constexpr DWORD kGlobalAttachRetryMs = 100;

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

        size_t ComputePayloadBytes(const PublisherConfig& config)
        {
            return static_cast<size_t>(config.stride) * static_cast<size_t>(config.height);
        }

        void LogPublisherDiagnostic(const char* message, HRESULT hr) noexcept
        {
            if (message == nullptr)
            {
                return;
            }

            std::fprintf(stderr, "[SurevideotoolPublisher] %s HRESULT=0x%08lX\n", message, static_cast<unsigned long>(hr));
            std::fflush(stderr);
        }

        HRESULT WaitForOwnedMutex(HANDLE mutex)
        {
            const DWORD waitResult = WaitForSingleObject(mutex, 2000);
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

        // Enable SeCreateGlobalPrivilege so this user-session process can create
        // Global\ named objects readable by the MF FrameServer in Session 0.
        // Administrators have this privilege in their token but it is disabled by
        // default; AdjustTokenPrivileges enables it without elevation.
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

        void CloseEndpoint(HANDLE* mapping, HANDLE* mutex, HANDLE* eventValue, void** view) noexcept
        {
            if (view != nullptr && *view != nullptr)
            {
                UnmapViewOfFile(*view);
                *view = nullptr;
            }

            if (eventValue != nullptr && *eventValue != nullptr)
            {
                CloseHandle(*eventValue);
                *eventValue = nullptr;
            }

            if (mutex != nullptr && *mutex != nullptr)
            {
                CloseHandle(*mutex);
                *mutex = nullptr;
            }

            if (mapping != nullptr && *mapping != nullptr)
            {
                CloseHandle(*mapping);
                *mapping = nullptr;
            }
        }

        void CloseFileBackedBridge(HANDLE* fileHandle, HANDLE* mapping, void** view) noexcept
        {
            if (view != nullptr && *view != nullptr)
            {
                UnmapViewOfFile(*view);
                *view = nullptr;
            }

            if (mapping != nullptr && *mapping != nullptr)
            {
                CloseHandle(*mapping);
                *mapping = nullptr;
            }

            if (fileHandle != nullptr && *fileHandle != nullptr && *fileHandle != INVALID_HANDLE_VALUE)
            {
                CloseHandle(*fileHandle);
                *fileHandle = nullptr;
            }
        }

        HRESULT InitializeEndpointHeader(
            HANDLE mutex,
            void* view,
            const PublisherConfig& config,
            size_t mappingByteCount,
            size_t payloadByteCount)
        {
            if (mutex == nullptr || view == nullptr)
            {
                return HRESULT_FROM_WIN32(ERROR_INVALID_HANDLE);
            }

            const HRESULT lockHr = WaitForOwnedMutex(mutex);
            if (FAILED(lockHr))
            {
                return lockHr;
            }

            auto unlock = [&]() noexcept
            {
                ReleaseMutex(mutex);
            };

            auto* header = static_cast<SharedFrameHeader*>(view);
            if (header == nullptr)
            {
                unlock();
                return HRESULT_FROM_WIN32(ERROR_INVALID_ADDRESS);
            }

            const bool needsReset =
                header->magic != kProtocolMagic ||
                header->version != kProtocolVersion ||
                header->width != config.width ||
                header->height != config.height ||
                header->stride != config.stride ||
                header->pixelFormat != kPixelFormatBgra32 ||
                header->fpsNumerator != config.fpsNumerator ||
                header->fpsDenominator != config.fpsDenominator ||
                header->payloadBytes != payloadByteCount;

            if (needsReset)
            {
                std::memset(view, 0, mappingByteCount);
                header->magic = kProtocolMagic;
                header->version = kProtocolVersion;
                header->width = config.width;
                header->height = config.height;
                header->stride = config.stride;
                header->pixelFormat = kPixelFormatBgra32;
                header->fpsNumerator = config.fpsNumerator;
                header->fpsDenominator = config.fpsDenominator;
                header->payloadBytes = static_cast<uint32_t>(payloadByteCount);
            }

            unlock();
            return S_OK;
        }

        HRESULT InitializeFileBridgeHeader(
            void* view,
            const PublisherConfig& config,
            size_t mappingByteCount,
            size_t payloadByteCount)
        {
            if (view == nullptr)
            {
                return HRESULT_FROM_WIN32(ERROR_INVALID_HANDLE);
            }

            auto* header = static_cast<SharedFrameHeader*>(view);
            if (header == nullptr)
            {
                return HRESULT_FROM_WIN32(ERROR_INVALID_ADDRESS);
            }

            const bool needsReset =
                header->magic != kProtocolMagic ||
                header->version != kProtocolVersion ||
                header->width != config.width ||
                header->height != config.height ||
                header->stride != config.stride ||
                header->pixelFormat != kPixelFormatBgra32 ||
                header->fpsNumerator != config.fpsNumerator ||
                header->fpsDenominator != config.fpsDenominator ||
                header->payloadBytes != payloadByteCount;

            if (needsReset)
            {
                std::memset(view, 0, mappingByteCount);
                header->magic = kProtocolMagic;
                header->version = kProtocolVersion;
                header->width = config.width;
                header->height = config.height;
                header->stride = config.stride;
                header->pixelFormat = kPixelFormatBgra32;
                header->fpsNumerator = config.fpsNumerator;
                header->fpsDenominator = config.fpsDenominator;
                header->payloadBytes = static_cast<uint32_t>(payloadByteCount);
                header->reserved = 0;
                header->frameCounter = 0;
                header->timestampHundredsOfNs = 0;
            }

            return S_OK;
        }

        HRESULT CreateEndpoint(
            const BridgeNames& names,
            const SECURITY_ATTRIBUTES* securityAttributes,
            const PublisherConfig& config,
            size_t mappingByteCount,
            size_t payloadByteCount,
            HANDLE* mapping,
            HANDLE* mutex,
            HANDLE* eventValue,
            void** view)
        {
            if (mapping == nullptr || mutex == nullptr || eventValue == nullptr || view == nullptr)
            {
                return E_POINTER;
            }

            ULARGE_INTEGER mappingSize{};
            mappingSize.QuadPart = static_cast<unsigned long long>(mappingByteCount);

            *mutex = CreateMutexW(const_cast<SECURITY_ATTRIBUTES*>(securityAttributes), FALSE, names.mutexName);
            if (*mutex == nullptr)
            {
                CloseEndpoint(mapping, mutex, eventValue, view);
                return HRESULT_FROM_WIN32(GetLastError());
            }

            *eventValue = CreateEventW(const_cast<SECURITY_ATTRIBUTES*>(securityAttributes), FALSE, FALSE, names.eventName);
            if (*eventValue == nullptr)
            {
                CloseEndpoint(mapping, mutex, eventValue, view);
                return HRESULT_FROM_WIN32(GetLastError());
            }

            *mapping = CreateFileMappingW(
                INVALID_HANDLE_VALUE,
                const_cast<SECURITY_ATTRIBUTES*>(securityAttributes),
                PAGE_READWRITE,
                mappingSize.HighPart,
                mappingSize.LowPart,
                names.mappingName);
            if (*mapping == nullptr)
            {
                CloseEndpoint(mapping, mutex, eventValue, view);
                return HRESULT_FROM_WIN32(GetLastError());
            }

            *view = MapViewOfFile(*mapping, FILE_MAP_ALL_ACCESS, 0, 0, mappingByteCount);
            if (*view == nullptr)
            {
                CloseEndpoint(mapping, mutex, eventValue, view);
                return HRESULT_FROM_WIN32(GetLastError());
            }

            return InitializeEndpointHeader(*mutex, *view, config, mappingByteCount, payloadByteCount);
        }

        HRESULT AttachExistingEndpoint(
            const BridgeNames& names,
            const PublisherConfig& config,
            size_t mappingByteCount,
            size_t payloadByteCount,
            HANDLE* mapping,
            HANDLE* mutex,
            HANDLE* eventValue,
            void** view)
        {
            if (mapping == nullptr || mutex == nullptr || eventValue == nullptr || view == nullptr)
            {
                return E_POINTER;
            }

            *mapping = OpenFileMappingW(FILE_MAP_ALL_ACCESS, FALSE, names.mappingName);
            if (*mapping == nullptr)
            {
                CloseEndpoint(mapping, mutex, eventValue, view);
                return HRESULT_FROM_WIN32(GetLastError());
            }

            *mutex = OpenMutexW(SYNCHRONIZE | MUTEX_MODIFY_STATE, FALSE, names.mutexName);
            if (*mutex == nullptr)
            {
                CloseEndpoint(mapping, mutex, eventValue, view);
                return HRESULT_FROM_WIN32(GetLastError());
            }

            *eventValue = OpenEventW(SYNCHRONIZE | EVENT_MODIFY_STATE, FALSE, names.eventName);
            if (*eventValue == nullptr)
            {
                CloseEndpoint(mapping, mutex, eventValue, view);
                return HRESULT_FROM_WIN32(GetLastError());
            }

            *view = MapViewOfFile(*mapping, FILE_MAP_ALL_ACCESS, 0, 0, mappingByteCount);
            if (*view == nullptr)
            {
                CloseEndpoint(mapping, mutex, eventValue, view);
                return HRESULT_FROM_WIN32(GetLastError());
            }

            return InitializeEndpointHeader(*mutex, *view, config, mappingByteCount, payloadByteCount);
        }

        HRESULT CreateFileBackedBridge(
            const SECURITY_ATTRIBUTES* securityAttributes,
            const PublisherConfig& config,
            size_t mappingByteCount,
            size_t payloadByteCount,
            HANDLE* fileHandle,
            HANDLE* mapping,
            void** view)
        {
            if (fileHandle == nullptr || mapping == nullptr || view == nullptr)
            {
                return E_POINTER;
            }

            const HRESULT directoryHr = EnsureBridgeDirectoryExists(kMfPublisherBridgeDirectoryPath);
            if (FAILED(directoryHr))
            {
                return directoryHr;
            }

            *fileHandle = CreateFileW(
                kMfPublisherBridgeFilePath,
                GENERIC_READ | GENERIC_WRITE,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                const_cast<SECURITY_ATTRIBUTES*>(securityAttributes),
                OPEN_ALWAYS,
                FILE_ATTRIBUTE_NORMAL,
                nullptr);
            if (*fileHandle == INVALID_HANDLE_VALUE)
            {
                *fileHandle = nullptr;
                return HRESULT_FROM_WIN32(GetLastError());
            }

            LARGE_INTEGER mappingSize{};
            mappingSize.QuadPart = static_cast<LONGLONG>(mappingByteCount);
            if (!SetFilePointerEx(*fileHandle, mappingSize, nullptr, FILE_BEGIN) || !SetEndOfFile(*fileHandle))
            {
                const HRESULT fileResizeHr = HRESULT_FROM_WIN32(GetLastError());
                CloseFileBackedBridge(fileHandle, mapping, view);
                return fileResizeHr;
            }

            *mapping = CreateFileMappingW(
                *fileHandle,
                const_cast<SECURITY_ATTRIBUTES*>(securityAttributes),
                PAGE_READWRITE,
                0,
                0,
                nullptr);
            if (*mapping == nullptr)
            {
                const HRESULT mappingHr = HRESULT_FROM_WIN32(GetLastError());
                CloseFileBackedBridge(fileHandle, mapping, view);
                return mappingHr;
            }

            *view = MapViewOfFile(*mapping, FILE_MAP_ALL_ACCESS, 0, 0, mappingByteCount);
            if (*view == nullptr)
            {
                const HRESULT viewHr = HRESULT_FROM_WIN32(GetLastError());
                CloseFileBackedBridge(fileHandle, mapping, view);
                return viewHr;
            }

            return InitializeFileBridgeHeader(*view, config, mappingByteCount, payloadByteCount);
        }

        HRESULT PublishFrameToEndpoint(
            HANDLE mutex,
            HANDLE eventValue,
            void* view,
            size_t payloadByteCount,
            const uint8_t* bgraFrame,
            size_t byteCount,
            int64_t timestampHundredsOfNs)
        {
            if (view == nullptr || mutex == nullptr || eventValue == nullptr)
            {
                return HRESULT_FROM_WIN32(ERROR_INVALID_HANDLE);
            }

            if (bgraFrame == nullptr || byteCount < payloadByteCount)
            {
                return E_INVALIDARG;
            }

            const HRESULT lockHr = WaitForOwnedMutex(mutex);
            if (FAILED(lockHr))
            {
                return lockHr;
            }

            auto* header = static_cast<SharedFrameHeader*>(view);
            auto* payload = reinterpret_cast<uint8_t*>(header + 1);
            std::memcpy(payload, bgraFrame, payloadByteCount);
            header->frameCounter += 1;
            header->timestampHundredsOfNs = timestampHundredsOfNs;
            ReleaseMutex(mutex);

            SetEvent(eventValue);
            return S_OK;
        }

        HRESULT PublishFrameToFileBridge(
            void* view,
            size_t payloadByteCount,
            const uint8_t* bgraFrame,
            size_t byteCount,
            int64_t timestampHundredsOfNs)
        {
            if (view == nullptr)
            {
                return HRESULT_FROM_WIN32(ERROR_INVALID_HANDLE);
            }

            if (bgraFrame == nullptr || byteCount < payloadByteCount)
            {
                return E_INVALIDARG;
            }

            auto* header = static_cast<SharedFrameHeader*>(view);
            if (header == nullptr)
            {
                return HRESULT_FROM_WIN32(ERROR_INVALID_ADDRESS);
            }

            auto* payload = reinterpret_cast<uint8_t*>(header + 1);
            auto* writeSequence = reinterpret_cast<volatile LONG*>(&header->reserved);
            auto* frameCounter = reinterpret_cast<volatile LONG64*>(&header->frameCounter);

            // Seqlock write protocol:
            //   1. Bump sequence to odd  → reader sees "write in progress", retries.
            //   2. Write payload + timestamp.
            //   3. Bump sequence to even → reader sees "write done", checks start==end.
            //   4. Bump frameCounter     → reader's "new frame" signal (outside lock).
            // frameCounter MUST be incremented AFTER the sequence is closed, otherwise
            // a reader that snapshots sequenceStart=even before the write begins will
            // see sequenceStart != sequenceEnd (old vs new) and always return S_FALSE.
            InterlockedIncrement(writeSequence);           // even → odd (writing)
            std::memcpy(payload, bgraFrame, payloadByteCount);
            header->timestampHundredsOfNs = timestampHundredsOfNs;
            MemoryBarrier();
            InterlockedIncrement(writeSequence);           // odd → even (done)
            MemoryBarrier();
            InterlockedIncrement64(frameCounter);          // signal new frame
            return S_OK;
        }
    }

    Publisher::~Publisher()
    {
        Close();
    }

    HRESULT Publisher::Open(const PublisherConfig& config)
    {
        if (mapping_ != nullptr)
        {
            return HRESULT_FROM_WIN32(ERROR_ALREADY_INITIALIZED);
        }

        if (config.width == 0 || config.height == 0 || config.fpsNumerator == 0 || config.fpsDenominator == 0)
        {
            return E_INVALIDARG;
        }

        if (config.stride < config.width * 4u)
        {
            return E_INVALIDARG;
        }

        payloadByteCount_ = ComputePayloadBytes(config);
        mappingByteCount_ = sizeof(SharedFrameHeader) + payloadByteCount_;
        if (payloadByteCount_ == 0 || mappingByteCount_ <= sizeof(SharedFrameHeader))
        {
            return E_INVALIDARG;
        }

        config_ = config;

        SecurityDescriptorHolder securityDescriptor;
        SECURITY_ATTRIBUTES securityAttributes{};
        const HRESULT securityHr = BuildBridgeSecurityAttributes(&securityAttributes, &securityDescriptor);
        if (FAILED(securityHr))
        {
            return securityHr;
        }

        const HRESULT createHr = CreateEndpoint(
            kLocalBridgeNames,
            &securityAttributes,
            config_,
            mappingByteCount_,
            payloadByteCount_,
            &mapping_,
            &mutex_,
            &event_,
            &view_);
        if (FAILED(createHr))
        {
            Close();
            return createHr;
        }

        const HRESULT fileBridgeHr = CreateFileBackedBridge(
            &securityAttributes,
            config_,
            mappingByteCount_,
            payloadByteCount_,
            &mfBridgeFile_,
            &mfBridgeMapping_,
            &mfBridgeView_);
        if (FAILED(fileBridgeHr))
        {
            LogPublisherDiagnostic("MF file bridge create failed; continuing with named-object bridges only.", fileBridgeHr);
            CloseFileBackedBridge(&mfBridgeFile_, &mfBridgeMapping_, &mfBridgeView_);
        }
        else
        {
            std::fprintf(stderr, "[SurevideotoolPublisher] MF file bridge ready.\n");
            std::fflush(stderr);
        }

        // Enable SeCreateGlobalPrivilege before creating Global\ objects.
        // Without this, CreateFileMapping/CreateMutex/CreateEvent with Global\ names
        // fail with ERROR_ACCESS_DENIED for standard user-session processes.
        TryEnableCreateGlobalPrivilege();

        // Proactively create (or open) the Global\ mapping so the MF virtual camera
        // source (hosted by Windows Camera FrameServer in Session 0) can read frames
        // immediately without waiting for the lazy-attach retry cycle.
        const HRESULT globalCreateHr = CreateEndpoint(
            kGlobalBridgeNames,
            &securityAttributes,
            config_,
            mappingByteCount_,
            payloadByteCount_,
            &globalMapping_,
            &globalMutex_,
            &globalEvent_,
            &globalView_);
        if (FAILED(globalCreateHr))
        {
            // Not fatal – Global\ access may be restricted; fall back to Local\ only.
            LogPublisherDiagnostic("Global bridge create failed; falling back to Local bridge only.", globalCreateHr);
            CloseEndpoint(&globalMapping_, &globalMutex_, &globalEvent_, &globalView_);
        }

        lastGlobalAttachAttemptTickMs_ = GetTickCount64();
        return S_OK;
    }

    HRESULT Publisher::PublishBgraFrame(const uint8_t* bgraFrame, size_t byteCount, int64_t timestampHundredsOfNs)
    {
        if (view_ == nullptr || mutex_ == nullptr || event_ == nullptr)
        {
            return HRESULT_FROM_WIN32(ERROR_INVALID_HANDLE);
        }

        bool publishedToAnyBridge = false;

        const HRESULT localHr = PublishFrameToEndpoint(
            mutex_,
            event_,
            view_,
            payloadByteCount_,
            bgraFrame,
            byteCount,
            timestampHundredsOfNs);
        if (FAILED(localHr))
        {
            LogPublisherDiagnostic("Local bridge publish failed; recreating Local handle set.", localHr);
            CloseEndpoint(&mapping_, &mutex_, &event_, &view_);

            SecurityDescriptorHolder securityDescriptor;
            SECURITY_ATTRIBUTES securityAttributes{};
            const HRESULT securityHr = BuildBridgeSecurityAttributes(&securityAttributes, &securityDescriptor);
            if (SUCCEEDED(securityHr))
            {
                const HRESULT recreateHr = CreateEndpoint(
                    kLocalBridgeNames,
                    &securityAttributes,
                    config_,
                    mappingByteCount_,
                    payloadByteCount_,
                    &mapping_,
                    &mutex_,
                    &event_,
                    &view_);
                if (FAILED(recreateHr))
                {
                    LogPublisherDiagnostic("Local bridge recreate failed.", recreateHr);
                }
            }
            else
            {
                LogPublisherDiagnostic("Local bridge security setup failed during recreate.", securityHr);
            }
        }
        else
        {
            publishedToAnyBridge = true;
        }

        if (mfBridgeView_ != nullptr)
        {
            const HRESULT fileBridgePublishHr = PublishFrameToFileBridge(
                mfBridgeView_,
                payloadByteCount_,
                bgraFrame,
                byteCount,
                timestampHundredsOfNs);
            if (FAILED(fileBridgePublishHr))
            {
                LogPublisherDiagnostic("MF file bridge publish failed; dropping file bridge handle set.", fileBridgePublishHr);
                CloseFileBackedBridge(&mfBridgeFile_, &mfBridgeMapping_, &mfBridgeView_);
            }
            else
            {
                publishedToAnyBridge = true;
            }
        }

        const ULONGLONG now = GetTickCount64();
        if (globalView_ == nullptr && (now - lastGlobalAttachAttemptTickMs_) >= kGlobalAttachRetryMs)
        {
            static HRESULT s_lastLoggedAttachHr = S_OK;
            static ULONGLONG s_lastAttachLogTickMs = 0;
            static bool s_loggedAttachSuccess = false;

            lastGlobalAttachAttemptTickMs_ = now;
            const HRESULT globalAttachHr = AttachExistingEndpoint(
                kGlobalBridgeNames,
                config_,
                mappingByteCount_,
                payloadByteCount_,
                &globalMapping_,
                &globalMutex_,
                &globalEvent_,
                &globalView_);
            if (FAILED(globalAttachHr))
            {
                if (globalAttachHr != s_lastLoggedAttachHr || (now - s_lastAttachLogTickMs) >= 2000)
                {
                    LogPublisherDiagnostic("Global bridge attach failed; retrying.", globalAttachHr);
                    s_lastLoggedAttachHr = globalAttachHr;
                    s_lastAttachLogTickMs = now;
                }
                CloseEndpoint(&globalMapping_, &globalMutex_, &globalEvent_, &globalView_);
            }
            else if (!s_loggedAttachSuccess)
            {
                std::fprintf(stderr, "[SurevideotoolPublisher] Global bridge attached successfully.\n");
                std::fflush(stderr);
                s_loggedAttachSuccess = true;
            }
        }

        if (globalView_ != nullptr)
        {
            const HRESULT globalHr = PublishFrameToEndpoint(
                globalMutex_,
                globalEvent_,
                globalView_,
                payloadByteCount_,
                bgraFrame,
                byteCount,
                timestampHundredsOfNs);
            if (FAILED(globalHr))
            {
                LogPublisherDiagnostic("Global bridge publish failed; dropping Global handle set.", globalHr);
                CloseEndpoint(&globalMapping_, &globalMutex_, &globalEvent_, &globalView_);
            }
            else
            {
                publishedToAnyBridge = true;
            }
        }

        return publishedToAnyBridge ? S_OK : HRESULT_FROM_WIN32(ERROR_INVALID_HANDLE);
    }

    void Publisher::Close()
    {
        CloseFileBackedBridge(&mfBridgeFile_, &mfBridgeMapping_, &mfBridgeView_);
        CloseEndpoint(&globalMapping_, &globalMutex_, &globalEvent_, &globalView_);
        CloseEndpoint(&mapping_, &mutex_, &event_, &view_);

        mappingByteCount_ = 0;
        payloadByteCount_ = 0;
        lastGlobalAttachAttemptTickMs_ = 0;
    }
}
