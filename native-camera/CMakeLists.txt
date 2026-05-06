cmake_minimum_required(VERSION 3.26)

project(SurevideotoolCam VERSION 0.1.0 LANGUAGES CXX)

if(NOT WIN32)
    message(FATAL_ERROR "SurevideotoolCam currently targets Windows only.")
endif()

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(POLICY CMP0091)
    cmake_policy(SET CMP0091 NEW)
endif()
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")

option(TEST_PATTERN_MODE "Build the DirectShow virtual camera in animated test-pattern mode." OFF)


add_library(surevideotool_common INTERFACE)
target_include_directories(surevideotool_common INTERFACE
    ${CMAKE_CURRENT_SOURCE_DIR}/include
)
target_compile_definitions(surevideotool_common INTERFACE
    UNICODE
    _UNICODE
    WIN32_LEAN_AND_MEAN
    NOMINMAX
)

set(SUREVIDEOTOOL_DSHOW_BASECLASSES_DIR ${CMAKE_CURRENT_SOURCE_DIR}/baseclasses)

add_library(surevideotool_dshow_baseclasses STATIC
    ${SUREVIDEOTOOL_DSHOW_BASECLASSES_DIR}/amfilter.cpp
    ${SUREVIDEOTOOL_DSHOW_BASECLASSES_DIR}/amvideo.cpp
    ${SUREVIDEOTOOL_DSHOW_BASECLASSES_DIR}/combase.cpp
    ${SUREVIDEOTOOL_DSHOW_BASECLASSES_DIR}/dllentry.cpp
    ${SUREVIDEOTOOL_DSHOW_BASECLASSES_DIR}/dllsetup.cpp
    ${SUREVIDEOTOOL_DSHOW_BASECLASSES_DIR}/mtype.cpp
    ${SUREVIDEOTOOL_DSHOW_BASECLASSES_DIR}/source.cpp
    ${SUREVIDEOTOOL_DSHOW_BASECLASSES_DIR}/winutil.cpp
    ${SUREVIDEOTOOL_DSHOW_BASECLASSES_DIR}/wxdebug.cpp
    ${SUREVIDEOTOOL_DSHOW_BASECLASSES_DIR}/wxlist.cpp
    ${SUREVIDEOTOOL_DSHOW_BASECLASSES_DIR}/wxutil.cpp
)
target_include_directories(surevideotool_dshow_baseclasses PUBLIC
    ${SUREVIDEOTOOL_DSHOW_BASECLASSES_DIR}
)
target_compile_definitions(surevideotool_dshow_baseclasses PUBLIC
    WIN32
    _CRT_SECURE_NO_WARNINGS
)
target_link_libraries(surevideotool_dshow_baseclasses PUBLIC
    surevideotool_common
    strmiids
)

add_library(surevideotool_publisher STATIC
    src/common/surevideotool_ids.cpp
    src/publisher/surevideotool_publisher.cpp
)
target_link_libraries(surevideotool_publisher PUBLIC surevideotool_common)

add_library(surevideotool_virtualcam SHARED
    src/common/surevideotool_ids.cpp
    src/virtualcam/dllmain.cpp
    src/virtualcam/virtual_camera_source.cpp
)
target_link_libraries(surevideotool_virtualcam PRIVATE
    advapi32
    surevideotool_dshow_baseclasses
    surevideotool_common
    ole32
    oleaut32
    shlwapi
    strmiids
    winmm
)
target_include_directories(surevideotool_virtualcam PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}
)
if(TEST_PATTERN_MODE)
    target_compile_definitions(surevideotool_virtualcam PRIVATE TEST_PATTERN_MODE=1)
endif()
set_target_properties(surevideotool_virtualcam PROPERTIES
    OUTPUT_NAME "SurevideotoolVirtualCamera"
)
if(MSVC)
    target_link_options(surevideotool_virtualcam PRIVATE
        "/EXPORT:DllCanUnloadNow,PRIVATE"
        "/EXPORT:DllGetClassObject,PRIVATE"
        "/EXPORT:DllRegisterServer,PRIVATE"
        "/EXPORT:DllUnregisterServer,PRIVATE"
    )
endif()

add_library(surevideotool_virtualcam_mf SHARED
    src/common/surevideotool_ids.cpp
    src/virtualcam/mf_dllmain.cpp
    src/virtualcam/mf_virtual_camera_source.cpp
)
target_link_libraries(surevideotool_virtualcam_mf PRIVATE
    advapi32
    surevideotool_common
    mf
    mfplat
    mfsensorgroup
    mfuuid
    ole32
    shlwapi
)
set_target_properties(surevideotool_virtualcam_mf PROPERTIES
    OUTPUT_NAME "SurevideotoolVirtualCameraMF"
)
if(MSVC)
    target_link_options(surevideotool_virtualcam_mf PRIVATE
        "/EXPORT:DllCanUnloadNow,PRIVATE"
        "/EXPORT:DllGetClassObject,PRIVATE"
        "/EXPORT:DllRegisterServer,PRIVATE"
        "/EXPORT:DllUnregisterServer,PRIVATE"
    )
endif()

add_executable(surevideotool_cam_registrar
    src/common/surevideotool_ids.cpp
    src/tools/registrar/main.cpp
)
target_link_libraries(surevideotool_cam_registrar PRIVATE
    mf
    mfplat
    mfreadwrite
    mfuuid
    surevideotool_common
    ole32
    oleaut32
    strmiids      # DirectShow GUIDs (CLSID_FilterMapper2, CLSID_VideoInputDeviceCategory, MEDIATYPE_Video, …)
    shell32       # ShellExecuteEx (UAC self-elevation)
    advapi32      # AllocateAndInitializeSid / CheckTokenMembership
    shlwapi       # StrStrIW (case-insensitive substring search)
)
add_executable(surevideotool_cam_feeder
    src/tools/feeder/main.cpp
)
target_link_libraries(surevideotool_cam_feeder PRIVATE
    advapi32
    surevideotool_common
    surevideotool_publisher
)

add_executable(surevideotool_cam_pipe_publisher
    src/tools/pipe_publisher/main.cpp
)
target_link_libraries(surevideotool_cam_pipe_publisher PRIVATE
    advapi32
    surevideotool_common
    surevideotool_publisher
)
