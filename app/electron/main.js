import { spawn, spawnSync } from 'child_process';
import { once } from 'events';

import { app, BrowserWindow, systemPreferences, ipcMain, Menu, nativeImage, powerSaveBlocker } from 'electron';
import crypto from 'crypto';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import fs from 'fs';
import { createDesktopUpdater } from './updater.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const isDevelopment = !app.isPackaged && process.env.NODE_ENV !== 'production';
const RELEASES_URL = 'https://github.com/samuellucky2424-afk/Surevideotool-project/releases';
const SUREVIDEOTOOL_CAM_WINDOW_NAME = 'Surevideotool Cam';
const SUREVIDEOTOOL_CAM_WINDOW_WIDTH = 640;
const SUREVIDEOTOOL_CAM_WINDOW_HEIGHT = 360;
const VIRTUAL_CAM_PUBLISHER_EXE = 'surevideotool_cam_pipe_publisher.exe';
const VIRTUAL_CAM_REGISTRAR_EXE = 'surevideotool_cam_registrar.exe';
const WINDOWS_MF_VIRTUAL_CAMERA_MIN_BUILD = 22000;
const VIRTUAL_CAM_STAGED_DLLS = [
  { fileName: 'SurevideotoolVirtualCameraMF.dll', role: 'mf' },
  { fileName: 'SurevideotoolVirtualCamera.dll', role: 'directshow' }
];
const VIRTUAL_CAM_REGISTRAR_TIMEOUT_MS = 120000;
const VIRTUAL_CAM_WINDOWS_PROBE_TIMEOUT_MS = 15000;
const VIRTUAL_CAM_FRIENDLY_NAME = 'Surevideotool G1';
const VIRTUAL_CAM_FRAME_WIDTH = 1280;
const VIRTUAL_CAM_FRAME_HEIGHT = 720;
const VIRTUAL_CAM_FRAME_STRIDE = VIRTUAL_CAM_FRAME_WIDTH * 4;
const VIRTUAL_CAM_FRAME_RATE = 30;
const VIRTUAL_CAM_FRAME_INTERVAL_MS = Math.max(1, Math.floor(1000 / VIRTUAL_CAM_FRAME_RATE));
const VIRTUAL_CAM_FRAME_QUEUE_MAX = 8;
const VIRTUAL_CAM_PIPE_MAGIC = 0x5041434d;
const VIRTUAL_CAM_PIPE_VERSION = 1;
const VIRTUAL_CAM_PIPE_HEADER_BYTES = 40;
const WINDOWS_FILETIME_EPOCH_OFFSET = 116444736000000000n;
const VIRTUAL_CAM_STATS_INTERVAL_MS = 5000;
const VIRTUAL_CAM_BLACK_SAMPLE_PIXELS = 512;
const VIRTUAL_CAM_LOG_FILE_NAME = 'virtual-camera.log';
const VIRTUAL_CAM_STALE_RENDERER_FRAME_MS = 2000;

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

function configureChromiumCachePaths() {
  try {
    const userDataPath = app.getPath('userData');
    const diskCachePath = path.join(userDataPath, 'Cache');
    const gpuCachePath = path.join(userDataPath, 'GPUCache');

    fs.mkdirSync(diskCachePath, { recursive: true });
    fs.mkdirSync(gpuCachePath, { recursive: true });

    app.commandLine.appendSwitch('disk-cache-dir', diskCachePath);
    app.commandLine.appendSwitch('gpu-shader-disk-cache-dir', gpuCachePath);
  } catch (error) {
    console.warn('Unable to configure custom Chromium cache paths:', formatErrorMessage(error));
  }
}

configureChromiumCachePaths();

let mainWindow = null;
let desktopUpdater = null;
let surevideotoolCamWindow = null;
let surevideotoolCamPublisher = null;
let virtualCameraEnabled = process.platform === 'win32';
let virtualCameraPowerSaveBlockerId = null;

function formatErrorMessage(error) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error ?? 'Unknown error');
}

function getTimestampHundredsOfNs() {
  return (BigInt(Date.now()) * 10000n) + WINDOWS_FILETIME_EPOCH_OFFSET;
}

function getVirtualCameraLogPath() {
  return path.join(app.getPath('userData'), 'logs', VIRTUAL_CAM_LOG_FILE_NAME);
}

function appendVirtualCameraLogLine(message) {
  if (!message) {
    return;
  }

  try {
    const logPath = getVirtualCameraLogPath();
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${message}\n`, 'utf8');
  } catch {
    // Logging must never break the app.
  }
}

function formatVirtualCameraLogDetail(detail) {
  if (detail === undefined || detail === null) {
    return '';
  }

  if (detail instanceof Error) {
    return `${detail.name}: ${formatErrorMessage(detail)}`;
  }

  if (typeof detail === 'string') {
    return detail;
  }

  try {
    return JSON.stringify(detail);
  } catch {
    return String(detail);
  }
}

function logVirtualCameraEvent(level, message, detail) {
  const detailText = formatVirtualCameraLogDetail(detail);
  const line = detailText ? `[${level}] ${message} | ${detailText}` : `[${level}] ${message}`;
  appendVirtualCameraLogLine(line);

  if (level === 'error') {
    console.error(message, detail ?? '');
  } else if (level === 'warn') {
    console.warn(message, detail ?? '');
  } else {
    console.info(message, detail ?? '');
  }
}

function logVirtualCameraStats(controller, reason) {
  if (!controller?.stats) {
    return;
  }

  const now = Date.now();
  const elapsedMs = Math.max(1, now - controller.stats.startedAt);
  const fps = (controller.stats.framesSent * 1000) / elapsedMs;
  console.info(
    `Surevideotool cam bridge stats (${reason}): frames=${controller.stats.framesSent} fps=${fps.toFixed(2)} ` +
    `rendererFrames=${controller.stats.rendererFramesReceived} captureFallbacks=${controller.stats.captureFallbacks} ` +
    `captureFailures=${controller.stats.captureFailures} publishFailures=${controller.stats.publishFailures} ` +
    `blackFrames=${controller.stats.blackFrames} staleCachedFrames=${controller.stats.staleCachedFrames ?? 0} ` +
    `size=${VIRTUAL_CAM_FRAME_WIDTH}x${VIRTUAL_CAM_FRAME_HEIGHT} format=BGRA32`
  );
  appendVirtualCameraLogLine(
    `[info] bridge stats (${reason}) frames=${controller.stats.framesSent} fps=${fps.toFixed(2)} ` +
    `rendererFrames=${controller.stats.rendererFramesReceived} captureFallbacks=${controller.stats.captureFallbacks} ` +
    `captureFailures=${controller.stats.captureFailures} publishFailures=${controller.stats.publishFailures} ` +
    `blackFrames=${controller.stats.blackFrames} staleCachedFrames=${controller.stats.staleCachedFrames ?? 0} ` +
    `size=${VIRTUAL_CAM_FRAME_WIDTH}x${VIRTUAL_CAM_FRAME_HEIGHT} format=BGRA32`
  );
  controller.stats.lastLogAt = now;
}

function startVirtualCameraPowerSaveBlocker() {
  if (virtualCameraPowerSaveBlockerId !== null) {
    return;
  }

  try {
    virtualCameraPowerSaveBlockerId = powerSaveBlocker.start('prevent-display-sleep');
    appendVirtualCameraLogLine(`[info] powerSaveBlocker started id=${virtualCameraPowerSaveBlockerId}.`);
  } catch (error) {
    logVirtualCameraEvent('warn', 'Unable to start virtual camera power save blocker.', error);
  }
}

function stopVirtualCameraPowerSaveBlocker() {
  if (virtualCameraPowerSaveBlockerId === null) {
    return;
  }

  try {
    if (powerSaveBlocker.isStarted(virtualCameraPowerSaveBlockerId)) {
      powerSaveBlocker.stop(virtualCameraPowerSaveBlockerId);
    }
    appendVirtualCameraLogLine(`[info] powerSaveBlocker stopped id=${virtualCameraPowerSaveBlockerId}.`);
  } catch (error) {
    logVirtualCameraEvent('warn', 'Unable to stop virtual camera power save blocker.', error);
  } finally {
    virtualCameraPowerSaveBlockerId = null;
  }
}

function isLikelyBlackFrame(frameBytes) {
  if (!frameBytes || frameBytes.length < 4) {
    return true;
  }

  const totalPixels = Math.floor(frameBytes.length / 4);
  const samplePixels = Math.min(totalPixels, VIRTUAL_CAM_BLACK_SAMPLE_PIXELS);
  if (samplePixels === 0) {
    return true;
  }

  const pixelStep = Math.max(1, Math.floor(totalPixels / samplePixels));
  let nonBlackSamples = 0;

  for (let pixelIndex = 0; pixelIndex < totalPixels; pixelIndex += pixelStep) {
    const byteIndex = pixelIndex * 4;
    const blue = frameBytes[byteIndex];
    const green = frameBytes[byteIndex + 1];
    const red = frameBytes[byteIndex + 2];

    if (blue !== 0 || green !== 0 || red !== 0) {
      nonBlackSamples += 1;
      if (nonBlackSamples >= 4) {
        return false;
      }
    }
  }

  return true;
}

function convertRgbaToBgra(frameBytes) {
  if (!frameBytes || frameBytes.length === 0) {
    return Buffer.alloc(0);
  }

  const bgraBytes = Buffer.allocUnsafe(frameBytes.length);
  for (let index = 0; index < frameBytes.length; index += 4) {
    bgraBytes[index] = frameBytes[index + 2];
    bgraBytes[index + 1] = frameBytes[index + 1];
    bgraBytes[index + 2] = frameBytes[index];
    bgraBytes[index + 3] = frameBytes[index + 3];
  }

  return bgraBytes;
}

function getVirtualCameraPublisherCandidates() {
  if (app.isPackaged) {
    return [
      path.join(process.resourcesPath, 'surevideotool-cam', VIRTUAL_CAM_PUBLISHER_EXE),
      path.join(process.resourcesPath, VIRTUAL_CAM_PUBLISHER_EXE),
      path.join(path.dirname(process.execPath), VIRTUAL_CAM_PUBLISHER_EXE)
    ];
  }

  return [
    path.resolve(__dirname, '../../native-camera/build/Debug', VIRTUAL_CAM_PUBLISHER_EXE),
    path.resolve(__dirname, '../../native-camera/build/Release', VIRTUAL_CAM_PUBLISHER_EXE),
    path.resolve(__dirname, '../../native-camera/build/RelWithDebInfo', VIRTUAL_CAM_PUBLISHER_EXE),
    path.resolve(__dirname, '../../native-camera/build', VIRTUAL_CAM_PUBLISHER_EXE),
    path.resolve(__dirname, '../../build/Debug', VIRTUAL_CAM_PUBLISHER_EXE),
    path.resolve(__dirname, '../../build/Release', VIRTUAL_CAM_PUBLISHER_EXE),
    path.resolve(__dirname, '../../build/RelWithDebInfo', VIRTUAL_CAM_PUBLISHER_EXE),
    path.resolve(__dirname, '../../build', VIRTUAL_CAM_PUBLISHER_EXE)
  ];
}

function getVirtualCameraRegistrarCandidates() {
  if (app.isPackaged) {
    return [
      path.join(process.resourcesPath, 'surevideotool-cam', VIRTUAL_CAM_REGISTRAR_EXE),
      path.join(process.resourcesPath, VIRTUAL_CAM_REGISTRAR_EXE),
      path.join(path.dirname(process.execPath), VIRTUAL_CAM_REGISTRAR_EXE)
    ];
  }

  return [
    path.resolve(__dirname, '../../native-camera/build/Debug', VIRTUAL_CAM_REGISTRAR_EXE),
    path.resolve(__dirname, '../../native-camera/build/Release', VIRTUAL_CAM_REGISTRAR_EXE),
    path.resolve(__dirname, '../../native-camera/build/RelWithDebInfo', VIRTUAL_CAM_REGISTRAR_EXE),
    path.resolve(__dirname, '../../native-camera/build', VIRTUAL_CAM_REGISTRAR_EXE),
    path.resolve(__dirname, '../../build/Debug', VIRTUAL_CAM_REGISTRAR_EXE),
    path.resolve(__dirname, '../../build/Release', VIRTUAL_CAM_REGISTRAR_EXE),
    path.resolve(__dirname, '../../build/RelWithDebInfo', VIRTUAL_CAM_REGISTRAR_EXE),
    path.resolve(__dirname, '../../build', VIRTUAL_CAM_REGISTRAR_EXE)
  ];
}

function resolveVirtualCameraPublisherPath() {
  const match = getVirtualCameraPublisherCandidates().find((candidate) => fs.existsSync(candidate));
  if (!match) {
    throw new Error(`Unable to locate ${VIRTUAL_CAM_PUBLISHER_EXE}. Build it before starting the Electron app.`);
  }

  return match;
}

function resolveVirtualCameraRegistrarPath() {
  const match = getVirtualCameraRegistrarCandidates().find((candidate) => fs.existsSync(candidate));
  if (!match) {
    throw new Error(`Unable to locate ${VIRTUAL_CAM_REGISTRAR_EXE}. Build it before starting the Electron app.`);
  }

  return match;
}

function getProgramDataSurevideotoolPath() {
  const programDataPath = process.env.ProgramData || 'C:\\ProgramData';
  return path.join(programDataPath, 'Surevideotool');
}

function getWindowsBuildNumber() {
  if (process.platform !== 'win32') {
    return 0;
  }

  const parts = os.release().split('.').map((part) => Number.parseInt(part, 10));
  return Number.isFinite(parts[2]) ? parts[2] : 0;
}

function supportsWindowsMediaFoundationVirtualCamera() {
  return process.platform === 'win32' && getWindowsBuildNumber() >= WINDOWS_MF_VIRTUAL_CAMERA_MIN_BUILD;
}

function getFileHash(filePath) {
  try {
    const hash = crypto.createHash('sha256');
    hash.update(fs.readFileSync(filePath));
    return hash.digest('hex');
  } catch {
    return null;
  }
}

function getVirtualCameraStagedBinaryStatus(registrarPath) {
  const sourceDirectory = path.dirname(registrarPath);
  const targetDirectory = getProgramDataSurevideotoolPath();
  const details = [];
  const supportsMfVirtualCamera = supportsWindowsMediaFoundationVirtualCamera();

  for (const stagedDll of VIRTUAL_CAM_STAGED_DLLS) {
    const { fileName, role } = stagedDll;
    const required = role === 'mf' ? supportsMfVirtualCamera : !supportsMfVirtualCamera;
    const sourcePath = path.join(sourceDirectory, fileName);
    const targetPath = path.join(targetDirectory, fileName);
    const sourceExists = fs.existsSync(sourcePath);
    const targetExists = fs.existsSync(targetPath);

    if (!sourceExists || !targetExists) {
      details.push({
        fileName,
        sourcePath,
        targetPath,
        required,
        sourceExists,
        targetExists,
        matches: false,
        reason: !sourceExists ? 'missing-source' : 'missing-staged-copy'
      });
      continue;
    }

    const sourceHash = getFileHash(sourcePath);
    const targetHash = getFileHash(targetPath);
    details.push({
      fileName,
      sourcePath,
      targetPath,
      required,
      sourceHash,
      targetHash,
      matches: Boolean(sourceHash && targetHash && sourceHash === targetHash),
      reason: sourceHash === targetHash ? 'match' : 'hash-mismatch'
    });
  }

  const mismatches = details.filter((item) => !item.matches);
  const blockingMismatches = mismatches.filter((item) => item.required);
  const optionalMismatches = mismatches.filter((item) => !item.required);
  return {
    needsRepair: blockingMismatches.length > 0,
    details,
    mismatches,
    blockingMismatches,
    legacyMismatches: optionalMismatches,
    message: blockingMismatches.length > 0
      ? `Required virtual camera files are outdated or missing: ${blockingMismatches.map((item) => item.fileName).join(', ')}`
      : optionalMismatches.length > 0
        ? `Optional virtual camera files are outdated or missing: ${optionalMismatches.map((item) => item.fileName).join(', ')}`
      : 'Staged virtual camera files match bundled files.'
  };
}

function runVirtualCameraRegistrar(registrarPath, args) {
  const result = spawnSync(registrarPath, args, {
    windowsHide: true,
    timeout: VIRTUAL_CAM_REGISTRAR_TIMEOUT_MS,
    encoding: 'utf8'
  });

  const stdout = (result.stdout ?? '').trim();
  const stderr = (result.stderr ?? '').trim();
  const ok = (result.status ?? 1) === 0 && !result.error;

  if (stdout) {
    console.info(`Surevideotool cam registrar stdout (${args.join(' ')}):\n${stdout}`);
  }

  if (stderr) {
    console.warn(`Surevideotool cam registrar stderr (${args.join(' ')}):\n${stderr}`);
  }

  if (result.error) {
    console.error(`Surevideotool cam registrar execution failed for "${args.join(' ')}":`, result.error);
  }

  if ((result.signal ?? null) !== null) {
    console.warn(`Surevideotool cam registrar was interrupted by signal ${result.signal} for "${args.join(' ')}".`);
  }

  return {
    ok,
    status: result.status,
    error: result.error,
    stdout,
    stderr
  };
}

function probeWindowsCameraVisibility() {
  if (process.platform !== 'win32') {
    return { supported: false, visible: false };
  }

  const probeScript = [
    `$friendlyName = '${VIRTUAL_CAM_FRIENDLY_NAME}'`,
    "$friendlyNamePattern = ('*' + $friendlyName + '*')",
    '$visible = $false',
    'try {',
    '  $visible = @(Get-PnpDevice -Class Camera -ErrorAction SilentlyContinue | Where-Object { $_.FriendlyName -like $friendlyNamePattern }).Count -gt 0',
    '} catch {}',
    'if (-not $visible) {',
    '  try {',
    '    $visible = @(Get-PnpDevice -Class Image -ErrorAction SilentlyContinue | Where-Object { $_.FriendlyName -like $friendlyNamePattern }).Count -gt 0',
    '  } catch {}',
    '}',
    'if (-not $visible) {',
    '  try {',
    '    $visible = @(Get-CimInstance Win32_PnPEntity -ErrorAction SilentlyContinue | Where-Object { $_.Name -like $friendlyNamePattern }).Count -gt 0',
    '  } catch {}',
    '}',
    'if ($visible) {',
    "  Write-Output 'VISIBLE'",
    '  exit 0',
    '}',
    "Write-Output 'MISSING'",
    'exit 2'
  ].join('; ');

  const result = spawnSync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    probeScript
  ], {
    windowsHide: true,
    timeout: VIRTUAL_CAM_WINDOWS_PROBE_TIMEOUT_MS,
    encoding: 'utf8'
  });

  if (result.error) {
    return {
      supported: true,
      visible: false,
      error: formatErrorMessage(result.error)
    };
  }

  const stdout = (result.stdout ?? '').trim();
  const visible = stdout.includes('VISIBLE');

  return {
    supported: true,
    visible,
    stdout,
    stderr: (result.stderr ?? '').trim(),
    status: result.status
  };
}

function ensureVirtualCameraRegistration({ attemptRepair = false } = {}) {
  if (process.platform !== 'win32') {
    return { success: false, error: 'Virtual camera registration is only supported on Windows.' };
  }

  let registrarPath;
  try {
    registrarPath = resolveVirtualCameraRegistrarPath();
  } catch (error) {
    return { success: false, error: formatErrorMessage(error) };
  }

  const probeResult = runVirtualCameraRegistrar(registrarPath, ['probe']);
  const binaryStatus = getVirtualCameraStagedBinaryStatus(registrarPath);
  const supportsMfVirtualCamera = supportsWindowsMediaFoundationVirtualCamera();
  if (binaryStatus.needsRepair) {
    console.warn(`Surevideotool virtual camera staged files need repair: ${binaryStatus.message}`);
    appendVirtualCameraLogLine(`[warn] ${binaryStatus.message}`);
  }

  if (probeResult.ok && !binaryStatus.needsRepair) {
    if (!supportsMfVirtualCamera) {
      appendVirtualCameraLogLine(
        `[info] Windows build ${getWindowsBuildNumber()} does not support Media Foundation virtual cameras; using DirectShow fallback registration.`
      );
    }

    // Probe success means the required camera path for this Windows build is installed.
    // PnP visibility is an unreliable secondary check and must never trigger a repair
    // (repair requires elevation and can be disruptive in a normal user session).
    const visibilityResult = probeWindowsCameraVisibility();
    if (!visibilityResult.visible) {
      console.warn('Surevideotool virtual camera probe succeeded but Windows PnP visibility check did not find the device. Continuing anyway.');
    }
    return {
      success: true,
      message: supportsMfVirtualCamera
        ? 'Surevideotool virtual camera registration is healthy.'
        : 'Surevideotool DirectShow virtual camera fallback is healthy on this Windows build.',
      deviceVisible: visibilityResult.visible
    };
  } else if (!attemptRepair) {
    return {
      success: false,
      error: probeResult.ok
        ? binaryStatus.message
        : 'Surevideotool virtual camera is not registered. Run the installer or surevideotool_cam_registrar install.',
      deviceVisible: false
    };
  }

  const repairReason = probeResult.ok
    ? binaryStatus.message
    : 'virtual camera probe failed';
  console.warn(`Surevideotool virtual camera ${repairReason}. Attempting automatic registration repair...`);

  const installAllUsersResult = runVirtualCameraRegistrar(registrarPath, ['install', '--all-users']);
  if (!installAllUsersResult.ok) {
    console.warn('All-users registration failed. Retrying current-user registration...');
    const installCurrentUserResult = runVirtualCameraRegistrar(registrarPath, ['install']);
    if (!installCurrentUserResult.ok) {
      return {
        success: false,
        error: 'Unable to register Surevideotool virtual camera. Please run surevideotool_cam_registrar install as Administrator.',
        deviceVisible: false
      };
    }
  }

  const reprobeResult = runVirtualCameraRegistrar(registrarPath, ['probe']);
  if (!reprobeResult.ok) {
    return {
      success: false,
      error: 'Surevideotool virtual camera still failed probe after repair. Please reinstall Surevideotool.',
      deviceVisible: false
    };
  }

  const repairedBinaryStatus = getVirtualCameraStagedBinaryStatus(registrarPath);
  if (repairedBinaryStatus.needsRepair) {
    const message = `${repairedBinaryStatus.message}. Close WhatsApp and any app using the camera, then run Surevideotool again so the updated camera DLL can be staged.`;
    console.error(message);
    appendVirtualCameraLogLine(`[error] ${message}`);
    return {
      success: false,
      error: message,
      deviceVisible: false
    };
  }

  const visibilityResult = probeWindowsCameraVisibility();
  if (!visibilityResult.visible) {
    console.warn('Surevideotool virtual camera passed registrar probe after repair, but Windows camera visibility check still failed. Continuing because registration is healthy.');
    return {
      success: true,
      message: 'Surevideotool virtual camera registration repaired successfully, but Windows PnP visibility is still delayed or unavailable.',
      warning: 'Surevideotool G1 may not appear in some camera pickers immediately even though the driver probe succeeded.',
      deviceVisible: false
    };
  }

  return { success: true, message: 'Surevideotool virtual camera registration repaired successfully.', deviceVisible: true };
}

function createVirtualCameraFrameHeader(payloadBytes, timestampHundredsOfNs = getTimestampHundredsOfNs()) {
  const header = Buffer.alloc(VIRTUAL_CAM_PIPE_HEADER_BYTES);
  header.writeUInt32LE(VIRTUAL_CAM_PIPE_MAGIC, 0);
  header.writeUInt32LE(VIRTUAL_CAM_PIPE_VERSION, 4);
  header.writeUInt32LE(VIRTUAL_CAM_FRAME_WIDTH, 8);
  header.writeUInt32LE(VIRTUAL_CAM_FRAME_HEIGHT, 12);
  header.writeUInt32LE(VIRTUAL_CAM_FRAME_STRIDE, 16);
  header.writeUInt32LE(VIRTUAL_CAM_FRAME_RATE, 20);
  header.writeUInt32LE(1, 24);
  header.writeUInt32LE(payloadBytes, 28);
  header.writeBigInt64LE(timestampHundredsOfNs, 32);
  return header;
}

async function writeFrameToVirtualCameraPublisher(controller, frameBytes, timestampHundredsOfNs = getTimestampHundredsOfNs()) {
  if (!controller.child?.stdin || controller.child.stdin.destroyed) {
    throw new Error('Virtual camera publisher process is not writable.');
  }

  const header = createVirtualCameraFrameHeader(frameBytes.length, timestampHundredsOfNs);
  if (!controller.child.stdin.write(header)) {
    await once(controller.child.stdin, 'drain');
  }

  if (!controller.child.stdin.write(frameBytes)) {
    await once(controller.child.stdin, 'drain');
  }
}

async function publishFrameToVirtualCamera(controller, frameBytes, timestampHundredsOfNs, sourceLabel) {
  const expectedBytes = VIRTUAL_CAM_FRAME_STRIDE * VIRTUAL_CAM_FRAME_HEIGHT;
  if (!frameBytes || frameBytes.length !== expectedBytes) {
    throw new Error(`Unexpected ${sourceLabel} frame size: received ${frameBytes?.length ?? 0} bytes, expected ${expectedBytes}.`);
  }

  if (isLikelyBlackFrame(frameBytes)) {
    controller.stats.blackFrames += 1;
    if ((controller.stats.blackFrames % VIRTUAL_CAM_FRAME_RATE) === 0) {
      console.warn(`Surevideotool cam bridge published a black ${sourceLabel} frame.`);
    }
  }

  await writeFrameToVirtualCameraPublisher(controller, frameBytes, timestampHundredsOfNs);

  controller.stats.framesSent += 1;
  if ((Date.now() - controller.stats.lastLogAt) >= VIRTUAL_CAM_STATS_INTERVAL_MS) {
    logVirtualCameraStats(controller, 'periodic');
  }
}

function updateRendererFrame(controller, payload) {
  if (!controller || controller.stopping || !payload) {
    return;
  }

  const pixels = payload.pixels;
  if (!ArrayBuffer.isView(pixels)) {
    return;
  }

  const srcWidth = payload.width;
  const srcHeight = payload.height;
  const srcStride = payload.stride;

  if (!srcWidth || !srcHeight || !srcStride || pixels.byteLength !== srcStride * srcHeight) {
    return;
  }

  let frameBytes;

  if (srcWidth === VIRTUAL_CAM_FRAME_WIDTH && srcHeight === VIRTUAL_CAM_FRAME_HEIGHT) {
    // Already the right size — use directly.
    const rgbaBytes = Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength);
    frameBytes = convertRgbaToBgra(rgbaBytes);
  } else {
    // Popup renders at a smaller size (e.g. 640x360). Upscale using nativeImage.
    try {
      const srcBuffer = Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength);
      const bgraBuffer = convertRgbaToBgra(srcBuffer);
      const img = nativeImage.createFromBuffer(bgraBuffer, { width: srcWidth, height: srcHeight });
      if (img.isEmpty()) {
        return;
      }
      const scaled = img.resize({ width: VIRTUAL_CAM_FRAME_WIDTH, height: VIRTUAL_CAM_FRAME_HEIGHT });
      frameBytes = scaled.toBitmap();
    } catch (e) {
      console.warn('updateRendererFrame: failed to upscale frame:', e.message);
      return;
    }
  }

  const expectedBytes = VIRTUAL_CAM_FRAME_STRIDE * VIRTUAL_CAM_FRAME_HEIGHT;
  if (!frameBytes || frameBytes.length !== expectedBytes) {
    return;
  }

  const rendererFrame = {
    frameBytes,
    timestampHundredsOfNs: getTimestampHundredsOfNs(),
    receivedAt: Date.now(),
    sequence: (controller.rendererFrameSequence ?? 0) + 1
  };
  controller.rendererFrameSequence = rendererFrame.sequence;
  controller.latestRendererFrame = rendererFrame;
  controller.frameQueue.push(rendererFrame);
  while (controller.frameQueue.length > VIRTUAL_CAM_FRAME_QUEUE_MAX) {
    controller.frameQueue.shift();
  }
  controller.stats.rendererFramesReceived += 1;
}

async function publishLatestRendererFrame(controller) {
  if (!controller || controller.stopping || controller.writeInFlight) {
    return;
  }

  const nextBufferedFrame = controller.frameQueue.length > 0
    ? controller.frameQueue.shift()
    : null;
  const frameToPublish = nextBufferedFrame ?? controller.lastPublishedFrame;

  if (!frameToPublish?.frameBytes) {
    return;
  }

  if (!nextBufferedFrame) {
    const rendererFrameAgeMs = Date.now() - (frameToPublish.receivedAt ?? 0);
    if (rendererFrameAgeMs >= VIRTUAL_CAM_STALE_RENDERER_FRAME_MS) {
      controller.stats.staleCachedFrames += 1;
      const lastWarnedAt = controller.lastStaleRendererWarningAt ?? 0;
      if ((Date.now() - lastWarnedAt) >= VIRTUAL_CAM_STATS_INTERVAL_MS) {
        controller.lastStaleRendererWarningAt = Date.now();
        appendVirtualCameraLogLine(
          `[warn] Publishing cached renderer frame because no fresh renderer frame arrived for ${rendererFrameAgeMs}ms.`
        );
      }
    }
  }

  controller.writeInFlight = true;

  try {
    await publishFrameToVirtualCamera(
      controller,
      frameToPublish.frameBytes,
      getTimestampHundredsOfNs(),
      nextBufferedFrame ? 'renderer' : 'cached-renderer'
    );

    controller.lastPublishedFrame = frameToPublish;
    controller.lastPublishedSequence = frameToPublish.sequence ?? controller.lastPublishedSequence;
  } catch (error) {
    controller.stats.publishFailures += 1;
    console.error('Failed to push Surevideotool output into the virtual camera bridge:', error);

    if (!controller.stopping) {
      const message = formatErrorMessage(error);
      if (message.includes('EPIPE') || message.includes('EOF') || message.includes('not writable')) {
        stopSurevideotoolCamPublisher();
      }
    }
  } finally {
    controller.writeInFlight = false;
  }
}

function scheduleSurevideotoolCamPublish(controller, delayMs = 0) {
  if (controller.stopping) {
    return;
  }

  controller.timer = setTimeout(() => {
    controller.timer = null;
    const startedAt = Date.now();
    void publishLatestRendererFrame(controller).finally(() => {
      if (!controller.stopping) {
        const elapsedMs = Date.now() - startedAt;
        scheduleSurevideotoolCamPublish(controller, Math.max(0, VIRTUAL_CAM_FRAME_INTERVAL_MS - elapsedMs));
      }
    });
  }, delayMs);
}

function stopSurevideotoolCamPublisher() {
  if (!surevideotoolCamPublisher) {
    appendVirtualCameraLogLine('[info] stopSurevideotoolCamPublisher called with no active publisher.');
    return { success: true, message: 'Virtual camera publisher is already stopped.' };
  }

  const controller = surevideotoolCamPublisher;
  appendVirtualCameraLogLine(`[info] Stopping virtual camera publisher pid=${controller.child?.pid ?? 'unknown'}.`);
  surevideotoolCamPublisher = null;
  controller.stopping = true;

  if (controller.timer) {
    clearTimeout(controller.timer);
    controller.timer = null;
  }

  if (controller.stats?.framesSent) {
    logVirtualCameraStats(controller, 'stop');
  }

  stopVirtualCameraPowerSaveBlocker();

  if (controller.child?.stdin && !controller.child.stdin.destroyed) {
    controller.child.stdin.end();
  }

  if (controller.child && !controller.child.killed) {
    const killTimer = setTimeout(() => {
      if (!controller.child.killed) {
        controller.child.kill();
      }
    }, 1000);
    killTimer.unref?.();

    controller.child.once('exit', () => {
      clearTimeout(killTimer);
    });
  }

  return { success: true, message: 'Virtual camera publisher stopped.' };
}

function ensureSurevideotoolCamPublisher() {
  if (process.platform !== 'win32') {
    return { success: false, error: 'Virtual camera publishing is only supported on Windows.' };
  }

  if (!virtualCameraEnabled) {
    return { success: false, error: 'Virtual camera publishing is currently disabled.' };
  }

  if (surevideotoolCamPublisher && !surevideotoolCamPublisher.stopping) {
    return { success: true, message: 'Surevideotool cam output is already being published.' };
  }

  stopSurevideotoolCamPublisher();

  try {
    const publisherPath = resolveVirtualCameraPublisherPath();
    appendVirtualCameraLogLine(`[info] Starting virtual camera publisher from ${publisherPath}.`);
    const child = spawn(publisherPath, [], {
      stdio: ['pipe', 'ignore', 'pipe'],
      windowsHide: true
    });

    const controller = {
      child,
      timer: null,
      writeInFlight: false,
      stopping: false,
      latestRendererFrame: null,
      frameQueue: [],
      lastPublishedFrame: null,
      rendererFrameSequence: 0,
      lastPublishedSequence: 0,
      lastStaleRendererWarningAt: 0,
      stats: {
        startedAt: Date.now(),
        lastLogAt: Date.now(),
        framesSent: 0,
        rendererFramesReceived: 0,
        captureFallbacks: 0,
        captureFailures: 0,
        publishFailures: 0,
        blackFrames: 0,
        staleCachedFrames: 0
      }
    };

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk) => {
      const message = chunk.toString().trim();
      if (message) {
        logVirtualCameraEvent('error', 'Surevideotool cam publisher stderr', message);
      }
    });

    child.stdin?.on('error', (error) => {
      if (!controller.stopping) {
        logVirtualCameraEvent('error', 'Virtual camera publisher stdin failed.', error);
        stopSurevideotoolCamPublisher();
      }
    });

    child.on('error', (error) => {
      if (!controller.stopping) {
        logVirtualCameraEvent('error', 'Failed to launch the virtual camera publisher.', error);
        stopSurevideotoolCamPublisher();
      }
    });

    child.on('exit', (code, signal) => {
      if (surevideotoolCamPublisher === controller) {
        surevideotoolCamPublisher = null;
      }

      if (!controller.stopping) {
        logVirtualCameraEvent('error', 'Virtual camera publisher exited unexpectedly.', { code: code ?? null, signal: signal ?? null });
      } else {
        appendVirtualCameraLogLine(`[info] Virtual camera publisher exited during shutdown code=${code ?? 'null'} signal=${signal ?? 'null'}.`);
      }
    });

    surevideotoolCamPublisher = controller;
    startVirtualCameraPowerSaveBlocker();
    appendVirtualCameraLogLine(`[info] Virtual camera publisher started pid=${child.pid ?? 'unknown'}.`);
    scheduleSurevideotoolCamPublish(controller);

    return { success: true, message: `Publishing Surevideotool cam output via ${publisherPath}.` };
  } catch (error) {
    logVirtualCameraEvent('error', 'Unable to start the virtual camera publisher.', error);
    return { success: false, error: formatErrorMessage(error) };
  }
}

function loadEnvironmentVariables() {
  const envPath = app.isPackaged
    ? path.join(process.resourcesPath, '.env')
    : path.join(__dirname, '../.env');

  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
  }
}

function resolveUpdateManifestUrl() {
  return process.env.SUREVIDEOTOOL_UPDATE_MANIFEST_URL
    || process.env.VITE_UPDATE_MANIFEST_URL
    || 'https://surevideotool-project.vercel.app/api/version';
}

function resolveRendererDevUrl() {
  return process.env.ELECTRON_RENDERER_URL || 'http://localhost:5173';
}

function buildLoadFailureHtml(failedUrl, errorCode, errorDescription) {
  const safeUrl = String(failedUrl ?? '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const safeDescription = String(errorDescription ?? '').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  return `<!doctype html>
<html>
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Surevideotool Startup Error</title>
    <style>
      :root { color-scheme: dark; }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background: radial-gradient(circle at top left, #151b2e, #05070d 60%);
        color: #f2f4ff;
        font-family: Segoe UI, Tahoma, sans-serif;
      }
      .card {
        width: min(720px, 92vw);
        border: 1px solid #2b3154;
        background: rgba(10, 14, 26, 0.9);
        border-radius: 14px;
        padding: 24px;
        box-shadow: 0 20px 60px rgba(0, 0, 0, 0.45);
      }
      h1 {
        margin: 0 0 8px;
        font-size: 24px;
      }
      p {
        margin: 0 0 12px;
        color: #c6cde8;
      }
      code {
        color: #d7ddff;
        background: #11162a;
        border: 1px solid #2f3b64;
        padding: 2px 6px;
        border-radius: 6px;
      }
      ul {
        margin: 10px 0 0;
        padding-left: 20px;
        color: #d9dff9;
      }
      li { margin: 6px 0; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>Surevideotool could not load the app UI</h1>
      <p>Electron started, but the renderer URL was unavailable.</p>
      <p>URL: <code>${safeUrl}</code></p>
      <p>Error: <code>${errorCode} ${safeDescription}</code></p>
      <ul>
        <li>If this is development mode, start with <code>npm run electron:dev</code> in the app folder.</li>
        <li>If another process uses port 5173 or 3000, stop it and retry.</li>
        <li>Check terminal logs for Vite or API startup failures.</li>
      </ul>
    </div>
  </body>
</html>`;
}

function isSurevideotoolCamPopup(details) {
  return details.frameName === SUREVIDEOTOOL_CAM_WINDOW_NAME;
}

function createSurevideotoolCamWindowOptions() {
  return {
    title: SUREVIDEOTOOL_CAM_WINDOW_NAME,
    width: SUREVIDEOTOOL_CAM_WINDOW_WIDTH,
    height: SUREVIDEOTOOL_CAM_WINDOW_HEIGHT,
    minWidth: 360,
    minHeight: 220,
    backgroundColor: '#000000',
    transparent: false,
    autoHideMenuBar: true,
    alwaysOnTop: false,
    fullscreenable: false,
    parent: mainWindow ?? undefined,
    webPreferences: {
      offscreen: false,
      backgroundThrottling: false,
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  };
}

function keepWindowVisibleOnTop(window) {
  if (window.isDestroyed()) {
    return;
  }

  window.setMenuBarVisibility(false);

  if (typeof window.moveTop === 'function') {
    window.moveTop();
  }
}

function configureSurevideotoolCamPopup(window) {
  keepWindowVisibleOnTop(window);
  window.setTitle(SUREVIDEOTOOL_CAM_WINDOW_NAME);
  window.webContents.setFrameRate(30);

  window.on('show', () => {
    keepWindowVisibleOnTop(window);
  });

  window.on('focus', () => {
    keepWindowVisibleOnTop(window);
  });

  window.on('blur', () => {
    keepWindowVisibleOnTop(window);
  });

  window.on('closed', () => {
    if (surevideotoolCamWindow === window) {
      surevideotoolCamWindow = null;
    }
  });

  const startResult = ensureSurevideotoolCamPublisher();
  if (!startResult.success) {
    console.error('Surevideotool cam virtual camera bridge did not start:', startResult.error ?? startResult.message);
  }
}

function createWindow() {
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, 'icon.ico')
    : path.join(__dirname, '../build/icon.ico');

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 720,
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    icon: iconPath,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  Menu.setApplicationMenu(null);
  mainWindow.setMenuBarVisibility(false);
  mainWindow.webContents.setWindowOpenHandler((details) => {
    if (isSurevideotoolCamPopup(details)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: createSurevideotoolCamWindowOptions()
      };
    }

    return { action: 'allow' };
  });
  mainWindow.webContents.on('did-create-window', (window, details) => {
    if (isSurevideotoolCamPopup(details)) {
      surevideotoolCamWindow = window;
      configureSurevideotoolCamPopup(window);
    }
  });

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    console.error(`Failed to load ${validatedURL}: ${errorCode} ${errorDescription}`);

    if (!mainWindow || mainWindow.isDestroyed()) {
      return;
    }

    const loadFailureHtml = buildLoadFailureHtml(validatedURL, errorCode, errorDescription);
    void mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(loadFailureHtml)}`);
  });

  mainWindow.webContents.once('did-finish-load', () => {
    if (!virtualCameraEnabled || !mainWindow || mainWindow.isDestroyed()) {
      return;
    }

    const startResult = ensureSurevideotoolCamPublisher();
    if (!startResult.success) {
      console.error('Main-window virtual camera bridge did not start:', startResult.error ?? startResult.message);
    }
  });

  if (isDevelopment) {
    void mainWindow.loadURL(resolveRendererDevUrl());
  } else {
    const packagedIndexHtml = path.resolve(app.getAppPath(), 'dist', 'index.html');
    void mainWindow.loadFile(packagedIndexHtml);
  }
}

function registerVirtualCameraHandlers() {
  ipcMain.handle('virtual-camera:start', async () => {
    virtualCameraEnabled = true;
    appendVirtualCameraLogLine('[info] virtual-camera:start invoked.');

    const registrationResult = ensureVirtualCameraRegistration({ attemptRepair: true });
    if (!registrationResult.success) {
      logVirtualCameraEvent('error', 'Virtual camera registration failed during start.', registrationResult);
      return registrationResult;
    }

    return ensureSurevideotoolCamPublisher();
  });

  ipcMain.handle('virtual-camera:stop', async () => {
    virtualCameraEnabled = false;
    appendVirtualCameraLogLine('[info] virtual-camera:stop invoked.');
    return stopSurevideotoolCamPublisher();
  });

  ipcMain.on('virtual-camera:push-frame', (event, payload) => {
    const fromMain = mainWindow && !mainWindow.isDestroyed() && event.sender.id === mainWindow.webContents.id;
    if (!fromMain) {
      return;
    }

    if (!virtualCameraEnabled) {
      return;
    }

    let controller = surevideotoolCamPublisher;
    if (!controller || controller.stopping) {
      appendVirtualCameraLogLine('[warn] Received renderer frame without an active publisher. Attempting recovery.');
      const startResult = ensureSurevideotoolCamPublisher();
      if (!startResult.success) {
        logVirtualCameraEvent('error', 'Unable to recover the virtual camera publisher while frames are arriving.', startResult.error ?? startResult.message ?? 'Unknown error');
        return;
      }

      controller = surevideotoolCamPublisher;
      if (!controller || controller.stopping) {
        logVirtualCameraEvent('error', 'Virtual camera publisher recovery reported success but no active publisher is available.');
        return;
      }
    }

    updateRendererFrame(controller, payload);
  });
}

function registerUpdaterHandlers() {
  ipcMain.handle('get-update-state', async () => desktopUpdater?.getStateSnapshot() ?? null);

  ipcMain.handle('check-for-updates', async () => {
    if (!desktopUpdater) {
      return { success: false, error: 'Updater not initialized.' };
    }
    return desktopUpdater.checkForUpdates('ipc');
  });

  ipcMain.handle('download-update', async () => {
    if (!desktopUpdater) {
      return { success: false, error: 'Updater not initialized.' };
    }
    return desktopUpdater.downloadUpdate('ipc');
  });

  ipcMain.handle('install-update', async () => {
    if (!desktopUpdater) {
      return { success: false, error: 'Updater not initialized.' };
    }
    return desktopUpdater.installUpdate('ipc');
  });

  ipcMain.handle('open-release-page', async () => {
    if (!desktopUpdater) {
      return { success: false, error: 'Updater not initialized.' };
    }
    return desktopUpdater.openReleasePage('ipc', true);
  });
}

app.whenReady().then(async () => {
  loadEnvironmentVariables();

  if (process.platform === 'darwin') {
    await systemPreferences.askForMediaAccess('camera');
  }

  registerVirtualCameraHandlers();

  desktopUpdater = createDesktopUpdater({
    manifestUrl: resolveUpdateManifestUrl(),
    releasePageUrl: RELEASES_URL,
    logPath: path.join(app.getPath('userData'), 'updater.log'),
    currentVersion: app.getVersion(),
    isPackaged: app.isPackaged,
    platform: process.platform,
    sendState: (state) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('desktop-updater:state', state);
      }
    }
  });

  registerUpdaterHandlers();
  createWindow();
  desktopUpdater.startBackgroundChecks();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  stopSurevideotoolCamPublisher();

  if (desktopUpdater) {
    desktopUpdater.dispose();
  }
});

process.on('uncaughtException', (error) => {
  console.error('uncaughtException in Electron main process:', error);
});

process.on('unhandledRejection', (reason) => {
  console.error('unhandledRejection in Electron main process:', reason);
});
