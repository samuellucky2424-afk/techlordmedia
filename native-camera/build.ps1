# Build the Surevideotool native virtual-camera artifacts.
#
# Usage:
#   .\build.ps1                  # Release x64 (default)
#   .\build.ps1 -Config Debug
#   .\build.ps1 -Arch Win32
#   .\build.ps1 -Clean           # wipe the build directory first
#   .\build.ps1 -TestPattern     # build the DirectShow filter in animated test-pattern mode
#
# Outputs land in: native-camera\build\<Config>\
#   - SurevideotoolVirtualCamera.dll
#   - SurevideotoolVirtualCameraMF.dll
#   - surevideotool_cam_registrar.exe
#   - surevideotool_cam_pipe_publisher.exe
#   - surevideotool_cam_feeder.exe
#
# Requirements:
#   - Visual Studio 2022 (or Build Tools) with "Desktop development with C++"
#   - CMake >= 3.26 on PATH
[CmdletBinding()]
param(
    [ValidateSet('Release', 'Debug', 'RelWithDebInfo', 'MinSizeRel')]
    [string]$Config = 'Release',

    [ValidateSet('x64', 'Win32', 'ARM64')]
    [string]$Arch = 'x64',

    [switch]$Clean,

    [switch]$TestPattern
)

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

if (-not (Get-Command cmake -ErrorAction SilentlyContinue)) {
    Write-Error 'CMake was not found on PATH. Install CMake >= 3.26 (winget install Kitware.CMake) and reopen the shell.'
    exit 1
}

$buildDir = Join-Path $PSScriptRoot 'build'

if ($Clean -and (Test-Path -LiteralPath $buildDir)) {
    Write-Host "Removing $buildDir ..."
    Remove-Item -LiteralPath $buildDir -Recurse -Force
}

$configureArgs = @('-S', '.', '-B', 'build', '-A', $Arch)
if ($TestPattern) {
    $configureArgs += '-DTEST_PATTERN_MODE=ON'
}

Write-Host ''
Write-Host "==> Configuring (cmake $($configureArgs -join ' '))"
cmake @configureArgs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host ''
Write-Host "==> Building ($Config | $Arch)"
cmake --build build --config $Config
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$outDir = Join-Path $buildDir $Config
Write-Host ''
Write-Host "==> Build succeeded. Artifacts:"
Get-ChildItem -LiteralPath $outDir -ErrorAction SilentlyContinue |
    Where-Object { $_.Extension -in '.dll', '.exe' -and $_.Name -match '^(Surevideotool|surevideotool_)' } |
    Format-Table -AutoSize Name, Length, LastWriteTime

Write-Host ''
Write-Host "Next steps:"
Write-Host "  1. Test:    .\build\$Config\surevideotool_cam_registrar.exe install"
Write-Host "  2. Package: cd ..\app && npm run electron:build"
Write-Host "             (afterPack.cjs auto-copies these into resources\surevideotool-cam\)"
