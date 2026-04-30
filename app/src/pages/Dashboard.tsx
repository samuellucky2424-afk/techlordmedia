import { useState, useRef, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Upload,
  Play,
  Square,
  Clock,
  Monitor,
  Settings,
  Plus,
  Coins,
  LoaderCircle,
} from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '@/context/AuthContext';
import { useApp } from '@/context/AppContext';
import { apiFetch } from '@/lib/api-client';
import { CREDITS_PER_SECOND } from '@/lib/billing';
import { UpdateBanner } from '@/components/UpdateBanner';
import {
  QUALITY_MODE_PROFILES,
  buildVideoInputConstraints,
  buildVideoTrackConstraints,
  clampQualityMode,
  downgradeQualityMode,
  getAdaptiveQualityMode,
  type QualityMode,
  upgradeQualityMode,
} from '@/lib/realtime-quality';


type ConnectionState = 'connecting' | 'connected' | 'generating' | 'disconnected' | 'reconnecting';

type RealtimeStats = {
  timestamp: number;
  video: {
    framesPerSecond: number;
    frameWidth: number;
    frameHeight: number;
    framesDroppedDelta: number;
    freezeCountDelta: number;
    bitrate: number;
  } | null;
  outboundVideo: {
    qualityLimitationReason: string;
    framesPerSecond: number;
    frameWidth: number;
    frameHeight: number;
    bitrate: number;
  } | null;
  connection: {
    currentRoundTripTime: number | null;
    availableOutgoingBitrate: number | null;
  };
};

type RealtimeClientEventMap = {
  connectionChange: ConnectionState;
  connectionStateChange: ConnectionState;
  stats: RealtimeStats;
  error: { message: string };
  generationTick: { seconds: number };
  diagnostic: unknown;
};

interface RealtimeClient {
  disconnect: () => void;
  set: (config: {
    prompt?: string | null;
    enhance?: boolean;
    image?: string | Blob | File | null;
  }) => Promise<void>;
  setPrompt: (text: string, options?: { enhance?: boolean }) => Promise<void>;
  getConnectionState?: () => ConnectionState;
  on: <K extends keyof RealtimeClientEventMap>(
    event: K,
    listener: (data: RealtimeClientEventMap[K]) => void,
  ) => void;
  off: <K extends keyof RealtimeClientEventMap>(
    event: K,
    listener: (data: RealtimeClientEventMap[K]) => void,
  ) => void;
}

type ReferenceImage = {
  file: File;
  name: string;
  signature: string;
};

type TransformState = {
  prompt: string;
  enhance: boolean;
  image: File | null;
  imageSignature: string | null;
};

type StreamMetrics = {
  fps: number;
  frameWidth: number;
  frameHeight: number;
  rttMs: number | null;
  limitation: string;
  bitrateKbps: number;
};

type NetworkInformationLike = EventTarget & {
  downlink?: number;
  addEventListener?: (type: 'change', listener: EventListenerOrEventListenerObject) => void;
  removeEventListener?: (type: 'change', listener: EventListenerOrEventListenerObject) => void;
};

type VideoElementWithFrameCallbacks = HTMLVideoElement & {
  requestVideoFrameCallback?: (callback: VideoFrameRequestCallback) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
  latencyHint?: string;
};

const BASE_PROMPT = `Virtually try on the garment from the reference image on the person in the video.
Keep the person's face, hair, skin tone, pose, and background exactly as seen in the live camera feed.
The output should be photorealistic and indistinguishable from a real camera recording.
Preserve natural lighting, realistic fabric texture, and accurate garment fit on the body.
Do not alter the person's face, body proportions, hair, or background in any way.
Maintain true human anatomy and normal camera softness at all times.
Never produce a cartoon, anime, illustration, painting, CGI, 3D render, or beautified filter look.`;
const DEFAULT_ENHANCE = false;
const POLLING_INTERVAL = 5000; // poll session-status every 5 s for live credit display
const TRANSFORM_SYNC_DEBOUNCE_MS = 180;
const AUTO_DOWNGRADE_SAMPLES = 3;
const AUTO_UPGRADE_SAMPLES = 10;
const RESTART_WATCHDOG_INTERVAL_MS = 3000;
const FREEZE_RESTART_THRESHOLD_MS = 12000;
const INITIAL_PROMPT_INJECTION_DELAY_MS = 500;
const INITIAL_RETRY_DELAY_MS = 1000;
const MAX_RETRY_DELAY_MS = 10000;
const RESTART_FAILURES_BEFORE_DOWNGRADE = 2;
const DECART_REALTIME_MODEL = 'lucy-vton-latest';
const MORPHLY_CAM_FRAME_WIDTH = 1280;
const MORPHLY_CAM_FRAME_HEIGHT = 720;
const MORPHLY_CAM_FRAME_INTERVAL_MS = 1000 / 30;

function createEmptyStreamMetrics(): StreamMetrics {
  return {
    fps: 0,
    frameWidth: 0,
    frameHeight: 0,
    rttMs: null,
    limitation: 'none',
    bitrateKbps: 0,
  };
}

function buildTransformSignature(transform: TransformState): string {
  return [
    transform.prompt,
    transform.enhance ? 'enhance' : 'base',
    transform.imageSignature ?? 'no-image',
  ].join('|');
}

function buildRealtimeSessionState(transform: TransformState) {
  return {
    prompt: transform.prompt,
    enhance: transform.enhance,
    image: transform.image ?? null,
  };
}

async function applyRealtimeSessionState(realtimeClient: RealtimeClient, transform: TransformState) {
  await realtimeClient.set(buildRealtimeSessionState(transform));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function drawVideoFrameCover(
  context: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  targetWidth: number,
  targetHeight: number,
) {
  const sourceWidth = video.videoWidth;
  const sourceHeight = video.videoHeight;

  if (!sourceWidth || !sourceHeight || !targetWidth || !targetHeight) {
    return;
  }

  const sourceAspect = sourceWidth / sourceHeight;
  const targetAspect = targetWidth / targetHeight;

  let sourceX = 0;
  let sourceY = 0;
  let sourceDrawWidth = sourceWidth;
  let sourceDrawHeight = sourceHeight;

  if (sourceAspect > targetAspect) {
    sourceDrawWidth = Math.max(1, Math.round(sourceHeight * targetAspect));
    sourceX = Math.max(0, Math.floor((sourceWidth - sourceDrawWidth) / 2));
  } else if (sourceAspect < targetAspect) {
    sourceDrawHeight = Math.max(1, Math.round(sourceWidth / targetAspect));
    sourceY = Math.max(0, Math.floor((sourceHeight - sourceDrawHeight) / 2));
  }

  context.drawImage(
    video,
    sourceX,
    sourceY,
    sourceDrawWidth,
    sourceDrawHeight,
    0,
    0,
    targetWidth,
    targetHeight,
  );
}

function getStartSessionErrorToast(error: unknown): string | null {
  if (!(error instanceof Error)) {
    return 'Failed to start session';
  }

  switch (error.message) {
    case 'Webcam start failed':
    case 'Decart connection was not established':
      return null;
    case 'Missing session token':
      return 'Failed to start session: missing AI token';
    default:
      return error.message || 'Failed to start session';
  }
}

function getDecartSdkErrorMessage(error: unknown): string | null {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  if (typeof error === 'object' && error !== null) {
    const candidate = error as {
      message?: unknown;
      code?: unknown;
      cause?: { message?: unknown } | unknown;
    };

    if (typeof candidate.message === 'string' && candidate.message) {
      return candidate.message;
    }

    if (
      typeof candidate.cause === 'object'
      && candidate.cause !== null
      && 'message' in candidate.cause
      && typeof candidate.cause.message === 'string'
      && candidate.cause.message
    ) {
      return candidate.cause.message;
    }

    if (typeof candidate.code === 'string' && candidate.code) {
      return candidate.code;
    }
  }

  return null;
}

function getNavigatorConnection(): NetworkInformationLike | null {
  const nav = navigator as Navigator & {
    connection?: NetworkInformationLike;
    mozConnection?: NetworkInformationLike;
    webkitConnection?: NetworkInformationLike;
  };

  return nav.connection ?? nav.mozConnection ?? nav.webkitConnection ?? null;
}

async function apiRequest<T>(endpoint: string, options?: RequestInit): Promise<T> {
  const response = await apiFetch(endpoint, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.error || errorData.message || `API Error: ${response.statusText}`);
  }

  return response.json();
}

// Preload the SDK module so it's already cached when the user clicks Start.
void import('@decartai/sdk');

function Dashboard() {
  const { user } = useAuth();
  const { credits, setCredits, setSessionStatus } = useApp();
  const navigate = useNavigate();

  const [isStreaming, setIsStreaming] = useState(false);
  const [referenceImage, setReferenceImage] = useState<ReferenceImage | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [cameraDevices, setCameraDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedCameraId, setSelectedCameraId] = useState('');
  const [prompt] = useState(BASE_PROMPT);
  const [preferredMode, setPreferredMode] = useState<QualityMode>('hd');
  const [runtimeModeCap, setRuntimeModeCap] = useState<QualityMode>('hd');
  const [connectionState, setConnectionState] = useState<ConnectionState>('disconnected');
  const [uiStatus, setUiStatus] = useState('Disconnected');
  const [isSyncingTransform, setIsSyncingTransform] = useState(false);
  const [hasRemoteFrame, setHasRemoteFrame] = useState(false);
  const [streamMetrics, setStreamMetrics] = useState<StreamMetrics>(() => createEmptyStreamMetrics());

  const fileInputRef = useRef<HTMLInputElement>(null);
  const webcamVideoRef = useRef<HTMLVideoElement>(null);
  const outputVideoRef = useRef<HTMLVideoElement>(null);
  const webcamSourceStreamRef = useRef<MediaStream | null>(null);
  const webcamStreamRef = useRef<MediaStream | null>(null);
  const realtimeClientRef = useRef<RealtimeClient | null>(null);
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const transformSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingTransformRef = useRef<TransformState | null>(null);
  const lastAppliedTransformRef = useRef<TransformState | null>(null);
  const transformInFlightRef = useRef(false);
  const clientSubscriptionsCleanupRef = useRef<(() => void) | null>(null);
  const sessionTokenRef = useRef('');
  const sessionIdRef = useRef('');
  const frameCallbackHandleRef = useRef<number | null>(null);
  const lastRemoteFrameAtRef = useRef(0);
  const lastGenerationTickAtRef = useRef(Date.now());
  const frameWatchdogIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const softReconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const restartInFlightRef = useRef(false);
  const safeStopInFlightRef = useRef(false);
  const sessionEverConnectedRef = useRef(false);
  const restartRetryDelayRef = useRef(INITIAL_RETRY_DELAY_MS);
  const restartFailureCountRef = useRef(0);
  const handleStopRef = useRef<((options?: { silent?: boolean }) => Promise<void>) | null>(null);
  const safelyStopSessionRef = useRef<(() => Promise<void>) | null>(null);
  const healthCountersRef = useRef({ poorSamples: 0, healthySamples: 0 });
  const userSelectedModeRef = useRef(false);
  const userInitiatedCameraChangeRef = useRef(false);
  const previousCameraIdRef = useRef('');
  const morphlyCamWindowRef = useRef<Window | null>(null);
  const morphlyCamVideoRef = useRef<HTMLVideoElement | null>(null);
  const morphlyCamCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const morphlyCamStatusRef = useRef<HTMLDivElement | null>(null);
  const morphlyCamPlaceholderRef = useRef<HTMLDivElement | null>(null);
  const morphlyCamWindowEnabledRef = useRef(false);
  const latestRemoteStreamRef = useRef<MediaStream | null>(null);
  const morphlyCamRenderHandleRef = useRef<number | null>(null);
  const morphlyCamLastFrameSentAtRef = useRef(0);
  const mainVirtualCamCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const mainVirtualCamRenderHandleRef = useRef<number | null>(null);
  const mainVirtualCamLastFrameSentAtRef = useRef(0);

  const promptRef = useRef(prompt);
  const referenceImageRef = useRef(referenceImage);
  const isStreamingRef = useRef(isStreaming);
  const hasRemoteFrameRef = useRef(hasRemoteFrame);
  const connectionStateRef = useRef<ConnectionState>(connectionState);
  const activeModeRef = useRef<QualityMode>('hd');
  const preferredModeRef = useRef(preferredMode);

  const activeMode = clampQualityMode(preferredMode, runtimeModeCap);
  useEffect(() => {
    promptRef.current = prompt;
  }, [prompt]);

  useEffect(() => {
    referenceImageRef.current = referenceImage;
  }, [referenceImage]);

  useEffect(() => {
    isStreamingRef.current = isStreaming;
  }, [isStreaming]);

  useEffect(() => {
    hasRemoteFrameRef.current = hasRemoteFrame;
  }, [hasRemoteFrame]);

  useEffect(() => {
    connectionStateRef.current = connectionState;
  }, [connectionState]);

  useEffect(() => {
    activeModeRef.current = activeMode;
  }, [activeMode]);

  useEffect(() => {
    preferredModeRef.current = preferredMode;
  }, [preferredMode]);

  const resetMorphlyCamRefs = useCallback(() => {
    if (morphlyCamWindowRef.current && morphlyCamRenderHandleRef.current !== null) {
      morphlyCamWindowRef.current.cancelAnimationFrame(morphlyCamRenderHandleRef.current);
    }

    morphlyCamRenderHandleRef.current = null;
    morphlyCamLastFrameSentAtRef.current = 0;
    morphlyCamWindowRef.current = null;
    morphlyCamVideoRef.current = null;
    morphlyCamCanvasRef.current = null;
    morphlyCamStatusRef.current = null;
    morphlyCamPlaceholderRef.current = null;
    morphlyCamWindowEnabledRef.current = false;
  }, []);

  const updateMorphlyCamPlaceholder = useCallback((message: string | null) => {
    const placeholder = morphlyCamPlaceholderRef.current;

    if (!placeholder) {
      return;
    }

    if (!message) {
      placeholder.style.opacity = '0';
      placeholder.style.pointerEvents = 'none';
      return;
    }

    placeholder.textContent = message;
    placeholder.style.opacity = '1';
    placeholder.style.pointerEvents = 'auto';
  }, []);

  const getMorphlyCamGuideMessage = useCallback((hasLiveVideo: boolean) => {
    if (hasLiveVideo) {
      return 'Capture this window in SplitCam or OBS. If you need a webcam device, route it through SplitCam or OBS Virtual Camera.';
    }

    if (isStreamingRef.current) {
      return 'Waiting for Surevideotool video. Keep this window selected in SplitCam or OBS Window Capture.';
    }

    return 'Start Surevideotool first, then capture this window in SplitCam or OBS. This window is not a standalone webcam device.';
  }, []);

  const updateMorphlyCamStatus = useCallback((message: string | null) => {
    const status = morphlyCamStatusRef.current;

    if (!status) {
      return;
    }

    if (!message) {
      status.textContent = '';
      status.style.opacity = '0';
      return;
    }

    status.textContent = message;
    status.style.opacity = '1';
  }, []);

  const stopMorphlyCamRenderLoop = useCallback(() => {
    const popup = morphlyCamWindowRef.current;
    if (popup && morphlyCamRenderHandleRef.current !== null) {
      popup.cancelAnimationFrame(morphlyCamRenderHandleRef.current);
    }

    morphlyCamRenderHandleRef.current = null;
  }, []);

  const stopMainVirtualCamRenderLoop = useCallback(() => {
    if (mainVirtualCamRenderHandleRef.current !== null) {
      window.cancelAnimationFrame(mainVirtualCamRenderHandleRef.current);
    }

    mainVirtualCamRenderHandleRef.current = null;
  }, []);

  const pushMorphlyCamFrame = useCallback((canvas: HTMLCanvasElement, context: CanvasRenderingContext2D) => {
    if (!window.electron?.sendVirtualCameraFrame) {
      return;
    }

    const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
    window.electron.sendVirtualCameraFrame({
      width: canvas.width,
      height: canvas.height,
      stride: canvas.width * 4,
      pixels: new Uint8ClampedArray(imageData.data),
    });
  }, []);

  const startMorphlyCamRenderLoop = useCallback(() => {
    const popup = morphlyCamWindowRef.current;
    const video = morphlyCamVideoRef.current;
    const canvas = morphlyCamCanvasRef.current;

    if (!popup || popup.closed || !video || !canvas) {
      return;
    }

    stopMorphlyCamRenderLoop();
    morphlyCamLastFrameSentAtRef.current = 0;

    const context = canvas.getContext('2d', {
      alpha: false,
      desynchronized: true,
      willReadFrequently: true,
    });

    if (!context) {
      return;
    }

    const renderFrame = () => {
      const currentPopup = morphlyCamWindowRef.current;
      const currentVideo = morphlyCamVideoRef.current;
      const currentCanvas = morphlyCamCanvasRef.current;

      if (!currentPopup || currentPopup.closed || !currentVideo || !currentCanvas) {
        morphlyCamRenderHandleRef.current = null;
        return;
      }

      context.fillStyle = '#000000';
      context.fillRect(0, 0, currentCanvas.width, currentCanvas.height);

      if (currentVideo.readyState >= 2 && currentVideo.videoWidth > 0 && currentVideo.videoHeight > 0) {
        drawVideoFrameCover(context, currentVideo, currentCanvas.width, currentCanvas.height);

        const now = currentPopup.performance?.now?.() ?? performance.now();
        if ((now - morphlyCamLastFrameSentAtRef.current) >= MORPHLY_CAM_FRAME_INTERVAL_MS) {
          pushMorphlyCamFrame(currentCanvas, context);
          morphlyCamLastFrameSentAtRef.current = now;
        }
      }

      morphlyCamRenderHandleRef.current = currentPopup.requestAnimationFrame(renderFrame);
    };

    morphlyCamRenderHandleRef.current = popup.requestAnimationFrame(renderFrame);
  }, [pushMorphlyCamFrame, stopMorphlyCamRenderLoop]);

  const startMainVirtualCamRenderLoop = useCallback(() => {
    if (!morphlyCamWindowEnabledRef.current) {
      return;
    }

    const video = outputVideoRef.current;
    if (!video) {
      return;
    }

    let canvas = mainVirtualCamCanvasRef.current;
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.width = MORPHLY_CAM_FRAME_WIDTH;
      canvas.height = MORPHLY_CAM_FRAME_HEIGHT;
      mainVirtualCamCanvasRef.current = canvas;
    }

    stopMainVirtualCamRenderLoop();
    mainVirtualCamLastFrameSentAtRef.current = 0;

    const context = canvas.getContext('2d', {
      alpha: false,
      desynchronized: true,
      willReadFrequently: true,
    });

    if (!context) {
      return;
    }

    const renderFrame = () => {
      const currentVideo = outputVideoRef.current;
      const currentCanvas = mainVirtualCamCanvasRef.current;

      if (!morphlyCamWindowEnabledRef.current || !currentVideo || !currentCanvas) {
        mainVirtualCamRenderHandleRef.current = null;
        return;
      }

      context.fillStyle = '#000000';
      context.fillRect(0, 0, currentCanvas.width, currentCanvas.height);

      if (currentVideo.readyState >= 2 && currentVideo.videoWidth > 0 && currentVideo.videoHeight > 0) {
        drawVideoFrameCover(context, currentVideo, currentCanvas.width, currentCanvas.height);

        const now = performance.now();
        if ((now - mainVirtualCamLastFrameSentAtRef.current) >= MORPHLY_CAM_FRAME_INTERVAL_MS) {
          pushMorphlyCamFrame(currentCanvas, context);
          mainVirtualCamLastFrameSentAtRef.current = now;
        }
      }

      mainVirtualCamRenderHandleRef.current = window.requestAnimationFrame(renderFrame);
    };

    mainVirtualCamRenderHandleRef.current = window.requestAnimationFrame(renderFrame);
  }, [pushMorphlyCamFrame, stopMainVirtualCamRenderLoop]);

  const renderMorphlyCamWindowShell = useCallback((popup: Window) => {
    const doc = popup.document;

    doc.open();
    doc.write(`
      <!DOCTYPE html>
      <html lang="en">
        <head>
          <meta charset="UTF-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1.0" />
          <title>Surevideotool Cam</title>
          <style>
            html, body {
              width: 100%;
              height: 100%;
              margin: 0;
              background: #000;
              overflow: hidden;
              font-family: Arial, sans-serif;
            }

            body {
              display: flex;
              align-items: center;
              justify-content: center;
            }

            #morphly-cam-root {
              position: relative;
              width: 100vw;
              height: 100vh;
              background: #000;
            }

            #morphly-cam-output {
              width: 100%;
              height: 100%;
              object-fit: contain;
              background: #000;
            }

            #morphly-cam-video {
              position: absolute;
              width: 1px;
              height: 1px;
              opacity: 0;
              pointer-events: none;
            }

            #morphly-cam-placeholder {
              position: absolute;
              inset: 0;
              display: flex;
              align-items: center;
              justify-content: center;
              padding: 24px;
              text-align: center;
              color: #f4f4f5;
              background:
                radial-gradient(circle at top, rgba(59, 130, 246, 0.16), transparent 52%),
                linear-gradient(180deg, rgba(10, 10, 10, 0.82), rgba(0, 0, 0, 0.92));
              font-size: 14px;
              line-height: 1.7;
              letter-spacing: 0.01em;
              transition: opacity 180ms ease;
            }

            #morphly-cam-status {
              position: absolute;
              left: 50%;
              bottom: 24px;
              transform: translateX(-50%);
              padding: 10px 14px;
              border: 1px solid rgba(255, 255, 255, 0.12);
              border-radius: 999px;
              background: rgba(10, 10, 10, 0.7);
              color: #f4f4f5;
              font-size: 12px;
              letter-spacing: 0.04em;
              backdrop-filter: blur(10px);
              transition: opacity 180ms ease;
            }
          </style>
        </head>
        <body>
          <div id="morphly-cam-root">
            <canvas id="morphly-cam-output" width="${MORPHLY_CAM_FRAME_WIDTH}" height="${MORPHLY_CAM_FRAME_HEIGHT}"></canvas>
            <video id="morphly-cam-video" autoplay playsinline muted></video>
            <div id="morphly-cam-placeholder">
              Start Surevideotool first, then capture this window in SplitCam or OBS. This window is not a standalone webcam device.
            </div>
            <div id="morphly-cam-status">Connecting Surevideotool cam...</div>
          </div>
        </body>
      </html>
    `);
    doc.close();
    doc.title = 'Surevideotool Cam';

    morphlyCamCanvasRef.current = doc.getElementById('morphly-cam-output') as HTMLCanvasElement | null;
    morphlyCamVideoRef.current = doc.getElementById('morphly-cam-video') as HTMLVideoElement | null;
    morphlyCamStatusRef.current = doc.getElementById('morphly-cam-status') as HTMLDivElement | null;
    morphlyCamPlaceholderRef.current = doc.getElementById('morphly-cam-placeholder') as HTMLDivElement | null;

    if (latestRemoteStreamRef.current && morphlyCamVideoRef.current) {
      morphlyCamVideoRef.current.srcObject = latestRemoteStreamRef.current;
      void morphlyCamVideoRef.current.play().catch(() => {});
      startMorphlyCamRenderLoop();
      updateMorphlyCamStatus(null);
      updateMorphlyCamPlaceholder(null);
    } else {
      updateMorphlyCamPlaceholder(getMorphlyCamGuideMessage(false));
    }

    popup.onbeforeunload = () => {
      stopMorphlyCamRenderLoop();
      resetMorphlyCamRefs();
    };
  }, [getMorphlyCamGuideMessage, resetMorphlyCamRefs, startMorphlyCamRenderLoop, stopMorphlyCamRenderLoop, updateMorphlyCamPlaceholder, updateMorphlyCamStatus]);

  const ensureMorphlyCamWindow = useCallback((statusMessage: string) => {
    if (typeof window === 'undefined') {
      return null;
    }

    const popup = morphlyCamWindowRef.current;
    if (!popup) {
      return null;
    }

    if (popup.closed) {
      resetMorphlyCamRefs();
      return null;
    }

    if (!popup.document.getElementById('morphly-cam-output') || !popup.document.getElementById('morphly-cam-video')) {
      renderMorphlyCamWindowShell(popup);
    }

    popup.document.title = 'Surevideotool Cam';
    updateMorphlyCamStatus(statusMessage);

    if (!latestRemoteStreamRef.current) {
      updateMorphlyCamPlaceholder(getMorphlyCamGuideMessage(false));
    }

    return popup;
  }, [getMorphlyCamGuideMessage, renderMorphlyCamWindowShell, resetMorphlyCamRefs, updateMorphlyCamPlaceholder, updateMorphlyCamStatus]);

  const syncMorphlyCamStream = useCallback((stream: MediaStream, statusMessage?: string | null) => {
    latestRemoteStreamRef.current = stream;

    if (!morphlyCamWindowEnabledRef.current) {
      return;
    }

    startMainVirtualCamRenderLoop();

    const popup = ensureMorphlyCamWindow(statusMessage ?? 'Preparing Surevideotool cam...');
    if (!popup || popup.closed) {
      return;
    }

    const popupVideo = morphlyCamVideoRef.current;
    if (!popupVideo) {
      return;
    }

    if (popupVideo.srcObject !== stream) {
      popupVideo.srcObject = stream;
    }

    popupVideo.playbackRate = 1;
    popupVideo.onloadedmetadata = () => {
      void popupVideo.play().catch(() => {});
      startMorphlyCamRenderLoop();
      updateMorphlyCamStatus(null);
      updateMorphlyCamPlaceholder(null);
    };

    if (popupVideo.readyState >= 2) {
      void popupVideo.play().catch(() => {});
      startMorphlyCamRenderLoop();
      updateMorphlyCamStatus(null);
      updateMorphlyCamPlaceholder(null);
    }
  }, [ensureMorphlyCamWindow, startMainVirtualCamRenderLoop, startMorphlyCamRenderLoop, updateMorphlyCamPlaceholder, updateMorphlyCamStatus]);

  const closeMorphlyCamWindow = useCallback((options?: { clearStream?: boolean }) => {
    if (options?.clearStream) {
      latestRemoteStreamRef.current = null;
    }

    stopMorphlyCamRenderLoop();
    stopMainVirtualCamRenderLoop();

    if (morphlyCamVideoRef.current) {
      morphlyCamVideoRef.current.srcObject = null;
    }

    const popup = morphlyCamWindowRef.current;
    if (popup && !popup.closed) {
      popup.close();
    }

    resetMorphlyCamRefs();
  }, [resetMorphlyCamRefs, stopMainVirtualCamRenderLoop, stopMorphlyCamRenderLoop]);

  const clearSoftReconnectTimer = useCallback(() => {
    if (softReconnectTimerRef.current) {
      clearTimeout(softReconnectTimerRef.current);
      softReconnectTimerRef.current = null;
    }
  }, []);

  const clearFrameWatchdog = useCallback(() => {
    if (frameWatchdogIntervalRef.current) {
      clearInterval(frameWatchdogIntervalRef.current);
      frameWatchdogIntervalRef.current = null;
    }
  }, []);

  const resetHealthCounters = useCallback(() => {
    healthCountersRef.current = {
      poorSamples: 0,
      healthySamples: 0,
    };
  }, []);

  const cleanupClientSubscriptions = useCallback(() => {
    clientSubscriptionsCleanupRef.current?.();
    clientSubscriptionsCleanupRef.current = null;
  }, []);

  const cancelRemoteFrameMonitor = useCallback(() => {
    const video = outputVideoRef.current as VideoElementWithFrameCallbacks | null;

    if (video?.cancelVideoFrameCallback && frameCallbackHandleRef.current !== null) {
      video.cancelVideoFrameCallback(frameCallbackHandleRef.current);
    }

    frameCallbackHandleRef.current = null;
  }, []);

  const markRemoteFrameFresh = useCallback(() => {
    lastRemoteFrameAtRef.current = performance.now();

    if (!hasRemoteFrameRef.current) {
      hasRemoteFrameRef.current = true;
      setHasRemoteFrame(true);
    }
  }, []);

  const startRemoteFrameMonitor = useCallback(() => {
    cancelRemoteFrameMonitor();

    const video = outputVideoRef.current as VideoElementWithFrameCallbacks | null;
    if (!video?.requestVideoFrameCallback) {
      return;
    }

    const onFrame: VideoFrameRequestCallback = () => {
      markRemoteFrameFresh();
      frameCallbackHandleRef.current = video.requestVideoFrameCallback?.(onFrame) ?? null;
    };

    frameCallbackHandleRef.current = video.requestVideoFrameCallback(onFrame);
  }, [cancelRemoteFrameMonitor, markRemoteFrameFresh]);

  const stopWebcam = useCallback(() => {
    if (webcamStreamRef.current) {
      webcamStreamRef.current.getTracks().forEach((track) => track.stop());
      webcamStreamRef.current = null;
    }

    if (webcamSourceStreamRef.current) {
      webcamSourceStreamRef.current.getTracks().forEach((track) => track.stop());
      webcamSourceStreamRef.current = null;
    }

    if (webcamVideoRef.current) {
      webcamVideoRef.current.srcObject = null;
    }
  }, []);

  const disconnectFromDecart = useCallback((options?: { skipStateUpdate?: boolean }) => {
    clearSoftReconnectTimer();
    clearFrameWatchdog();
    cleanupClientSubscriptions();
    sessionEverConnectedRef.current = false;

    if (transformSyncTimerRef.current) {
      clearTimeout(transformSyncTimerRef.current);
      transformSyncTimerRef.current = null;
    }

    transformInFlightRef.current = false;
    pendingTransformRef.current = null;
    setIsSyncingTransform(false);

    if (realtimeClientRef.current) {
      realtimeClientRef.current.disconnect();
      realtimeClientRef.current = null;
    }

    cancelRemoteFrameMonitor();
    lastRemoteFrameAtRef.current = 0;
    hasRemoteFrameRef.current = false;
    setHasRemoteFrame(false);

    if (outputVideoRef.current) {
      outputVideoRef.current.srcObject = null;
    }

    closeMorphlyCamWindow();

    lastAppliedTransformRef.current = null;
    lastGenerationTickAtRef.current = Date.now();
    setStreamMetrics(createEmptyStreamMetrics());
    if (!options?.skipStateUpdate) {
      setConnectionState('disconnected');
    }
  }, [cancelRemoteFrameMonitor, cleanupClientSubscriptions, clearFrameWatchdog, clearSoftReconnectTimer, closeMorphlyCamWindow]);

  const getDesiredTransformState = useCallback((): TransformState => ({
    prompt: promptRef.current,
    enhance: DEFAULT_ENHANCE,
    image: referenceImageRef.current?.file ?? null,
    imageSignature: referenceImageRef.current?.signature ?? null,
  }), []);

  const applyTrackProfileWithFallback = useCallback(async (
    track: MediaStreamTrack,
    requestedMode: QualityMode,
  ): Promise<QualityMode> => {
    let attemptedMode = requestedMode;

    while (true) {
      try {
        track.contentHint = attemptedMode === 'fast' ? 'motion' : 'detail';
        await track.applyConstraints(buildVideoTrackConstraints(attemptedMode));
        return attemptedMode;
      } catch (error) {
        if (attemptedMode === 'fast') {
          throw error;
        }

        attemptedMode = downgradeQualityMode(attemptedMode);
      }
    }
  }, []);

  const startWebcam = useCallback(async (
    requestedMode: QualityMode,
    options?: { forceNewStream?: boolean; silent?: boolean },
  ): Promise<MediaStream | null> => {
    if (!options?.forceNewStream && webcamSourceStreamRef.current) {
      const existingTrack = webcamSourceStreamRef.current.getVideoTracks()[0];

      if (existingTrack && existingTrack.readyState === 'live') {
        try {
          const appliedMode = await applyTrackProfileWithFallback(existingTrack, requestedMode);

          webcamStreamRef.current = webcamSourceStreamRef.current;

          if (appliedMode !== requestedMode) {
            setRuntimeModeCap((currentMode) => clampQualityMode(currentMode, appliedMode));
          }

          if (webcamVideoRef.current) {
            webcamVideoRef.current.srcObject = webcamSourceStreamRef.current;
          }

          return webcamSourceStreamRef.current;
        } catch (error) {
          console.warn('Failed to update camera constraints in place:', error);
        }
      }
    }

    let attemptedMode = requestedMode;

    while (true) {
      try {
        const nextStream = await navigator.mediaDevices.getUserMedia(
          buildVideoInputConstraints(attemptedMode, selectedCameraId || undefined),
        );
        const nextTrack = nextStream.getVideoTracks()[0];

        if (nextTrack) {
          nextTrack.contentHint = attemptedMode === 'fast' ? 'motion' : 'detail';
        }

        const previousSourceStream = webcamSourceStreamRef.current;
        webcamSourceStreamRef.current = nextStream;
        webcamStreamRef.current = nextStream;

        if (webcamVideoRef.current) {
          webcamVideoRef.current.srcObject = nextStream;
        }

        if (previousSourceStream && previousSourceStream !== nextStream) {
          previousSourceStream.getTracks().forEach((track) => track.stop());
        }

        if (attemptedMode !== requestedMode) {
          setRuntimeModeCap((currentMode) => clampQualityMode(currentMode, attemptedMode));
        }

        return nextStream;
      } catch (error) {
        const isNotReadable =
          error instanceof DOMException && error.name === 'NotReadableError';

        // Camera is locked by another app — quality downgrade won't help.
        // Try once more without an exact deviceId so the browser can pick
        // any available camera instead of insisting on the busy one.
        if (isNotReadable && selectedCameraId) {
          try {
            const fallbackStream = await navigator.mediaDevices.getUserMedia(
              buildVideoInputConstraints(attemptedMode, undefined),
            );
            const fallbackTrack = fallbackStream.getVideoTracks()[0];

            if (fallbackTrack) {
              fallbackTrack.contentHint = attemptedMode === 'fast' ? 'motion' : 'detail';
            }

            const previousSourceStream = webcamSourceStreamRef.current;
            webcamSourceStreamRef.current = fallbackStream;
            webcamStreamRef.current = fallbackStream;

            if (webcamVideoRef.current) {
              webcamVideoRef.current.srcObject = fallbackStream;
            }

            if (previousSourceStream && previousSourceStream !== fallbackStream) {
              previousSourceStream.getTracks().forEach((track) => track.stop());
            }

            return fallbackStream;
          } catch {
            // fallback also failed — fall through to the give-up path below
          }
        }

        if (attemptedMode === 'fast') {
          console.error('Webcam error:', error);

          if (!options?.silent) {
            toast.error(
              isNotReadable
                ? 'Camera or microphone is already in use by another application. Close it and try again.'
                : 'Failed to access camera or microphone. Please check device permissions.',
            );
          }

          return null;
        }

        attemptedMode = downgradeQualityMode(attemptedMode);
      }
    }
  }, [applyTrackProfileWithFallback, selectedCameraId]);

  const flushTransformSync = useCallback(async (nextTransform: TransformState) => {
    const realtimeClient = realtimeClientRef.current;
    if (!realtimeClient) {
      return;
    }

    const nextSignature = buildTransformSignature(nextTransform);
    const lastSignature = lastAppliedTransformRef.current
      ? buildTransformSignature(lastAppliedTransformRef.current)
      : null;

    if (nextSignature === lastSignature) {
      return;
    }

    if (transformInFlightRef.current) {
      pendingTransformRef.current = nextTransform;
      return;
    }

    transformInFlightRef.current = true;
    setIsSyncingTransform(true);

    try {
      await applyRealtimeSessionState(realtimeClient, nextTransform);

      lastAppliedTransformRef.current = nextTransform;
    } catch (error) {
      console.error('Failed to sync live transformation:', error);
      toast.error('Live style update stalled. Recovering stream...');
    } finally {
      transformInFlightRef.current = false;
      setIsSyncingTransform(false);

      if (pendingTransformRef.current) {
        const queuedTransform = pendingTransformRef.current;
        pendingTransformRef.current = null;

        if (
          !lastAppliedTransformRef.current ||
          buildTransformSignature(queuedTransform) !== buildTransformSignature(lastAppliedTransformRef.current)
        ) {
          void flushTransformSync(queuedTransform);
        }
      }
    }
  }, []);

  const queueTransformSync = useCallback((nextTransform: TransformState, immediate = false) => {
    pendingTransformRef.current = nextTransform;

    if (transformSyncTimerRef.current) {
      clearTimeout(transformSyncTimerRef.current);
    }

    transformSyncTimerRef.current = setTimeout(() => {
      transformSyncTimerRef.current = null;
      const queuedTransform = pendingTransformRef.current;
      pendingTransformRef.current = null;

      if (queuedTransform) {
        void flushTransformSync(queuedTransform);
      }
    }, immediate ? 0 : TRANSFORM_SYNC_DEBOUNCE_MS);
  }, [flushTransformSync]);

  const evaluateStreamHealth = useCallback((stats: RealtimeStats) => {
    const profile = QUALITY_MODE_PROFILES[activeModeRef.current];
    const inboundFps = stats.video?.framesPerSecond ?? 0;
    const outboundFps = stats.outboundVideo?.framesPerSecond ?? 0;
    const observedFps = inboundFps || outboundFps;
    const rttMs = stats.connection.currentRoundTripTime !== null
      ? stats.connection.currentRoundTripTime * 1000
      : null;
    const droppedFrames = stats.video?.framesDroppedDelta ?? 0;
    const freezeCount = stats.video?.freezeCountDelta ?? 0;
    const limitation = stats.outboundVideo?.qualityLimitationReason ?? 'none';
    const availableOutgoingBitrate = stats.connection.availableOutgoingBitrate ?? null;
    const counters = healthCountersRef.current;

    const severeDegradation =
      freezeCount > 0 ||
      droppedFrames > 8 ||
      observedFps < Math.max(8, profile.targetFps - 12) ||
      (rttMs !== null && rttMs > 450) ||
      (availableOutgoingBitrate !== null && availableOutgoingBitrate < 900000);

    const poorQuality =
      severeDegradation ||
      limitation === 'bandwidth' ||
      limitation === 'cpu' ||
      droppedFrames > 3 ||
      observedFps < profile.targetFps - 5 ||
      (rttMs !== null && rttMs > 260);

    const healthyQuality =
      !poorQuality &&
      limitation === 'none' &&
      observedFps >= Math.max(18, profile.targetFps - 2) &&
      freezeCount === 0 &&
      droppedFrames <= 1 &&
      (rttMs === null || rttMs < 180);

    if (poorQuality) {
      counters.poorSamples += severeDegradation ? 2 : 1;
      counters.healthySamples = 0;
    } else if (healthyQuality) {
      counters.healthySamples += 1;
      counters.poorSamples = Math.max(0, counters.poorSamples - 1);
    } else {
      counters.poorSamples = Math.max(0, counters.poorSamples - 1);
      counters.healthySamples = 0;
    }

    if (counters.poorSamples >= AUTO_DOWNGRADE_SAMPLES) {
      counters.poorSamples = 0;
      counters.healthySamples = 0;
      setRuntimeModeCap((currentMode) => downgradeQualityMode(currentMode));
    }

    if (counters.healthySamples >= AUTO_UPGRADE_SAMPLES) {
      counters.healthySamples = 0;
      setRuntimeModeCap((currentMode) => upgradeQualityMode(currentMode, preferredModeRef.current));
    }
  }, []);

  const handleRealtimeStats = useCallback((stats: RealtimeStats) => {
    const inboundFps = Math.round(stats.video?.framesPerSecond ?? 0);
    const outboundFps = Math.round(stats.outboundVideo?.framesPerSecond ?? 0);
    const bitrate = stats.video?.bitrate ?? stats.outboundVideo?.bitrate ?? 0;

    setStreamMetrics({
      fps: inboundFps || outboundFps,
      frameWidth: stats.video?.frameWidth ?? stats.outboundVideo?.frameWidth ?? 0,
      frameHeight: stats.video?.frameHeight ?? stats.outboundVideo?.frameHeight ?? 0,
      rttMs: stats.connection.currentRoundTripTime !== null
        ? Math.round(stats.connection.currentRoundTripTime * 1000)
        : null,
      limitation: stats.outboundVideo?.qualityLimitationReason ?? 'none',
      bitrateKbps: Math.round(bitrate / 1000),
    });

    if ((stats.video?.framesPerSecond ?? 0) > 1 || (stats.outboundVideo?.framesPerSecond ?? 0) > 1) {
      markRemoteFrameFresh();
    }

    evaluateStreamHealth(stats);
  }, [evaluateStreamHealth, markRemoteFrameFresh]);

  const connectToDecart = useCallback(async (
    stream: MediaStream,
    apiToken: string,
    initialTransform: TransformState,
    options?: { isRecovery?: boolean },
  ): Promise<RealtimeClient | null> => {
    try {
      if (morphlyCamWindowEnabledRef.current && morphlyCamWindowRef.current && !morphlyCamWindowRef.current.closed) {
        updateMorphlyCamStatus(options?.isRecovery ? 'Reconnecting Surevideotool cam...' : 'Connecting Surevideotool cam...');
        updateMorphlyCamPlaceholder(getMorphlyCamGuideMessage(false));
      }

      const { createDecartClient, models } = await import('@decartai/sdk');
      const client = createDecartClient({ apiKey: apiToken });
      const model = models.realtime(DECART_REALTIME_MODEL);

      const realtimeClient = await client.realtime.connect(stream, {
        model,
        onRemoteStream: (editedStream: MediaStream) => {
          const video = outputVideoRef.current as VideoElementWithFrameCallbacks | null;
          if (!video) {
            return;
          }

          if (video.srcObject !== editedStream) {
            video.srcObject = editedStream;
          }

          video.playbackRate = 1;
          video.latencyHint = 'interactive';

          const playRemote = () => {
            void video.play().catch(() => {});
            markRemoteFrameFresh();
            startRemoteFrameMonitor();
          };

          video.onloadedmetadata = playRemote;

          if (video.readyState >= 2) {
            playRemote();
          }

          syncMorphlyCamStream(
            editedStream,
            options?.isRecovery ? 'Reconnecting Surevideotool cam...' : 'Connecting Surevideotool cam...',
          );
        },
        initialState: {
          prompt: {
            text: initialTransform.prompt,
            enhance: initialTransform.enhance,
          },
          image: initialTransform.image ?? undefined,
        },
      });

      // connect() resolving means the WebRTC/WebSocket handshake is complete and
      // initialState has already been applied by the SDK. Do NOT call set() here
      // again — a redundant set() immediately after connect resets the generation
      // pipeline and causes the visible "hook" freeze on startup.
      sessionEverConnectedRef.current = true;

      cleanupClientSubscriptions();

      // True only once onConnectionChange has seen 'connected'/'generating' at least once.
      // Used to distinguish the SDK's normal post-connect state cycle from a real mid-session reconnect.
      // wasConnectedBeforeLastReconnect must NOT use sessionEverConnectedRef (which is set before
      // handlers register) — otherwise the first 'reconnecting' event always triggers a recovery .set().
      let hasSeenConnectedViaHandler = false;
      let wasConnectedBeforeLastReconnect = false;
      let initialTransformReinforced = false;

      const onConnectionChange = (nextState: ConnectionState) => {
        const previousState = connectionStateRef.current;

        // Some SDK builds emit both events for the same transition; ignore duplicate state notifications.
        if (previousState === nextState) {
          return;
        }

        connectionStateRef.current = nextState;
        setConnectionState(nextState);
        console.log('Realtime state:', nextState);

        if (nextState === 'reconnecting') {
          // Only treat as a true mid-session reconnect if connected was seen through our handler.
          // This prevents the SDK's normal post-connect state cycle from triggering recovery .set().
          wasConnectedBeforeLastReconnect = hasSeenConnectedViaHandler;
          setUiStatus('Reconnecting...');
        }

        if (nextState === 'connected' || nextState === 'generating') {
          hasSeenConnectedViaHandler = true;
          sessionEverConnectedRef.current = true;
          setUiStatus('Live');
          restartRetryDelayRef.current = INITIAL_RETRY_DELAY_MS;
          restartFailureCountRef.current = 0;

          if (!initialTransformReinforced) {
            initialTransformReinforced = true;

            void sleep(INITIAL_PROMPT_INJECTION_DELAY_MS)
              .then(async () => {
                if (realtimeClientRef.current !== (realtimeClient as RealtimeClient)) {
                  return;
                }

                await applyRealtimeSessionState(realtimeClient as RealtimeClient, initialTransform);
                lastAppliedTransformRef.current = initialTransform;
              })
              .catch((error) => {
                console.error('Failed to reinforce initial realtime session state:', error);
              });
          }
        }

        if (nextState === 'disconnected') {
          setUiStatus('Disconnected');
          // Only stop if the session was actually established — not during initial WebSocket handshake.
          if (!restartInFlightRef.current && sessionEverConnectedRef.current) {
            void safelyStopSessionRef.current?.();
          }
        }

        if (
          previousState === 'reconnecting' &&
          (nextState === 'connected' || nextState === 'generating') &&
          wasConnectedBeforeLastReconnect  // Skip on initial connect; only reapply on true SDK-level reconnects.
        ) {
          const recoveryTransform = getDesiredTransformState();
          void sleep(INITIAL_PROMPT_INJECTION_DELAY_MS)
            .then(() => applyRealtimeSessionState(realtimeClient as RealtimeClient, recoveryTransform))
            .then(() => {
              lastAppliedTransformRef.current = recoveryTransform;
            })
            .catch((error) => {
              console.error('Failed to reapply realtime session state after reconnect:', error);
            });
        }

        if (nextState === 'connected' || nextState === 'generating') {
          clearSoftReconnectTimer();
        }

      };

      const onStats = (stats: RealtimeStats) => {
        handleRealtimeStats(stats);
      };

      const onError = (error: { message: string }) => {
        console.error('[Decart] realtime error:', error);
      };

      const onGenerationTick = () => {
        lastGenerationTickAtRef.current = Date.now();
        markRemoteFrameFresh();
      };

      realtimeClient.on('connectionChange', onConnectionChange);
      realtimeClient.on('stats', onStats);
      realtimeClient.on('error', onError);
      realtimeClient.on('generationTick', onGenerationTick);

      clientSubscriptionsCleanupRef.current = () => {
        realtimeClient.off('connectionChange', onConnectionChange);
        realtimeClient.off('stats', onStats);
        realtimeClient.off('error', onError);
        realtimeClient.off('generationTick', onGenerationTick);
      };

      realtimeClientRef.current = realtimeClient as RealtimeClient;
      lastAppliedTransformRef.current = initialTransform;
      lastGenerationTickAtRef.current = Date.now();
      resetHealthCounters();
      setConnectionState(realtimeClient.getConnectionState?.() ?? 'connecting');
      setUiStatus('Live');
      setStreamMetrics(createEmptyStreamMetrics());
      hasRemoteFrameRef.current = false;
      setHasRemoteFrame(false);
      lastRemoteFrameAtRef.current = performance.now();

      if (!options?.isRecovery) {
        toast.success('Connected to AI!');
      }

      return realtimeClient as RealtimeClient;
    } catch (error) {
      console.error('[Decart] SDK error:', error);

      if (!options?.isRecovery) {
        const errorMessage = getDecartSdkErrorMessage(error);
        toast.error(
          errorMessage
            ? `Failed to connect to AI: ${errorMessage}`
            : 'Failed to connect to AI',
        );
      }

      return null;
    }
  }, [
    cleanupClientSubscriptions,
    clearSoftReconnectTimer,
    getMorphlyCamGuideMessage,
    handleRealtimeStats,
    markRemoteFrameFresh,
    resetHealthCounters,
    syncMorphlyCamStream,
    startRemoteFrameMonitor,
    updateMorphlyCamPlaceholder,
    updateMorphlyCamStatus,
  ]);

  const restartRealtimeSession = useCallback(async (
    reason: string,
    options?: { immediate?: boolean },
  ) => {
    if (!isStreamingRef.current || restartInFlightRef.current || !sessionTokenRef.current) {
      return;
    }

    restartInFlightRef.current = true;
    setUiStatus('Reconnecting...');

    try {
      if (!options?.immediate) {
        await sleep(restartRetryDelayRef.current);
      }

      const existingTrack = webcamSourceStreamRef.current?.getVideoTracks()[0];
      const currentStream = webcamStreamRef.current && webcamSourceStreamRef.current && existingTrack?.readyState === 'live'
        ? webcamStreamRef.current
        : await startWebcam(activeModeRef.current, { forceNewStream: true, silent: true });

      if (!currentStream) {
        return;
      }

      disconnectFromDecart({ skipStateUpdate: true });

      const reconnectedClient = await connectToDecart(
        currentStream,
        sessionTokenRef.current,
        getDesiredTransformState(),
        { isRecovery: true },
      );

      if (!reconnectedClient) {
        throw new Error(`Restart failed: ${reason}`);
      }

      restartRetryDelayRef.current = INITIAL_RETRY_DELAY_MS;
      restartFailureCountRef.current = 0;
      setUiStatus('Live');
    } catch (error) {
      console.error('[Decart] Restart failed:', error);
      restartFailureCountRef.current += 1;
      restartRetryDelayRef.current = Math.min(restartRetryDelayRef.current * 2, MAX_RETRY_DELAY_MS);

      if (restartFailureCountRef.current >= RESTART_FAILURES_BEFORE_DOWNGRADE) {
        setRuntimeModeCap((currentMode) => downgradeQualityMode(currentMode));
      }
    } finally {
      restartInFlightRef.current = false;
    }
  }, [connectToDecart, disconnectFromDecart, getDesiredTransformState, startWebcam]);

  const safelyStopSession = useCallback(async () => {
    if (safeStopInFlightRef.current) {
      return;
    }

    safeStopInFlightRef.current = true;

    try {
      try {
        realtimeClientRef.current?.disconnect();
      } catch (error) {
        console.warn('Failed to disconnect realtime client cleanly:', error);
      }

      await handleStopRef.current?.({ silent: true });
    } finally {
      safeStopInFlightRef.current = false;
    }
  }, []);

  const handleStop = useCallback(async (options?: { silent?: boolean }) => {
    try {
      if (sessionTokenRef.current) {
        const response = await apiRequest<{ remainingCredits?: number }>('/end-session', {
          method: 'POST',
          body: JSON.stringify({ userId: user?.id }),
        });

        if (response.remainingCredits !== undefined) {
          setCredits(response.remainingCredits);
        }
      }
    } catch (error) {
      console.error('Stop session error:', error);
    }

    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }

    // Disarm the virtual camera publisher and disable the popup window
    morphlyCamWindowEnabledRef.current = false;
    if (window.electron) {
      void window.electron.invoke('virtual-camera:stop').catch((err: unknown) => {
        console.warn('Failed to stop virtual camera publisher:', err);
      });
    }

    sessionTokenRef.current = '';
    sessionIdRef.current = '';
    restartRetryDelayRef.current = INITIAL_RETRY_DELAY_MS;
    restartFailureCountRef.current = 0;
    setRuntimeModeCap('hd');
    resetHealthCounters();
    clearSoftReconnectTimer();
    clearFrameWatchdog();
    disconnectFromDecart();
    stopWebcam();
    setIsStreaming(false);
    setSessionStatus('IDLE');
    setUiStatus('Disconnected');

    if (!options?.silent) {
      toast.info('Session stopped');
    }
  }, [
    clearFrameWatchdog,
    clearSoftReconnectTimer,
    disconnectFromDecart,
    resetHealthCounters,
    setCredits,
    setSessionStatus,
    stopWebcam,
    user?.id,
  ]);

  useEffect(() => {
    handleStopRef.current = handleStop;
  }, [handleStop]);

  useEffect(() => {
    safelyStopSessionRef.current = safelyStopSession;
  }, [safelyStopSession]);

  // Polls /api/session-status every 5 s while streaming.
  // The server computes the live remaining balance from elapsed time — no
  // frontend billing logic. Credits are deducted server-side by end-session.
  const pollSessionStatus = useCallback(async () => {
    if (!user?.id) return;
    try {
      const response = await apiRequest<{
        credits: number;
        remainingCredits?: number;
        shouldStop: boolean;
        forceEnd?: boolean;
      }>(`/session-status?userId=${user.id}`);

      const live = response.remainingCredits ?? response.credits;
      setCredits(live);

      if (response.shouldStop || response.forceEnd) {
        await handleStop({ silent: true });
        toast.error('Session auto-ended - Insufficient credits');
      }
    } catch (error) {
      console.error('Poll error:', error);
    }
  }, [handleStop, setCredits, user?.id]);

  const enumerateCameras = useCallback(async () => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const videoDevices = devices.filter((device) => device.kind === 'videoinput');
      setCameraDevices(videoDevices);

      if (videoDevices.length > 0 && !selectedCameraId) {
        const builtinCamera = videoDevices.find((device) =>
          device.label.toLowerCase().includes('integrated') ||
          device.label.toLowerCase().includes('built-in') ||
          device.label.toLowerCase().includes('facetime') ||
          device.label.toLowerCase().includes('internal'),
        );

        setSelectedCameraId(builtinCamera?.deviceId || videoDevices[0].deviceId);
      }
    } catch (error) {
      console.error('Failed to enumerate cameras:', error);
    }
  }, [selectedCameraId]);

  useEffect(() => () => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
    }

    if (transformSyncTimerRef.current) {
      clearTimeout(transformSyncTimerRef.current);
    }

    clearSoftReconnectTimer();
    clearFrameWatchdog();
    cleanupClientSubscriptions();
    cancelRemoteFrameMonitor();
    closeMorphlyCamWindow({ clearStream: true });
    realtimeClientRef.current?.disconnect();
    webcamStreamRef.current?.getTracks().forEach((track) => track.stop());
    webcamSourceStreamRef.current?.getTracks().forEach((track) => track.stop());
  }, [cancelRemoteFrameMonitor, cleanupClientSubscriptions, clearFrameWatchdog, clearSoftReconnectTimer, closeMorphlyCamWindow]);

  useEffect(() => {
    enumerateCameras();
    navigator.mediaDevices.addEventListener('devicechange', enumerateCameras);
    return () => navigator.mediaDevices.removeEventListener('devicechange', enumerateCameras);
  }, [enumerateCameras]);

  useEffect(() => {
    const connection = getNavigatorConnection();

    const updateAdaptiveNetworkMode = () => {
      const nextDownlink = connection?.downlink ?? null;
      const recommendedMode = getAdaptiveQualityMode(nextDownlink);

      if (!userSelectedModeRef.current) {
        setPreferredMode(recommendedMode);
      }
    };

    updateAdaptiveNetworkMode();

    if (connection?.addEventListener) {
      connection.addEventListener('change', updateAdaptiveNetworkMode);

      return () => {
        connection.removeEventListener?.('change', updateAdaptiveNetworkMode);
      };
    }

    return undefined;
  }, []);

  useEffect(() => {
    if (!isStreaming) {
      hasRemoteFrameRef.current = false;
      clearFrameWatchdog();
      setHasRemoteFrame(false);
      return undefined;
    }

    return undefined;
  }, [clearFrameWatchdog, isStreaming]);

  useEffect(() => {
    if (!isStreaming) {
      clearSoftReconnectTimer();
      return;
    }

    if (connectionState === 'disconnected' && !restartInFlightRef.current && sessionEverConnectedRef.current) {
      clearSoftReconnectTimer();
      void safelyStopSession();
      return undefined;
    }

    if (connectionState === 'connected' || connectionState === 'generating' || connectionState === 'connecting' || connectionState === 'reconnecting') {
      clearSoftReconnectTimer();
    }

    return undefined;
  }, [clearSoftReconnectTimer, connectionState, isStreaming, safelyStopSession]);

  useEffect(() => {
    if (!isStreaming) {
      clearFrameWatchdog();
      return;
    }

    clearFrameWatchdog();
    frameWatchdogIntervalRef.current = setInterval(() => {
      const currentState = connectionStateRef.current;
      if (!['connected', 'generating', 'reconnecting'].includes(currentState)) {
        return;
      }

      const now = Date.now();
      const generationLag = now - lastGenerationTickAtRef.current;
      const frameLag = now - lastRemoteFrameAtRef.current;

      if (generationLag > FREEZE_RESTART_THRESHOLD_MS && frameLag > FREEZE_RESTART_THRESHOLD_MS) {
        console.warn('Stream frozen. Restarting realtime session...');
        void restartRealtimeSession('generation-tick-watchdog');
      }
    }, RESTART_WATCHDOG_INTERVAL_MS);

    return clearFrameWatchdog;
  }, [clearFrameWatchdog, isStreaming, restartRealtimeSession]);

  useEffect(() => {
    if (!isStreaming) {
      return;
    }

    void startWebcam(activeMode, { silent: true }).catch((error) => {
      console.error('Failed to apply camera profile:', error);
    });
  }, [activeMode, isStreaming, startWebcam]);

  useEffect(() => {
    if (!isStreaming || !realtimeClientRef.current) {
      return;
    }

    queueTransformSync({
      prompt,
      enhance: DEFAULT_ENHANCE,
      image: referenceImage?.file ?? null,
      imageSignature: referenceImage?.signature ?? null,
    });
  }, [
    isStreaming,
    prompt,
    queueTransformSync,
    referenceImage?.file,
    referenceImage?.signature,
  ]);

  useEffect(() => {
    if (!selectedCameraId) {
      return;
    }

    if (!previousCameraIdRef.current) {
      previousCameraIdRef.current = selectedCameraId;
      return;
    }

    if (previousCameraIdRef.current === selectedCameraId) {
      return;
    }

    previousCameraIdRef.current = selectedCameraId;

    if (!isStreaming) {
      userInitiatedCameraChangeRef.current = false;
      return;
    }

    if (!userInitiatedCameraChangeRef.current) {
      return;
    }

    if (!['connected', 'generating'].includes(connectionStateRef.current)) {
      return;
    }

    void (async () => {
      const stream = await startWebcam(activeMode, {
        forceNewStream: true,
        silent: true,
      });

      if (stream) {
        await restartRealtimeSession('camera-switched', { immediate: true });
      }

      userInitiatedCameraChangeRef.current = false;
    })();
  }, [activeMode, isStreaming, restartRealtimeSession, selectedCameraId, startWebcam]);

  const handleStart = async () => {
    setIsLoading(true);
    setConnectionState('connecting');
    setUiStatus('Connecting...');
    setRuntimeModeCap('hd');
    resetHealthCounters();

    // Arm the virtual camera publisher. The live frames come from the main
    // Morphly output stream; the popup, if opened, is only an optional mirror.
    morphlyCamWindowEnabledRef.current = true;
    const virtualCameraStartPromise = window.electron
      ? window.electron.invoke('virtual-camera:start').catch((err: unknown) => {
          console.warn('Failed to arm virtual camera publisher:', err);
          return {
            success: false,
            error: err instanceof Error ? err.message : 'Unknown virtual camera error',
          };
        })
      : Promise.resolve(null);

    try {
      const [virtualCameraStartResult, startResponse, stream] = await Promise.all([
        virtualCameraStartPromise,
        apiRequest<{
          allowed: boolean;
          token?: string;
          error?: string;
          credits?: number;
          maxSeconds?: number;
          sessionId?: string;
        }>('/start-session', {
          method: 'POST',
          body: JSON.stringify({ userId: user?.id }),
        }),
        startWebcam(activeMode, { forceNewStream: true }),
      ]);

      if (virtualCameraStartResult && virtualCameraStartResult.success === false) {
        const virtualCameraMessage = virtualCameraStartResult.error || virtualCameraStartResult.message || 'Surevideotool virtual camera is unavailable';
        console.warn('Surevideotool virtual camera is unavailable:', virtualCameraMessage);
        toast.error(virtualCameraMessage);
      }

      if (!startResponse.allowed) {
        toast.error(startResponse.error || 'Insufficient credits');
        stopWebcam();
        closeMorphlyCamWindow({ clearStream: true });
        morphlyCamWindowEnabledRef.current = false;
        setIsLoading(false);
        return;
      }

      if (startResponse.credits !== undefined) {
        setCredits(startResponse.credits);
      }

      const sessionToken = startResponse.token || '';

      if (!stream) {
        throw new Error('Webcam start failed');
      }

      if (!sessionToken) {
        throw new Error('Missing session token');
      }

      sessionTokenRef.current = sessionToken;
      sessionIdRef.current = startResponse.sessionId || '';

      const realtimeClient = await connectToDecart(
        stream,
        sessionToken,
        getDesiredTransformState(),
      );

      if (!realtimeClient) {
        throw new Error('Decart connection was not established');
      }

      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
      }

      pollIntervalRef.current = setInterval(pollSessionStatus, POLLING_INTERVAL);
      setIsStreaming(true);
      setSessionStatus('LIVE');
      setUiStatus('Live');
    } catch (error) {
      console.error('Start session error:', error);
      const toastMessage = getStartSessionErrorToast(error);
      if (toastMessage) {
        toast.error(toastMessage);
      }

      if (sessionTokenRef.current) {
        await apiRequest('/end-session', {
          method: 'POST',
          body: JSON.stringify({ userId: user?.id }),
        }).catch((rollbackError) => {
          console.error('Failed to roll back session start:', rollbackError);
        });
      }

      sessionTokenRef.current = '';
      morphlyCamWindowEnabledRef.current = false;
      stopWebcam();
      disconnectFromDecart();
      closeMorphlyCamWindow({ clearStream: true });
      setIsStreaming(false);
      setSessionStatus('IDLE');
      setUiStatus('Disconnected');
    } finally {
      setIsLoading(false);
    }
  };

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';

    if (!file) {
      return;
    }

    setReferenceImage({
      file,
      name: file.name,
      signature: `${file.name}:${file.size}:${file.lastModified}`,
    });

    if (isStreaming) {
      toast.info('Updating reference image...');
    } else {
      toast.success('Reference image selected. Click Start to begin streaming.');
    }
  };

  const handleModeChange = (mode: string) => {
    if (!mode) {
      return;
    }

    userSelectedModeRef.current = true;
    setPreferredMode(mode as QualityMode);
  };

  const handleCameraChange = (cameraId: string) => {
    if (!cameraId || cameraId === selectedCameraId) {
      return;
    }

    userInitiatedCameraChangeRef.current = true;
    setSelectedCameraId(cameraId);
  };

  const getRemainingSeconds = () => Math.floor(credits / CREDITS_PER_SECOND);

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;

    if (mins > 0) {
      return `~${mins}m ${secs}s`;
    }

    return `~${secs}s`;
  };

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-black font-sans text-white">
      <main className="relative flex flex-1 items-center justify-center overflow-hidden bg-[#000000] shadow-inner">
        <UpdateBanner />
        <video
          id="output"
          ref={outputVideoRef}
          autoPlay
          playsInline
          muted
          onLoadedData={markRemoteFrameFresh}
          onPlaying={markRemoteFrameFresh}
          className="h-full w-full object-cover transition-[opacity,filter] duration-200"
          style={{
            display: isStreaming ? 'block' : 'none',
            opacity: hasRemoteFrame ? 1 : 0.85,
            willChange: 'transform, opacity',
            transform: 'translateZ(0)',
            backfaceVisibility: 'hidden',
            imageRendering: 'auto',
          }}
        />

        {!isStreaming && (
          <div className="flex flex-col items-center justify-center gap-5 text-[#3F3F46]">
            <Monitor className="h-[60px] w-[60px] stroke-[1]" />
            <span className="text-xs font-semibold tracking-[0.2em] text-[#4A4A4A]">CAMERA FEED OFFLINE</span>
          </div>
        )}

        <input
          type="file"
          title="Upload image"
          ref={fileInputRef}
          onChange={handleFileChange}
          accept="image/*"
          className="hidden"
          id="image-upload"
        />

        {isStreaming && (isLoading || isSyncingTransform || connectionState === 'reconnecting' || !hasRemoteFrame) && (
          <div className="pointer-events-none absolute inset-x-0 bottom-8 z-20 flex justify-center px-6">
            <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-black/55 px-4 py-2 text-xs text-white/90 shadow-xl shadow-black/30 backdrop-blur-md">
              <LoaderCircle className="h-4 w-4 animate-spin" />
              <span>
                {isSyncingTransform
                  ? 'Applying prompt/image changes without reconnecting...'
                  : connectionState === 'reconnecting'
                    ? 'Reconnecting stream...'
                    : 'Preparing realtime output...'}
              </span>
            </div>
          </div>
        )}

        {isStreaming && (
          <div className="pointer-events-none absolute left-4 top-4 z-20 inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-black/55 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-white/80 backdrop-blur-md">
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-rose-500/70" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-rose-500" />
            </span>
            Live
          </div>
        )}
      </main>

      <footer className="relative z-10 flex flex-col gap-1.5 border-t border-white/5 bg-[#0A0A0A] px-2.5 py-1.5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            onClick={handleStart}
            disabled={isStreaming || isLoading}
            className={`flex h-7 items-center gap-1.5 rounded border px-2.5 transition-all ${
              isStreaming
                ? 'border-[#133C29] bg-[#122A1F] text-[#22C55E] opacity-50'
                : 'border-[#133C29] bg-[#122A1F] text-[#22C55E] hover:bg-[#153828]'
            }`}
          >
            <Play className="h-3 w-3 fill-current" />
            <span className="text-[11px] font-semibold tracking-wide">{isLoading ? 'Starting' : 'Start'}</span>
          </button>

          <button
            onClick={() => void handleStop()}
            disabled={!isStreaming}
            className="flex h-7 items-center gap-1.5 rounded border border-[#2A2A2A] bg-[#1E1E1E] px-2.5 text-[#737373] transition-all hover:text-[#A3A3A3] disabled:opacity-50"
          >
            <Square className="h-3 w-3 fill-current opacity-70" />
            <span className="text-[11px] font-medium">Stop</span>
          </button>

          <button
            onClick={() => fileInputRef.current?.click()}
            className="flex h-7 items-center gap-1.5 rounded border border-[#2A2A2A] bg-[#1E1E1E] px-2.5 text-[#737373] transition-all hover:text-[#A3A3A3]"
          >
            <Upload className="h-3 w-3 opacity-80" />
            <span className="text-[11px] font-medium">{referenceImage ? 'Change' : 'Upload'}</span>
          </button>

          <select
            value={preferredMode}
            onChange={(event) => handleModeChange(event.target.value)}
            title="Select performance mode"
            aria-label="Select performance mode"
            className="h-7 rounded border border-[#2A2A2A] bg-[#1A1A1A] px-1.5 text-[11px] font-medium text-[#D4D4D8] transition-colors focus:border-[#3A3A3A] focus:outline-none"
          >
            <option value="fast">Fast</option>
            <option value="balanced">Balanced</option>
            <option value="hd">HD</option>
          </select>

          {cameraDevices.length >= 1 && (
            <select
              value={selectedCameraId}
              onChange={(event) => handleCameraChange(event.target.value)}
              title="Select camera"
              className="hidden h-7 max-w-[160px] rounded border border-[#2A2A2A] bg-[#1E1E1E] px-1.5 text-[11px] text-[#A3A3A3] transition-colors focus:border-[#3A3A3A] focus:outline-none md:inline-flex"
            >
              {cameraDevices.map((device, index) => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.label || `Camera ${index + 1}`}
                </option>
              ))}
            </select>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1.5 sm:justify-end">
          <div className="flex h-9 items-center gap-2 rounded-md border border-[#222222] bg-[#111111] px-2">
            <div className="flex flex-col leading-tight">
              <span className="text-[8px] font-bold uppercase tracking-[0.18em] text-[#A1A1AA]">Credits</span>
              <div className="flex items-center gap-1">
                <Coins className="h-3 w-3 text-blue-400" />
                <span className="text-[11px] font-bold text-[#22C55E] tabular-nums">{Math.round(credits).toLocaleString()}</span>
              </div>
            </div>
            <button
              onClick={() => navigate('/subscription')}
              className="flex h-6 items-center gap-1 rounded-sm bg-white px-2 text-[10px] font-bold text-black shadow-sm transition-colors hover:bg-[#E5E5E5]"
            >
              <Plus className="h-3 w-3 stroke-[3]" />
              Buy
            </button>
            <button
              title="Settings"
              aria-label="Settings"
              onClick={() => navigate('/settings')}
              className="flex h-6 w-6 items-center justify-center rounded-sm border border-[#2A2A2A] bg-[#1A1A1A] text-[#A1A1AA] transition-colors hover:border-[#3A3A3A] hover:text-white"
            >
              <Settings className="h-3.5 w-3.5" />
            </button>
          </div>

          <div className="flex h-9 min-w-[120px] items-center gap-2 rounded-md border border-[#0F284B] bg-[#0E1524] px-2">
            <Clock className="h-3.5 w-3.5 stroke-[2.5] text-[#3B82F6]" />
            <div className="flex flex-col leading-tight">
              <span className="text-[8px] font-bold uppercase tracking-[0.18em] text-[#60A5FA]">Remaining</span>
              <span className="text-[11px] font-bold text-[#E5E5E5] tabular-nums">{formatTime(getRemainingSeconds())}</span>
              <span className="text-[9px] text-[#6B7280]">
                {(streamMetrics.limitation === 'none' ? 'No throttling' : `${streamMetrics.limitation} limited`)} · {uiStatus}
              </span>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}

export default Dashboard;
