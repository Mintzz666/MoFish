const VALID_POLICIES = new Set(['auto', 'low', 'high']);
const IDLE_FPS = 30;
const ACTIVE_FPS = 60;
const ACTIVE_GRACE_MS = 3000;
const SAMPLE_WINDOW_MS = 3000;
const LEVEL_COOLDOWN_MS = 10000;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function percentile90(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.9) - 1)];
}

/** Shared, clock-injected frame pacing and adaptive effect controller. */
export function createRenderPolicy({ now = () => globalThis.performance?.now?.() ?? Date.now() } = {}) {
  let qualityPolicy = 'auto';
  let effectsLevel = 1;
  let visible = true;
  let interacting = false;
  let lastInteractionAt = -Infinity;
  let lastRenderedAt = null;
  let windowStart = null;
  let windowSamples = [];
  let overloadedWindows = 0;
  let fastWindows = 0;
  let lastLevelChangeAt = -Infinity;
  let frames = 0;
  let totalWorkMs = 0;
  let lastWorkMs = 0;
  let smoothedWorkMs = 0;
  let presentationLagMs = 0;
  let awaitingPresentation = false;

  function resetWindow(ts = null) {
    windowStart = ts;
    windowSamples = [];
    overloadedWindows = 0;
    fastWindows = 0;
  }

  function currentTargetFps(ts = now()) {
    if (qualityPolicy === 'high') return ACTIVE_FPS;
    return interacting || ts - lastInteractionAt < ACTIVE_GRACE_MS ? ACTIVE_FPS : IDLE_FPS;
  }

  function setQualityPolicy(policy) {
    qualityPolicy = VALID_POLICIES.has(policy) ? policy : 'auto';
    const nextLevel = qualityPolicy === 'high' ? 2 : qualityPolicy === 'low' ? 0 : 1;
    if (nextLevel !== effectsLevel) lastLevelChangeAt = now();
    effectsLevel = nextLevel;
    resetWindow();
    lastRenderedAt = null;
  }

  function setActivity(activity = {}) {
    const t = now();
    if (Object.hasOwn(activity, 'visible')) {
      const nextVisible = Boolean(activity.visible);
      if (nextVisible !== visible) {
        visible = nextVisible;
        lastRenderedAt = null;
        resetWindow();
        awaitingPresentation = false;
        presentationLagMs = 0;
      }
    }
    if (Object.hasOwn(activity, 'interacting')) {
      const nextInteracting = Boolean(activity.interacting);
      if (nextInteracting !== interacting) {
        interacting = nextInteracting;
        lastInteractionAt = t;
      }
    }
  }

  function notifyInteraction() {
    lastInteractionAt = now();
  }

  function shouldRender(ts) {
    if (!visible) return false;
    // WebGL submits work asynchronously: a short JS call can still saturate a
    // rasterizer. Observe the next callback after our draw as well as JS work.
    if (awaitingPresentation && lastRenderedAt !== null) {
      const lag = Math.max(0, ts - lastRenderedAt - 1000 / ACTIVE_FPS);
      presentationLagMs = Math.max(lag, presentationLagMs * 0.95);
      awaitingPresentation = false;
    }
    if (lastRenderedAt === null) {
      lastRenderedAt = ts;
      awaitingPresentation = true;
      if (windowStart === null) windowStart = ts;
      return true;
    }
    const targetFps = currentTargetFps(ts);
    // When even 30 fps is beyond the device, don't keep a CPU/software rasterizer
    // saturated forever. Idle observation gets a work budget; interaction stays responsive.
    const frameInterval = Math.max(1000 / targetFps,
      qualityPolicy !== 'high' && targetFps === IDLE_FPS && Math.max(smoothedWorkMs,presentationLagMs) > 1000 / IDLE_FPS
        ? Math.max(smoothedWorkMs,presentationLagMs) * 1.6 : 0);
    if (ts - lastRenderedAt + 0.25 < frameInterval) return false;
    lastRenderedAt = ts;
    awaitingPresentation = true;
    if (windowStart === null) windowStart = ts;
    return true;
  }

  function evaluateWindow(ts) {
    const p90 = percentile90(windowSamples);
    if (qualityPolicy === 'auto') {
      if (p90 > 28) {
        overloadedWindows += 1;
        fastWindows = 0;
      } else if (p90 < 16) {
        fastWindows += 1;
        overloadedWindows = 0;
      } else {
        overloadedWindows = 0;
        fastWindows = 0;
      }
      if (ts - lastLevelChangeAt >= LEVEL_COOLDOWN_MS) {
        if (effectsLevel === 1 && overloadedWindows >= 2) {
          effectsLevel = 0;
          lastLevelChangeAt = ts;
          overloadedWindows = 0;
          fastWindows = 0;
        } else if (effectsLevel === 0 && fastWindows >= 5) {
          effectsLevel = 1;
          lastLevelChangeAt = ts;
          overloadedWindows = 0;
          fastWindows = 0;
        }
      }
    }
    windowSamples = [];
  }

  function recordWork(workMs, ts) {
    const duration = Number.isFinite(workMs) ? Math.max(0, workMs) : 0;
    frames += 1;
    totalWorkMs += duration;
    lastWorkMs = duration;
    smoothedWorkMs = smoothedWorkMs ? smoothedWorkMs * 0.85 + duration * 0.15 : duration;
    if (windowStart === null) windowStart = ts;
    windowSamples.push(Math.max(duration, presentationLagMs));
    if (ts - windowStart >= SAMPLE_WINDOW_MS) {
      evaluateWindow(ts);
      windowStart = ts;
    }
  }

  function getPerformanceInfo() {
    return Object.freeze({
      frames,
      totalWorkMs,
      lastWorkMs,
      presentationLagMs,
      targetFps: currentTargetFps(),
      effectsLevel,
      active: visible,
      policy: qualityPolicy
    });
  }

  return {
    setQualityPolicy,
    setActivity,
    notifyInteraction,
    shouldRender,
    recordWork,
    get effectsLevel() { return effectsLevel; },
    get performanceInfo() { return getPerformanceInfo(); }
  };
}
