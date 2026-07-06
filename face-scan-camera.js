/**
 * Live camera + immediate auto-capture for .face-scan-viewport.
 *
 * The countdown UI was intentionally removed — we snap the photo as soon as
 * the first video frame is available. The `face-scan-countdown` element and
 * the `data-face-scan-seconds` attribute on the markup are now no-ops but are
 * kept harmless so existing HTML doesn't break.
 */
function initFaceScanViewport(viewport) {
  if (viewport.dataset.faceScanReady === 'true') return;
  viewport.dataset.faceScanReady = 'true';

  const video = viewport.querySelector('.face-scan-video');
  const canvas = viewport.querySelector('.face-scan-canvas');
  const preview = viewport.querySelector('.face-scan-preview');
  const statusEl = viewport.querySelector('.face-scan-status');
  const countdownEl = viewport.querySelector('.face-scan-countdown');
  if (!video || !canvas || !preview) return;

  const autostart = viewport.dataset.faceScanAutostart !== 'false';

  let stream = null;
  let captured = false;
  let starting = false;
  let captureToken = 0;
  let captureTimer = null;

  if (countdownEl) {
    countdownEl.hidden = true;
    countdownEl.textContent = '';
  }
  viewport.classList.remove('is-counting');

  const setStatus = (message) => {
    if (!statusEl) return;
    statusEl.textContent = message || '';
    statusEl.hidden = !message;
  };

  const cancelPendingCapture = () => {
    captureToken += 1;
    if (captureTimer) {
      window.clearTimeout(captureTimer);
      captureTimer = null;
    }
    if (countdownEl) {
      countdownEl.hidden = true;
      countdownEl.textContent = '';
    }
    viewport.classList.remove('is-counting');
  };

  const playShutterTone = () => {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = 880;
      gain.gain.value = 0.12;
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.12);
      osc.onended = () => void ctx.close();
    } catch {
      /* optional feedback */
    }
  };

  const stopCamera = () => {
    cancelPendingCapture();
    if (stream) {
      stream.getTracks().forEach((track) => track.stop());
      stream = null;
    }
    video.srcObject = null;
    viewport.classList.remove('is-live');
  };

  const getVideoStream = async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('unsupported');
    }
    const attempts = [
      {
        video: {
          facingMode: { ideal: 'user' },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      },
      { video: { facingMode: 'user' }, audio: false },
      { video: true, audio: false },
    ];
    let lastError;
    for (const constraints of attempts) {
      try {
        return await navigator.mediaDevices.getUserMedia(constraints);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error('Camera unavailable');
  };

  const waitForVideoFrame = () =>
    new Promise((resolve) => {
      if (video.videoWidth > 0 && video.videoHeight > 0) {
        resolve();
        return;
      }
      const onReady = () => {
        if (video.videoWidth > 0 && video.videoHeight > 0) {
          video.removeEventListener('loadeddata', onReady);
          resolve();
        }
      };
      video.addEventListener('loadeddata', onReady);
      window.setTimeout(() => {
        video.removeEventListener('loadeddata', onReady);
        resolve();
      }, 3000);
    });

  const capturePhoto = () => {
    if (!stream || captured) return;
    const width = video.videoWidth;
    const height = video.videoHeight;
    if (!width || !height) return;

    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const mirror = viewport.dataset.faceScanMirror !== 'false';
    if (mirror) {
      ctx.translate(width, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(video, 0, 0, width, height);
    if (mirror) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }

    preview.src = canvas.toDataURL('image/jpeg', 0.9);
    preview.hidden = false;
    video.hidden = true;
    captured = true;
    viewport.classList.add('is-captured');
    viewport.classList.remove('is-live', 'is-counting');

    viewport.classList.add('is-flash');
    window.setTimeout(() => viewport.classList.remove('is-flash'), 220);

    playShutterTone();

    if (stream) {
      stream.getTracks().forEach((track) => track.stop());
      stream = null;
    }
    video.srcObject = null;

    viewport.dispatchEvent(
      new CustomEvent('face-scan-captured', {
        bubbles: true,
        detail: { dataUrl: preview.src },
      }),
    );
  };

  /**
   * Wait for the first usable video frame, then capture immediately.
   * No countdown UI, no voice prompts — the user asked for an instant snap.
   * We still give the auto-exposure ~150ms to settle so the photo isn't
   * black/over-exposed on slower devices.
   */
  const runAutoCapture = async () => {
    if (!stream || captured) return;
    const token = ++captureToken;

    await waitForVideoFrame();
    if (token !== captureToken || !stream || captured) return;

    setStatus('');

    await new Promise((resolve) => {
      captureTimer = window.setTimeout(resolve, 150);
    });
    captureTimer = null;
    if (token !== captureToken || !stream || captured) return;

    capturePhoto();
  };

  const startCamera = async () => {
    if (stream || starting || captured) return;
    starting = true;
    cancelPendingCapture();
    setStatus('Starting camera…');
    try {
      stream = await getVideoStream();
      video.srcObject = stream;
      video.setAttribute('playsinline', '');
      video.playsInline = true;
      video.muted = true;
      video.hidden = false;
      preview.hidden = true;
      await video.play();
      viewport.classList.add('is-live');
      viewport.classList.remove('is-error', 'is-captured');
      setStatus('');
      void runAutoCapture();
    } catch (error) {
      stopCamera();
      viewport.classList.add('is-error');
      if (error?.name === 'NotAllowedError' || error?.name === 'PermissionDeniedError') {
        setStatus('Camera permission denied. Allow camera access and refresh.');
      } else if (error?.message === 'unsupported') {
        setStatus('Camera is not supported in this browser.');
      } else {
        setStatus('Unable to access camera. Check permissions and try again.');
      }
    } finally {
      starting = false;
    }
  };

  const onVisibilityChange = () => {
    if (!autostart) return;
    if (document.hidden) {
      stopCamera();
      return;
    }
    if (!captured) void startCamera();
  };

  if (autostart) {
    document.addEventListener('visibilitychange', onVisibilityChange);
  }

  const observer =
    autostart && 'IntersectionObserver' in window
      ? new IntersectionObserver(
          (entries) => {
            const entry = entries.find((e) => e.target === viewport);
            if (!entry) return;
            if (entry.isIntersecting && entry.intersectionRatio > 0.15) {
              if (!captured) void startCamera();
            } else {
              stopCamera();
            }
          },
          { threshold: [0, 0.15, 0.5] },
        )
      : null;

  if (observer) {
    observer.observe(viewport);
  } else if (autostart) {
    void startCamera();
  }

  viewport._faceScanStart = () => {
    if (!captured) void startCamera();
  };

  viewport._faceScanStop = () => {
    stopCamera();
  };

  viewport._faceScanCleanup = () => {
    if (autostart) {
      document.removeEventListener('visibilitychange', onVisibilityChange);
    }
    observer?.disconnect();
    stopCamera();
    viewport.dataset.faceScanReady = 'false';
    delete viewport._faceScanStart;
    delete viewport._faceScanStop;
  };
}

function resolveFaceScanViewport(target) {
  if (!target) return null;
  if (typeof target === 'string') {
    return document.querySelector(target);
  }
  return target instanceof Element ? target : null;
}

function startFaceScanViewport(target) {
  const viewport = resolveFaceScanViewport(target);
  if (!viewport) return false;
  if (viewport.dataset.faceScanReady !== 'true') {
    initFaceScanViewport(viewport);
  }
  viewport._faceScanStart?.();
  return true;
}

function stopFaceScanViewport(target) {
  const viewport = resolveFaceScanViewport(target);
  if (!viewport) return false;
  viewport._faceScanStop?.();
  return true;
}

function initFaceScanCameras() {
  document.querySelectorAll('[data-face-scan]').forEach((viewport) => {
    initFaceScanViewport(viewport);
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initFaceScanCameras);
} else {
  initFaceScanCameras();
}

window.initFaceScanCameras = initFaceScanCameras;
window.startFaceScanViewport = startFaceScanViewport;
window.stopFaceScanViewport = stopFaceScanViewport;
