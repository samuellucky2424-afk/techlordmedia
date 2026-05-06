#include <windows.h>

#include <devpropdef.h>
#include <dshow.h>
#include <ks.h>
#include <ksmedia.h>
#include <mfapi.h>
#include <mfidl.h>
#include <mfreadwrite.h>
#include <mfvirtualcamera.h>
#include <objbase.h>
#include <olectl.h>
#include <shellapi.h>
#include <wrl/client.h>

#include <algorithm>
#include <array>
#include <cstring>
#include <filesystem>
#include <iostream>
#include <string>
#include <string_view>

#include "surevideotool/surevideotool_ids.h"

#ifndef RETURN_IF_FAILED
#define RETURN_IF_FAILED(expr) do { HRESULT _hr = (expr); if (FAILED(_hr)) return _hr; } while(0)
#endif

// DEVPROPKEY definitions for MF virtual camera creation
static const DEVPROPKEY DEVPKEY_DeviceInterface_VCamCreate_SourceId    = { {0x6ac1fbf7, 0x45f7, 0x4e06, {0xbd, 0xa7, 0xf8, 0x17, 0xeb, 0xfa, 0x04, 0xd1}}, 4 };
static const DEVPROPKEY DEVPKEY_DeviceInterface_VCamCreate_FriendlyName = { {0x6ac1fbf7, 0x45f7, 0x4e06, {0xbd, 0xa7, 0xf8, 0x17, 0xeb, 0xfa, 0x04, 0xd1}}, 5 };
static const DEVPROPKEY DEVPKEY_DeviceInterface_VCamCreate_Lifetime     = { {0x6ac1fbf7, 0x45f7, 0x4e06, {0xbd, 0xa7, 0xf8, 0x17, 0xeb, 0xfa, 0x04, 0xd1}}, 6 };
static const DEVPROPKEY DEVPKEY_DeviceInterface_VCamCreate_Access       = { {0x6ac1fbf7, 0x45f7, 0x4e06, {0xbd, 0xa7, 0xf8, 0x17, 0xeb, 0xfa, 0x04, 0xd1}}, 7 };

namespace
{
    using DllEntryProc = HRESULT(STDAPICALLTYPE*)();
    using MfCreateVirtualCameraProc = decltype(&MFCreateVirtualCamera);
    using RtlGetVersionProc = LONG(WINAPI*)(PRTL_OSVERSIONINFOW);
    using Microsoft::WRL::ComPtr;

    constexpr wchar_t kDirectShowDllName[] = L"SurevideotoolVirtualCamera.dll";
    constexpr wchar_t kWindowsVirtualCameraDllName[] = L"SurevideotoolVirtualCameraMF.dll";
    constexpr HRESULT kVirtualCameraAlreadyRemoved = static_cast<HRESULT>(0xC00D36B2);
    constexpr DWORD kVirtualCameraEnumerationTimeoutMs = 15000;
    constexpr DWORD kVirtualCameraEnumerationRetryIntervalMs = 250;
    constexpr DWORD kMinimumMfVirtualCameraBuild = 22000;

    constexpr GUID kLegacySurevideotoolSourceClsid =
    { 0x564d6611, 0x91f6, 0x4bf6, { 0xaf, 0x69, 0xde, 0xd5, 0x91, 0xc3, 0x35, 0x10 } };

    // Old Morphly DirectShow + MF source CLSIDs — kept here so the registrar can
    // clean up legacy installations on machines that previously had Morphly G1.
    constexpr GUID kLegacyMorphlyDShowClsid =
    { 0x6cb9df61, 0x861f, 0x4fc0, { 0x91, 0xeb, 0x43, 0xd2, 0x0d, 0x44, 0xd7, 0x91 } };
    constexpr GUID kLegacyMorphlyMfClsid =
    { 0xd8761762, 0x5f50, 0x4d3c, { 0xae, 0x97, 0x15, 0xbb, 0x07, 0x90, 0x4d, 0x9e } };
    constexpr GUID kLegacyFormatBoyDShowClsid =
    { 0x7e3a1d52, 0x6f8b, 0x4c2e, { 0xa5, 0xd9, 0x3b, 0x7e, 0x1f, 0x6c, 0x8d, 0x4a } };
    constexpr GUID kLegacyFormatBoyMfClsid =
    { 0x4f8b2e01, 0x3c7d, 0x4a9f, { 0xb6, 0xe2, 0x8d, 0x1c, 0x5a, 0x3f, 0x9b, 0x7e } };

    constexpr std::array<std::wstring_view, 7> kLegacyFriendlyNames =
    {
        L"Morphly Cam",
        L"Morphly Cam G1",
        L"Morphly G1",
        L"Morphly",
        L"Surevideotool",
        L"Format-Boy CAM",
        L"Format-Boy",
    };

    const std::array<GUID, 6> kLegacySourceClsids =
    {
        surevideotool::kVirtualCameraSourceClsid,
        kLegacySurevideotoolSourceClsid,
        kLegacyMorphlyDShowClsid,
        kLegacyMorphlyMfClsid,
        kLegacyFormatBoyDShowClsid,
        kLegacyFormatBoyMfClsid,
    };

    struct ComScope
    {
        explicit ComScope(DWORD flags)
            : result(CoInitializeEx(nullptr, flags))
        {
        }

        ~ComScope()
        {
            if (SUCCEEDED(result))
            {
                CoUninitialize();
            }
        }

        HRESULT result;
    };

    struct MfScope
    {
        MfScope()
            : result(MFStartup(MF_VERSION, MFSTARTUP_NOSOCKET))
        {
        }

        ~MfScope()
        {
            if (SUCCEEDED(result))
            {
                MFShutdown();
            }
        }

        HRESULT result;
    };

    std::wstring FormatHResult(HRESULT value)
    {
        wchar_t buffer[16]{};
        swprintf_s(buffer, L"0x%08X", static_cast<unsigned long>(value));
        return buffer;
    }

    std::wstring FormatGuid(const GUID& guid)
    {
        wchar_t buffer[64]{};
        if (StringFromGUID2(guid, buffer, ARRAYSIZE(buffer)) == 0)
        {
            return L"{00000000-0000-0000-0000-000000000000}";
        }

        return buffer;
    }

    std::wstring ConsumeAllocatedString(LPWSTR value)
    {
        const std::wstring result = value != nullptr ? value : L"";
        if (value != nullptr)
        {
            CoTaskMemFree(value);
        }

        return result;
    }

    void LogInfo(const std::wstring& message)
    {
        std::wcout << L"[INFO]  " << message << L'\n' << std::flush;
    }

    void LogSuccess(const std::wstring& message)
    {
        std::wcout << L"[OK]    " << message << L'\n' << std::flush;
    }

    void LogFailure(const std::wstring& message, HRESULT result = S_OK)
    {
        std::wcerr << L"[FAIL]  " << message;
        if (FAILED(result))
        {
            std::wcerr << L" (" << FormatHResult(result) << L')';
        }
        std::wcerr << L'\n' << std::flush;
    }

    HRESULT AddStringDeviceProperty(IMFVirtualCamera* camera, const DEVPROPKEY& key, const std::wstring& value)
    {
        if (camera == nullptr)
        {
            return E_POINTER;
        }

        return camera->AddProperty(
            &key,
            DEVPROP_TYPE_STRING,
            reinterpret_cast<const BYTE*>(value.c_str()),
            static_cast<ULONG>((value.size() + 1) * sizeof(wchar_t)));
    }

    HRESULT AddInt32DeviceProperty(IMFVirtualCamera* camera, const DEVPROPKEY& key, int32_t value)
    {
        if (camera == nullptr)
        {
            return E_POINTER;
        }

        return camera->AddProperty(
            &key,
            DEVPROP_TYPE_INT32,
            reinterpret_cast<const BYTE*>(&value),
            sizeof(value));
    }

    HRESULT ApplyStandardVirtualCameraProperties(
        IMFVirtualCamera* camera,
        const std::wstring& sourceId,
        const std::wstring& friendlyName,
        MFVirtualCameraLifetime lifetime,
        MFVirtualCameraAccess access)
    {
        RETURN_IF_FAILED(AddStringDeviceProperty(camera, DEVPKEY_DeviceInterface_VCamCreate_SourceId, sourceId));
        RETURN_IF_FAILED(AddStringDeviceProperty(camera, DEVPKEY_DeviceInterface_VCamCreate_FriendlyName, friendlyName));
        RETURN_IF_FAILED(AddInt32DeviceProperty(camera, DEVPKEY_DeviceInterface_VCamCreate_Lifetime, static_cast<int32_t>(lifetime)));
        RETURN_IF_FAILED(AddInt32DeviceProperty(camera, DEVPKEY_DeviceInterface_VCamCreate_Access, static_cast<int32_t>(access)));
        return S_OK;
    }

    bool IsRunningAsAdministrator()
    {
        BOOL isAdmin = FALSE;
        PSID adminGroup = nullptr;

        SID_IDENTIFIER_AUTHORITY authority = SECURITY_NT_AUTHORITY;
        if (AllocateAndInitializeSid(
                &authority,
                2,
                SECURITY_BUILTIN_DOMAIN_RID,
                DOMAIN_ALIAS_RID_ADMINS,
                0,
                0,
                0,
                0,
                0,
                0,
                &adminGroup))
        {
            CheckTokenMembership(nullptr, adminGroup, &isAdmin);
            FreeSid(adminGroup);
        }

        return isAdmin == TRUE;
    }

    int RelaunchAsAdministrator(int argc, wchar_t** argv)
    {
        std::wstring arguments;
        for (int index = 1; index < argc; ++index)
        {
            if (!arguments.empty())
            {
                arguments += L' ';
            }

            arguments += L'"';
            arguments += argv[index];
            arguments += L'"';
        }

        wchar_t executablePath[MAX_PATH]{};
        GetModuleFileNameW(nullptr, executablePath, ARRAYSIZE(executablePath));

        SHELLEXECUTEINFOW executeInfo{};
        executeInfo.cbSize = sizeof(executeInfo);
        executeInfo.fMask = SEE_MASK_NOCLOSEPROCESS;
        executeInfo.lpVerb = L"runas";
        executeInfo.lpFile = executablePath;
        executeInfo.lpParameters = arguments.c_str();
        executeInfo.nShow = SW_SHOWNORMAL;

        if (!ShellExecuteExW(&executeInfo))
        {
            const HRESULT result = HRESULT_FROM_WIN32(GetLastError());
            LogFailure(L"Unable to request elevation.", result);
            return 1;
        }

        DWORD exitCode = 1;
        if (executeInfo.hProcess != nullptr)
        {
            WaitForSingleObject(executeInfo.hProcess, INFINITE);
            GetExitCodeProcess(executeInfo.hProcess, &exitCode);
            CloseHandle(executeInfo.hProcess);
        }

        return static_cast<int>(exitCode);
    }

    std::filesystem::path GetProgramDataDirectory()
    {
        wchar_t programDataPath[MAX_PATH]{};
        const DWORD length = GetEnvironmentVariableW(L"ProgramData", programDataPath, ARRAYSIZE(programDataPath));
        if (length == 0 || length >= ARRAYSIZE(programDataPath))
        {
            return std::filesystem::path(L"C:\\ProgramData") / L"Surevideotool";
        }

        return std::filesystem::path(programDataPath) / L"Surevideotool";
    }

    std::filesystem::path GetLocalBinaryPath(const wchar_t* fileName)
    {
        wchar_t executablePath[MAX_PATH]{};
        GetModuleFileNameW(nullptr, executablePath, ARRAYSIZE(executablePath));
        return std::filesystem::path(executablePath).parent_path() / fileName;
    }

    HRESULT EnsureStagedBinary(const wchar_t* fileName, std::filesystem::path* stagedPath)
    {
        if (stagedPath == nullptr)
        {
            return E_POINTER;
        }

        const std::filesystem::path sourcePath = GetLocalBinaryPath(fileName);
        if (!std::filesystem::exists(sourcePath))
        {
            return HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND);
        }

        const std::filesystem::path targetDirectory = GetProgramDataDirectory();
        const std::filesystem::path targetPath = targetDirectory / fileName;

        std::error_code error;
        std::filesystem::create_directories(targetDirectory, error);
        if (error)
        {
            return HRESULT_FROM_WIN32(static_cast<DWORD>(error.value()));
        }

        std::filesystem::copy_file(
            sourcePath,
            targetPath,
            std::filesystem::copy_options::overwrite_existing,
            error);
        if (error)
        {
            const HRESULT copyResult = HRESULT_FROM_WIN32(static_cast<DWORD>(error.value()));
            if (copyResult == HRESULT_FROM_WIN32(ERROR_SHARING_VIOLATION) && std::filesystem::exists(targetPath))
            {
                LogInfo(
                    std::wstring(L"Staged binary is already in use; reusing existing copy for ") +
                    fileName +
                    L" because " +
                    FormatHResult(copyResult));
                *stagedPath = targetPath;
                return S_OK;
            }

            return copyResult;
        }

        *stagedPath = targetPath;
        return S_OK;
    }

    std::filesystem::path ResolveBinaryForUnregister(const wchar_t* fileName)
    {
        const std::filesystem::path stagedPath = GetProgramDataDirectory() / fileName;
        if (std::filesystem::exists(stagedPath))
        {
            return stagedPath;
        }

        return GetLocalBinaryPath(fileName);
    }

    HRESULT InvokeDllEntryPoint(const std::filesystem::path& dllPath, const char* procedureName)
    {
        const HMODULE moduleHandle = LoadLibraryW(dllPath.c_str());
        if (moduleHandle == nullptr)
        {
            return HRESULT_FROM_WIN32(GetLastError());
        }

        const auto procedure = reinterpret_cast<DllEntryProc>(GetProcAddress(moduleHandle, procedureName));
        if (procedure == nullptr)
        {
            const HRESULT result = HRESULT_FROM_WIN32(GetLastError());
            FreeLibrary(moduleHandle);
            return result;
        }

        const HRESULT result = procedure();
        FreeLibrary(moduleHandle);
        return result;
    }

    HRESULT InvokeRegisteredBinary(const wchar_t* fileName, const char* procedureName, bool stageBinary)
    {
        std::filesystem::path dllPath;
        HRESULT result = S_OK;

        if (stageBinary)
        {
            result = EnsureStagedBinary(fileName, &dllPath);
            if (FAILED(result))
            {
                return result;
            }
        }
        else
        {
            dllPath = ResolveBinaryForUnregister(fileName);
            if (!std::filesystem::exists(dllPath))
            {
                return S_OK;
            }
        }

        LogInfo(std::wstring(L"Invoking ") + std::wstring(fileName) + L"!" + std::wstring(procedureName, procedureName + std::strlen(procedureName)));
        return InvokeDllEntryPoint(dllPath, procedureName);
    }

    HRESULT InvokeLocalBinary(const wchar_t* fileName, const char* procedureName)
    {
        const std::filesystem::path dllPath = GetLocalBinaryPath(fileName);
        if (!std::filesystem::exists(dllPath))
        {
            return HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND);
        }

        LogInfo(std::wstring(L"Invoking local ") + std::wstring(fileName) + L"!" + std::wstring(procedureName, procedureName + std::strlen(procedureName)));
        return InvokeDllEntryPoint(dllPath, procedureName);
    }

    MfCreateVirtualCameraProc ResolveMfCreateVirtualCameraProc()
    {
        static HMODULE moduleHandle = LoadLibraryW(L"mfsensorgroup.dll");
        static const MfCreateVirtualCameraProc procedure = moduleHandle != nullptr
            ? reinterpret_cast<MfCreateVirtualCameraProc>(GetProcAddress(moduleHandle, "MFCreateVirtualCamera"))
            : nullptr;
        return procedure;
    }

    bool SupportsWindowsVirtualCameraApi()
    {
        if (ResolveMfCreateVirtualCameraProc() == nullptr)
        {
            return false;
        }

        const HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
        const auto rtlGetVersion = ntdll != nullptr
            ? reinterpret_cast<RtlGetVersionProc>(GetProcAddress(ntdll, "RtlGetVersion"))
            : nullptr;

        if (rtlGetVersion == nullptr)
        {
            return false;
        }

        OSVERSIONINFOW version{};
        version.dwOSVersionInfoSize = sizeof(version);
        if (rtlGetVersion(&version) != 0)
        {
            return false;
        }

        return version.dwBuildNumber >= kMinimumMfVirtualCameraBuild;
    }

    bool IsBenignCameraRemovalResult(HRESULT result)
    {
        return result == S_OK ||
            result == kVirtualCameraAlreadyRemoved ||
            result == HRESULT_FROM_WIN32(ERROR_NOT_FOUND) ||
            result == HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND) ||
            result == HRESULT_FROM_WIN32(ERROR_PATH_NOT_FOUND) ||
            result == HRESULT_FROM_WIN32(ERROR_SHARING_VIOLATION); // camera in use; safe to skip
    }

    HRESULT OpenWindowsVirtualCameraWithOptions(
        const wchar_t* friendlyName,
        const GUID& sourceClsid,
        MFVirtualCameraLifetime lifetime,
        MFVirtualCameraAccess access,
        const GUID* categories,
        ULONG categoryCount,
        IMFVirtualCamera** camera)
    {
        if (camera == nullptr)
        {
            return E_POINTER;
        }

        *camera = nullptr;

        const std::wstring sourceId = FormatGuid(sourceClsid);
        const auto createVirtualCamera = ResolveMfCreateVirtualCameraProc();
        if (createVirtualCamera == nullptr)
        {
            return HRESULT_FROM_WIN32(ERROR_PROC_NOT_FOUND);
        }

        return createVirtualCamera(
            MFVirtualCameraType_SoftwareCameraSource,
            lifetime,
            access,
            friendlyName,
            sourceId.c_str(),
            categories,
            categoryCount,
            camera);
    }

    HRESULT OpenWindowsVirtualCamera(const wchar_t* friendlyName, const GUID& sourceClsid, IMFVirtualCamera** camera)
    {
        return OpenWindowsVirtualCameraWithOptions(
            friendlyName,
            sourceClsid,
            MFVirtualCameraLifetime_System,
            MFVirtualCameraAccess_CurrentUser,
            nullptr,
            0,
            camera);
    }

    HRESULT OpenWindowsVirtualCameraVariant(
        const wchar_t* friendlyName,
        const GUID& sourceClsid,
        MFVirtualCameraAccess access,
        bool useExplicitCategories,
        IMFVirtualCamera** camera)
    {
        static const GUID categories[] =
        {
            KSCATEGORY_VIDEO_CAMERA,
            KSCATEGORY_VIDEO,
            KSCATEGORY_CAPTURE,
        };

        return OpenWindowsVirtualCameraWithOptions(
            friendlyName,
            sourceClsid,
            MFVirtualCameraLifetime_System,
            access,
            useExplicitCategories ? categories : nullptr,
            useExplicitCategories ? ARRAYSIZE(categories) : 0,
            camera);
    }

    void ReleaseActivateArray(IMFActivate** activates, UINT32 count)
    {
        if (activates == nullptr)
        {
            return;
        }

        for (UINT32 index = 0; index < count; ++index)
        {
            if (activates[index] != nullptr)
            {
                activates[index]->Release();
            }
        }

        CoTaskMemFree(activates);
    }

    HRESULT EnumerateVideoCaptureDevices(IMFActivate*** activates, UINT32* count)
    {
        if (activates == nullptr || count == nullptr)
        {
            return E_POINTER;
        }

        *activates = nullptr;
        *count = 0;

        ComPtr<IMFAttributes> attributes;
        RETURN_IF_FAILED(MFCreateAttributes(&attributes, 2));
        RETURN_IF_FAILED(attributes->SetGUID(MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE, MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_GUID));
        RETURN_IF_FAILED(attributes->SetGUID(MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_CATEGORY, KSCATEGORY_VIDEO_CAMERA));
        return MFEnumDeviceSources(attributes.Get(), activates, count);
    }

    void LogEnumeratedVideoCaptureDevices()
    {
        IMFActivate** activates = nullptr;
        UINT32 count = 0;
        const HRESULT result = EnumerateVideoCaptureDevices(&activates, &count);
        if (FAILED(result))
        {
            LogFailure(L"Unable to enumerate Media Foundation video capture devices.", result);
            return;
        }

        LogInfo(L"Media Foundation video capture device count: " + std::to_wstring(count));

        for (UINT32 index = 0; index < count; ++index)
        {
            UINT32 friendlyNameLength = 0;
            UINT32 symbolicLinkLength = 0;
            LPWSTR friendlyNameRaw = nullptr;
            LPWSTR symbolicLinkRaw = nullptr;

            const HRESULT friendlyNameResult = activates[index]->GetAllocatedString(
                MF_DEVSOURCE_ATTRIBUTE_FRIENDLY_NAME,
                &friendlyNameRaw,
                &friendlyNameLength);
            const HRESULT symbolicLinkResult = activates[index]->GetAllocatedString(
                MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_SYMBOLIC_LINK,
                &symbolicLinkRaw,
                &symbolicLinkLength);

            const std::wstring friendlyName = SUCCEEDED(friendlyNameResult)
                ? ConsumeAllocatedString(friendlyNameRaw)
                : L"<unavailable>";
            const std::wstring symbolicLink = SUCCEEDED(symbolicLinkResult)
                ? ConsumeAllocatedString(symbolicLinkRaw)
                : L"<unavailable>";

            LogInfo(
                L"  [" +
                std::to_wstring(index) +
                L"] " +
                friendlyName +
                L" | " +
                symbolicLink);
        }

        ReleaseActivateArray(activates, count);
    }

    HRESULT FindCameraActivateBySymbolicLink(const wchar_t* symbolicLink, IMFActivate** activate)
    {
        if (symbolicLink == nullptr || activate == nullptr)
        {
            return E_POINTER;
        }

        *activate = nullptr;

        IMFActivate** activates = nullptr;
        UINT32 count = 0;
        HRESULT result = EnumerateVideoCaptureDevices(&activates, &count);
        if (FAILED(result))
        {
            return result;
        }

        for (UINT32 index = 0; index < count; ++index)
        {
            UINT32 symbolicLinkLength = 0;
            LPWSTR symbolicLinkRaw = nullptr;
            result = activates[index]->GetAllocatedString(
                MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_SYMBOLIC_LINK,
                &symbolicLinkRaw,
                &symbolicLinkLength);
            const std::wstring currentSymbolicLink = SUCCEEDED(result)
                ? ConsumeAllocatedString(symbolicLinkRaw)
                : L"";

            if (SUCCEEDED(result) && _wcsicmp(currentSymbolicLink.c_str(), symbolicLink) == 0)
            {
                result = activates[index]->QueryInterface(IID_PPV_ARGS(activate));
                ReleaseActivateArray(activates, count);
                return result;
            }
        }

        ReleaseActivateArray(activates, count);
        return HRESULT_FROM_WIN32(ERROR_NOT_FOUND);
    }

    HRESULT FindCameraActivateByFriendlyNameFragment(const wchar_t* friendlyNameFragment, IMFActivate** activate)
    {
        if (friendlyNameFragment == nullptr || activate == nullptr)
        {
            return E_POINTER;
        }

        *activate = nullptr;

        IMFActivate** activates = nullptr;
        UINT32 count = 0;
        HRESULT result = EnumerateVideoCaptureDevices(&activates, &count);
        if (FAILED(result))
        {
            return result;
        }

        for (UINT32 index = 0; index < count; ++index)
        {
            UINT32 friendlyNameLength = 0;
            LPWSTR friendlyNameRaw = nullptr;
            result = activates[index]->GetAllocatedString(
                MF_DEVSOURCE_ATTRIBUTE_FRIENDLY_NAME,
                &friendlyNameRaw,
                &friendlyNameLength);
            const std::wstring currentFriendlyName = SUCCEEDED(result)
                ? ConsumeAllocatedString(friendlyNameRaw)
                : L"";

            if (SUCCEEDED(result) && [&]() {
                    std::wstring haystack = currentFriendlyName;
                    std::wstring needle = friendlyNameFragment;
                    std::transform(haystack.begin(), haystack.end(), haystack.begin(), ::towlower);
                    std::transform(needle.begin(), needle.end(), needle.begin(), ::towlower);
                    return haystack.find(needle) != std::wstring::npos;
                }())
            {
                result = activates[index]->QueryInterface(IID_PPV_ARGS(activate));
                ReleaseActivateArray(activates, count);
                return result;
            }
        }

        ReleaseActivateArray(activates, count);
        return HRESULT_FROM_WIN32(ERROR_NOT_FOUND);
    }

    HRESULT GetVirtualCameraIdentity(IMFVirtualCamera* camera, std::wstring* symbolicLink, std::wstring* friendlyName)
    {
        if (camera == nullptr || symbolicLink == nullptr || friendlyName == nullptr)
        {
            return E_POINTER;
        }

        *symbolicLink = L"";
        *friendlyName = L"";

        UINT32 stringLength = 0;
        LPWSTR symbolicLinkRaw = nullptr;
        RETURN_IF_FAILED(camera->GetAllocatedString(
            MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_SYMBOLIC_LINK,
            &symbolicLinkRaw,
            &stringLength));
        *symbolicLink = ConsumeAllocatedString(symbolicLinkRaw);

        LPWSTR friendlyNameRaw = nullptr;
        RETURN_IF_FAILED(camera->GetAllocatedString(
            MF_DEVSOURCE_ATTRIBUTE_FRIENDLY_NAME,
            &friendlyNameRaw,
            &stringLength));
        *friendlyName = ConsumeAllocatedString(friendlyNameRaw);

        return S_OK;
    }

    HRESULT WaitForVirtualCameraEnumeration(const std::wstring& symbolicLink)
    {
        const ULONGLONG deadline = GetTickCount64() + kVirtualCameraEnumerationTimeoutMs;
        HRESULT lastResult = HRESULT_FROM_WIN32(ERROR_NOT_FOUND);

        do
        {
            ComPtr<IMFActivate> activate;
            lastResult = FindCameraActivateBySymbolicLink(symbolicLink.c_str(), &activate);
            if (SUCCEEDED(lastResult))
            {
                return S_OK;
            }

            Sleep(kVirtualCameraEnumerationRetryIntervalMs);
        } while (GetTickCount64() < deadline);

        return lastResult;
    }

    HRESULT ValidateVirtualCamera(IMFVirtualCamera* camera)
    {
        if (camera == nullptr)
        {
            return E_POINTER;
        }

        LogInfo(L"Getting virtual camera media source...");
        ComPtr<IMFMediaSource> mediaSource;
        RETURN_IF_FAILED(camera->GetMediaSource(&mediaSource));
        LogSuccess(L"Virtual camera media source activated.");

        std::wstring symbolicLink;
        std::wstring friendlyName;
        RETURN_IF_FAILED(GetVirtualCameraIdentity(camera, &symbolicLink, &friendlyName));
        LogInfo(L"Virtual camera symbolic link: " + symbolicLink);
        LogInfo(L"Virtual camera friendly name: " + friendlyName);

        LogInfo(L"Waiting for the virtual camera to appear in Media Foundation enumeration...");
        const HRESULT enumerationResult = WaitForVirtualCameraEnumeration(symbolicLink);
        if (FAILED(enumerationResult))
        {
            LogFailure(L"Virtual camera did not appear in Media Foundation enumeration.", enumerationResult);
            LogEnumeratedVideoCaptureDevices();
            return enumerationResult;
        }

        LogSuccess(L"Virtual camera is present in Media Foundation device enumeration.");
        return S_OK;
    }

    HRESULT RemoveVirtualCameraVariant(
        const wchar_t* friendlyName,
        const GUID& sourceClsid,
        MFVirtualCameraAccess access,
        bool useExplicitCategories)
    {
        ComPtr<IMFVirtualCamera> camera;
        HRESULT result = OpenWindowsVirtualCameraVariant(
            friendlyName,
            sourceClsid,
            access,
            useExplicitCategories,
            &camera);
        if (FAILED(result))
        {
            return result;
        }

        result = camera->Remove();
        camera->Shutdown();
        return result;
    }

    HRESULT RemoveVirtualCameraByIdentity(const wchar_t* friendlyName, const GUID& sourceClsid)
    {
        HRESULT firstNonBenignResult = S_OK;
        bool hasNonBenignResult = false;

        const MFVirtualCameraAccess accessVariants[] =
        {
            MFVirtualCameraAccess_CurrentUser,
            MFVirtualCameraAccess_AllUsers,
        };

        const bool categoryVariants[] = { false, true };

        for (const MFVirtualCameraAccess access : accessVariants)
        {
            for (const bool useExplicitCategories : categoryVariants)
            {
                const HRESULT result = RemoveVirtualCameraVariant(
                    friendlyName,
                    sourceClsid,
                    access,
                    useExplicitCategories);

                if (FAILED(result) && !IsBenignCameraRemovalResult(result) && !hasNonBenignResult)
                {
                    firstNonBenignResult = result;
                    hasNonBenignResult = true;
                }
            }
        }

        return hasNonBenignResult ? firstNonBenignResult : S_OK;
    }

    void CleanupLegacyWindowsVirtualCameras()
    {
        for (const auto& friendlyName : kLegacyFriendlyNames)
        {
            for (const GUID& sourceClsid : kLegacySourceClsids)
            {
                const HRESULT result = RemoveVirtualCameraByIdentity(friendlyName.data(), sourceClsid);
                if (FAILED(result) && !IsBenignCameraRemovalResult(result))
                {
                    LogInfo(
                        std::wstring(L"Legacy camera cleanup skipped for \"") +
                        std::wstring(friendlyName) +
                        L"\" / " +
                        FormatGuid(sourceClsid) +
                        L" because " +
                        FormatHResult(result));
                }
            }
        }
    }

    HRESULT ProbeRegisteredDirectShowCamera()
    {
        ComScope com(COINIT_MULTITHREADED);
        if (FAILED(com.result) && com.result != RPC_E_CHANGED_MODE)
        {
            return com.result;
        }

        wchar_t expectedClsid[64]{};
        if (StringFromGUID2(surevideotool::kVirtualCameraSourceClsid, expectedClsid, ARRAYSIZE(expectedClsid)) == 0)
        {
            return E_FAIL;
        }

        ICreateDevEnum* deviceEnumerator = nullptr;
        HRESULT result = CoCreateInstance(
            CLSID_SystemDeviceEnum,
            nullptr,
            CLSCTX_INPROC_SERVER,
            IID_ICreateDevEnum,
            reinterpret_cast<void**>(&deviceEnumerator));
        if (FAILED(result))
        {
            return result;
        }

        IEnumMoniker* monikerEnumerator = nullptr;
        result = deviceEnumerator->CreateClassEnumerator(
            CLSID_VideoInputDeviceCategory,
            &monikerEnumerator,
            0);
        deviceEnumerator->Release();

        if (result != S_OK || monikerEnumerator == nullptr)
        {
            return result == S_FALSE ? HRESULT_FROM_WIN32(ERROR_NOT_FOUND) : result;
        }

        IMoniker* moniker = nullptr;
        ULONG fetched = 0;
        while (monikerEnumerator->Next(1, &moniker, &fetched) == S_OK)
        {
            IPropertyBag* propertyBag = nullptr;
            result = moniker->BindToStorage(nullptr, nullptr, IID_IPropertyBag, reinterpret_cast<void**>(&propertyBag));
            if (SUCCEEDED(result))
            {
                VARIANT friendlyNameValue{};
                VARIANT clsidValue{};
                VariantInit(&friendlyNameValue);
                VariantInit(&clsidValue);

                const bool hasFriendlyName =
                    SUCCEEDED(propertyBag->Read(L"FriendlyName", &friendlyNameValue, nullptr)) &&
                    friendlyNameValue.vt == VT_BSTR &&
                    friendlyNameValue.bstrVal != nullptr &&
                    std::wstring(friendlyNameValue.bstrVal) == surevideotool::kVirtualCameraFriendlyName;

                const bool hasMatchingClsid =
                    SUCCEEDED(propertyBag->Read(L"CLSID", &clsidValue, nullptr)) &&
                    clsidValue.vt == VT_BSTR &&
                    clsidValue.bstrVal != nullptr &&
                    _wcsicmp(clsidValue.bstrVal, expectedClsid) == 0;

                VariantClear(&friendlyNameValue);
                VariantClear(&clsidValue);
                propertyBag->Release();

                if (hasFriendlyName && hasMatchingClsid)
                {
                    moniker->Release();
                    monikerEnumerator->Release();
                    return S_OK;
                }
            }

            moniker->Release();
        }

        monikerEnumerator->Release();
        return HRESULT_FROM_WIN32(ERROR_NOT_FOUND);
    }

    HRESULT ProbeRegisteredWindowsSource()
    {
        ComScope com(COINIT_MULTITHREADED);
        if (FAILED(com.result) && com.result != RPC_E_CHANGED_MODE)
        {
            return com.result;
        }

        IMFActivate* activate = nullptr;
        const HRESULT result = CoCreateInstance(
            surevideotool::kWindowsVirtualCameraSourceClsid,
            nullptr,
            CLSCTX_INPROC_SERVER,
            __uuidof(IMFActivate),
            reinterpret_cast<void**>(&activate));
        if (SUCCEEDED(result) && activate != nullptr)
        {
            activate->Release();
        }

        return result;
    }

    HRESULT ProbeEnumeratedWindowsVirtualCamera()
    {
        ComScope com(COINIT_MULTITHREADED);
        if (FAILED(com.result) && com.result != RPC_E_CHANGED_MODE)
        {
            return com.result;
        }

        ComPtr<IMFActivate> activate;
        const HRESULT result = FindCameraActivateByFriendlyNameFragment(surevideotool::kVirtualCameraFriendlyName, &activate);
        if (FAILED(result))
        {
            LogInfo(std::wstring(L"No Media Foundation video capture device containing \"") + surevideotool::kVirtualCameraFriendlyName + L"\" was found.");
            LogEnumeratedVideoCaptureDevices();
        }

        return result;
    }

    HRESULT ListWindowsVideoCaptureDevices()
    {
        ComScope com(COINIT_MULTITHREADED);
        if (FAILED(com.result) && com.result != RPC_E_CHANGED_MODE)
        {
            return com.result;
        }

        MfScope mf;
        if (FAILED(mf.result))
        {
            return mf.result;
        }

        LogEnumeratedVideoCaptureDevices();
        return S_OK;
    }

    HRESULT ReadSampleFromMediaSource(IMFMediaSource* mediaSource)
    {
        if (mediaSource == nullptr)
        {
            return E_POINTER;
        }

        ComPtr<IMFAttributes> readerAttributes;
        RETURN_IF_FAILED(MFCreateAttributes(&readerAttributes, 1));
        RETURN_IF_FAILED(readerAttributes->SetUINT32(MF_READWRITE_DISABLE_CONVERTERS, FALSE));

        ComPtr<IMFSourceReader> reader;
        RETURN_IF_FAILED(MFCreateSourceReaderFromMediaSource(
            mediaSource,
            readerAttributes.Get(),
            &reader));

        ComPtr<IMFMediaType> requestedType;
        if (SUCCEEDED(MFCreateMediaType(&requestedType)))
        {
            requestedType->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
            requestedType->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_RGB32);
            const HRESULT mediaTypeResult = reader->SetCurrentMediaType(
                MF_SOURCE_READER_FIRST_VIDEO_STREAM,
                nullptr,
                requestedType.Get());
            if (FAILED(mediaTypeResult))
            {
                LogInfo(std::wstring(L"RGB32 media type request was not accepted; continuing with default type because ") + FormatHResult(mediaTypeResult));
            }
        }

        RETURN_IF_FAILED(reader->SetStreamSelection(MF_SOURCE_READER_FIRST_VIDEO_STREAM, TRUE));

        for (int attempt = 1; attempt <= 30; ++attempt)
        {
            DWORD streamIndex = 0;
            DWORD flags = 0;
            LONGLONG timestamp = 0;
            ComPtr<IMFSample> sample;
            const HRESULT readResult = reader->ReadSample(
                MF_SOURCE_READER_FIRST_VIDEO_STREAM,
                0,
                &streamIndex,
                &flags,
                &timestamp,
                &sample);
            if (FAILED(readResult))
            {
                return readResult;
            }

            if ((flags & MF_SOURCE_READERF_ERROR) != 0)
            {
                return E_FAIL;
            }

            if (sample)
            {
                DWORD totalLength = 0;
                sample->GetTotalLength(&totalLength);
                LogSuccess(
                    L"Read Surevideotool sample: bytes=" +
                    std::to_wstring(totalLength) +
                    L", timestamp=" +
                    std::to_wstring(timestamp));
                return S_OK;
            }

            Sleep(100);
        }

        return HRESULT_FROM_WIN32(WAIT_TIMEOUT);
    }

    HRESULT ProbeRegisteredWindowsSourceSample()
    {
        ComScope com(COINIT_MULTITHREADED);
        if (FAILED(com.result) && com.result != RPC_E_CHANGED_MODE)
        {
            return com.result;
        }

        MfScope mf;
        if (FAILED(mf.result))
        {
            return mf.result;
        }

        LogInfo(L"Creating registered Surevideotool COM media-source activator...");
        ComPtr<IMFActivate> activate;
        RETURN_IF_FAILED(CoCreateInstance(
            surevideotool::kWindowsVirtualCameraSourceClsid,
            nullptr,
            CLSCTX_INPROC_SERVER,
            IID_PPV_ARGS(&activate)));

        LogInfo(L"Activating registered Surevideotool COM media source...");
        ComPtr<IMFMediaSource> mediaSource;
        RETURN_IF_FAILED(activate->ActivateObject(IID_PPV_ARGS(&mediaSource)));

        const HRESULT result = ReadSampleFromMediaSource(mediaSource.Get());
        mediaSource->Shutdown();
        activate->ShutdownObject();
        return result;
    }

    HRESULT ProbeWindowsCameraSampleByFriendlyNameFragment(const wchar_t* friendlyNameFragment)
    {
        ComScope com(COINIT_MULTITHREADED);
        if (FAILED(com.result) && com.result != RPC_E_CHANGED_MODE)
        {
            return com.result;
        }

        MfScope mf;
        if (FAILED(mf.result))
        {
            return mf.result;
        }

        LogEnumeratedVideoCaptureDevices();

        ComPtr<IMFActivate> activate;
        RETURN_IF_FAILED(FindCameraActivateByFriendlyNameFragment(
            friendlyNameFragment,
            &activate));

        LogInfo(std::wstring(L"Activating Media Foundation source containing \"") + friendlyNameFragment + L"\"...");
        ComPtr<IMFMediaSource> mediaSource;
        RETURN_IF_FAILED(activate->ActivateObject(IID_PPV_ARGS(&mediaSource)));

        const HRESULT result = ReadSampleFromMediaSource(mediaSource.Get());
        mediaSource->Shutdown();
        activate->ShutdownObject();
        return result;
    }

    HRESULT ProbeWindowsVirtualCameraSample()
    {
        return ProbeWindowsCameraSampleByFriendlyNameFragment(surevideotool::kVirtualCameraFriendlyName);
    }

    HRESULT ProbePhysicalHpCameraSample()
    {
        return ProbeWindowsCameraSampleByFriendlyNameFragment(L"HP HD Camera");
    }

    HRESULT InstallCamera()
    {
        ComScope com(COINIT_MULTITHREADED);
        if (FAILED(com.result) && com.result != RPC_E_CHANGED_MODE)
        {
            return com.result;
        }

        HRESULT result = InvokeRegisteredBinary(kDirectShowDllName, "DllRegisterServer", true);
        if (FAILED(result))
        {
            return result;
        }

        if (!SupportsWindowsVirtualCameraApi())
        {
            LogInfo(L"Windows Media Foundation virtual camera APIs are unavailable on this Windows build. DirectShow fallback registration will be used.");
            return ProbeRegisteredDirectShowCamera();
        }

        result = InvokeRegisteredBinary(kWindowsVirtualCameraDllName, "DllRegisterServer", true);
        if (FAILED(result))
        {
            return result;
        }

        MfScope mf;
        if (FAILED(mf.result))
        {
            return mf.result;
        }

        const HRESULT removeCurrentResult = RemoveVirtualCameraByIdentity(
            surevideotool::kVirtualCameraFriendlyName,
            surevideotool::kWindowsVirtualCameraSourceClsid);
        if (FAILED(removeCurrentResult) && !IsBenignCameraRemovalResult(removeCurrentResult))
        {
            LogInfo(std::wstring(L"Current Windows virtual camera cleanup skipped because ") + FormatHResult(removeCurrentResult));
        }

        CleanupLegacyWindowsVirtualCameras();

        ComPtr<IMFVirtualCamera> camera;
        result = OpenWindowsVirtualCamera(
            surevideotool::kVirtualCameraFriendlyName,
            surevideotool::kWindowsVirtualCameraSourceClsid,
            &camera);
        if (FAILED(result))
        {
            return result;
        }

        result = ApplyStandardVirtualCameraProperties(
            camera.Get(),
            FormatGuid(surevideotool::kWindowsVirtualCameraSourceClsid),
            surevideotool::kVirtualCameraFriendlyName,
            MFVirtualCameraLifetime_System,
            MFVirtualCameraAccess_CurrentUser);
        if (FAILED(result))
        {
            return result;
        }

        LogInfo(std::wstring(L"Starting Windows virtual camera \"") + surevideotool::kVirtualCameraFriendlyName + L'"');
        result = camera->Start(nullptr);
        if (result == HRESULT_FROM_WIN32(ERROR_SHARING_VIOLATION))
        {
            // A system-lifetime virtual camera with this source CLSID is already active.
            // This is expected on re-install when the camera is in use. Treat as already installed.
            LogInfo(L"Windows virtual camera is already active (sharing violation on Start). Skipping re-registration.");
            result = S_OK;
        }
        else if (FAILED(result))
        {
            return result;
        }

        result = ValidateVirtualCamera(camera.Get());
        if (FAILED(result))
        {
            return result;
        }

        result = ProbeRegisteredDirectShowCamera();
        if (FAILED(result))
        {
            return result;
        }

        result = ProbeRegisteredWindowsSource();
        if (FAILED(result))
        {
            return result;
        }

        return ProbeEnumeratedWindowsVirtualCamera();
    }

    HRESULT RegisterDirectShowCameraOnly()
    {
        ComScope com(COINIT_MULTITHREADED);
        if (FAILED(com.result) && com.result != RPC_E_CHANGED_MODE)
        {
            return com.result;
        }

        return InvokeLocalBinary(kDirectShowDllName, "DllRegisterServer");
    }

    HRESULT RemoveCamera()
    {
        ComScope com(COINIT_MULTITHREADED);
        if (FAILED(com.result) && com.result != RPC_E_CHANGED_MODE)
        {
            return com.result;
        }

        HRESULT result = S_OK;

        if (SupportsWindowsVirtualCameraApi())
        {
            MfScope mf;
            if (FAILED(mf.result))
            {
                return mf.result;
            }

            const HRESULT removeCurrentResult = RemoveVirtualCameraByIdentity(
                surevideotool::kVirtualCameraFriendlyName,
                surevideotool::kWindowsVirtualCameraSourceClsid);
            if (FAILED(removeCurrentResult) && !IsBenignCameraRemovalResult(removeCurrentResult))
            {
                return removeCurrentResult;
            }

            CleanupLegacyWindowsVirtualCameras();

            result = InvokeRegisteredBinary(kWindowsVirtualCameraDllName, "DllUnregisterServer", false);
            if (FAILED(result))
            {
                return result;
            }
        }
        else
        {
            LogInfo(L"Windows Media Foundation virtual camera APIs are unavailable on this Windows build. Skipping MF virtual camera removal.");
        }

        result = InvokeRegisteredBinary(kDirectShowDllName, "DllUnregisterServer", false);
        if (FAILED(result))
        {
            return result;
        }

        return S_OK;
    }

    HRESULT UnregisterDirectShowCameraOnly()
    {
        ComScope com(COINIT_MULTITHREADED);
        if (FAILED(com.result) && com.result != RPC_E_CHANGED_MODE)
        {
            return com.result;
        }

        const std::filesystem::path localDirectShowDll = GetLocalBinaryPath(kDirectShowDllName);
        if (std::filesystem::exists(localDirectShowDll))
        {
            return InvokeLocalBinary(kDirectShowDllName, "DllUnregisterServer");
        }

        return InvokeRegisteredBinary(kDirectShowDllName, "DllUnregisterServer", false);
    }

    void PrintUsage()
    {
        std::wcout
            << L"Usage:\n"
            << L"  surevideotool_cam_registrar install [--all-users] [--session]\n"
            << L"  surevideotool_cam_registrar remove [--all-users] [--session] [--unregister-com]\n"
            << L"  surevideotool_cam_registrar probe\n"
            << L"  surevideotool_cam_registrar list\n"
            << L"  surevideotool_cam_registrar direct-source-probe\n"
            << L"  surevideotool_cam_registrar sample-probe\n"
            << L"  surevideotool_cam_registrar sample-probe-hp\n"
            << L"  surevideotool_cam_registrar register | /register\n"
            << L"  surevideotool_cam_registrar unregister | /unregister\n"
            << L"  surevideotool_cam_registrar com-register\n"
            << L"  surevideotool_cam_registrar com-unregister\n";
    }
}

int wmain(int argc, wchar_t** argv)
{
    if (argc < 2)
    {
        PrintUsage();
        return 1;
    }

    std::wstring command = argv[1];
    if (command == L"/register")
    {
        command = L"register";
    }
    else if (command == L"/unregister")
    {
        command = L"unregister";
    }
    else if (command == L"/probe")
    {
        command = L"probe";
    }
    else if (command == L"/list")
    {
        command = L"list";
    }
    else if (command == L"/sample-probe")
    {
        command = L"sample-probe";
    }
    else if (command == L"/sample-probe-hp")
    {
        command = L"sample-probe-hp";
    }
    else if (command == L"/direct-source-probe")
    {
        command = L"direct-source-probe";
    }

    const bool requiresAdministrator =
        (command == L"install") ||
        (command == L"remove") ||
        (command == L"register") ||
        (command == L"unregister") ||
        (command == L"com-register") ||
        (command == L"com-unregister");

    for (int index = 2; index < argc; ++index)
    {
        const std::wstring option = argv[index];
        if (option == L"--all-users" || option == L"--session" || option == L"--unregister-com")
        {
            continue;
        }

        LogFailure(std::wstring(L"Unknown option: ") + option);
        PrintUsage();
        return 1;
    }

    if (requiresAdministrator && !IsRunningAsAdministrator())
    {
        LogInfo(L"Administrator privileges are required. Requesting elevation...");
        return RelaunchAsAdministrator(argc, argv);
    }

    HRESULT result = E_INVALIDARG;

    if (command == L"install" || command == L"com-register")
    {
        result = InstallCamera();
    }
    else if (command == L"remove" || command == L"com-unregister")
    {
        result = RemoveCamera();
    }
    else if (command == L"probe")
    {
        result = ProbeRegisteredDirectShowCamera();
        if (SUCCEEDED(result) && SupportsWindowsVirtualCameraApi())
        {
            result = ProbeRegisteredWindowsSource();
        }
        if (SUCCEEDED(result) && SupportsWindowsVirtualCameraApi())
        {
            result = ProbeEnumeratedWindowsVirtualCamera();
        }
        else if (SUCCEEDED(result))
        {
            LogInfo(L"Windows Media Foundation virtual camera APIs are unavailable on this Windows build. DirectShow probe succeeded.");
        }
    }
    else if (command == L"list")
    {
        result = ListWindowsVideoCaptureDevices();
    }
    else if (command == L"sample-probe")
    {
        result = ProbeWindowsVirtualCameraSample();
    }
    else if (command == L"sample-probe-hp")
    {
        result = ProbePhysicalHpCameraSample();
    }
    else if (command == L"direct-source-probe")
    {
        result = ProbeRegisteredWindowsSourceSample();
    }
    else if (command == L"register")
    {
        result = RegisterDirectShowCameraOnly();
    }
    else if (command == L"unregister")
    {
        result = UnregisterDirectShowCameraOnly();
    }
    else
    {
        PrintUsage();
        return 1;
    }

    if (FAILED(result))
    {
        LogFailure(L"Operation failed.", result);
        return 1;
    }

    LogSuccess(L"Operation succeeded.");
    return 0;
}
