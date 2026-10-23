#!/usr/bin/env node

// Reproducible local rendering benchmark for frozen and candidate static builds.
// Uses the same headless Chromium/SwiftShader flags as tests/e2e/cloud-e2e.mjs.

import { spawn } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DECOR_KINDS, DECOR_MAX, FISH_TYPES, KEY, LOOK_VERSION,
  addDecor, initial, makeFish, starterDecor, validate
} from '../web/model.js';
import { startPreviewServer } from './serve.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_EVIDENCE_DIR = path.join(repo, '.local', 'v02-20261023');
const FIXED_NOW = Date.parse('2026-10-23T04:00:00.000Z');
const BASE_SEED = 0x4d6f4669;
const VIEWPORT = { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false };
const REQUESTED_FULL_COUNTS = { plant: 14, rock: 6, wood: 4 };
const DEFAULT_CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
  process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Google/Chrome/Application/chrome.exe')
].filter(Boolean);

function parseArgs(argv) {
  const args = { dir: null, out: null, mode: null, samples: 3, seconds: undefined, chrome: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dir') args.dir = argv[++i];
    else if (arg === '--out') args.out = argv[++i];
    else if (arg === '--mode') args.mode = argv[++i];
    else if (arg === '--samples') args.samples = Number(argv[++i]);
    else if (arg === '--seconds') args.seconds = Number(argv[++i]);
    else if (arg === '--chrome') args.chrome = argv[++i];
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`未知参数：${arg}`);
  }
  if (args.help) return args;
  if (!args.dir || !args.out || !['baseline', 'candidate', 'soak'].includes(args.mode)) {
    throw new Error('用法：node scripts/performance-check.mjs --dir <静态目录> --out <JSON> --mode baseline|candidate|soak [--samples 3] [--seconds 60]');
  }
  if (args.samples < 1 || !Number.isInteger(args.samples)) throw new Error('--samples 必须是正整数');
  if (args.seconds !== undefined && (!Number.isFinite(args.seconds) || args.seconds <= 0)) throw new Error('--seconds 必须大于 0');
  if (args.mode === 'soak' && args.samples !== 3) throw new Error('soak 模式不使用 --samples');
  return args;
}

function help() {
  console.log([
    'MoFish 本地渲染基准：',
    '  node scripts/performance-check.mjs --dir <静态目录> --out <JSON> --mode baseline|candidate|soak',
    '  baseline/candidate：每场景预热 10 秒，默认采样 60 秒 × 3 次；',
    '  soak：默认持续 900 秒，包含 20 轮 2D/3D/画质切换及 50 次造景换型。',
    '  可用 --samples N、--seconds N 覆盖对应时长。'
  ].join('\n'));
}

function chooseChrome(explicit) {
  const candidate = explicit || process.env.MOFISH_CHROME_PATH
    || DEFAULT_CHROME_CANDIDATES.find(p => existsSync(p));
  if (!candidate || !existsSync(candidate)) {
    throw new Error('未找到 Chrome/Chromium；请通过 --chrome 或 MOFISH_CHROME_PATH 指定。');
  }
  return candidate;
}

function writeJsonIncremental(file, data) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`);
  renameSync(temp, file);
}

function makeScenario(name) {
  const layoutSeed = (BASE_SEED ^ (name === 'full' ? 0x00f011 : 0x000301)) >>> 0;
  const state = initial(FIXED_NOW);
  state.layout = { v: LOOK_VERSION, seed: layoutSeed };
  state.decor = starterDecor(layoutSeed);
  state.fish = Array.from({ length: name === 'full' ? 12 : 3 }, (_, index) => makeFish(index, FIXED_NOW, {
    id: `v02-fish-${index + 1}`,
    species: FISH_TYPES[index % FISH_TYPES.length].id,
    seed: (BASE_SEED + index * 7919) >>> 0
  }));
  state.savedAt = FIXED_NOW;

  if (name === 'full') {
    const counts = state.decor.reduce((acc, item) => ({ ...acc, [item.kind]: acc[item.kind] + 1 }), { plant: 0, rock: 0, wood: 0 });
    for (const kind of ['plant', 'rock', 'wood']) {
      const bucket = DECOR_KINDS[kind];
      const types = bucket.types;
      while (counts[kind] < REQUESTED_FULL_COUNTS[kind]) {
        const sequence = counts[kind];
        const { state: next, object } = addDecor(
          state, kind, types[sequence % types.length].id,
          (BASE_SEED + (kind === 'plant' ? 0x1000 : kind === 'rock' ? 0x2000 : 0x3000) + sequence * 101) >>> 0,
          FIXED_NOW
        );
        object.id = `v02-${kind}-${sequence + 1}`;
        state.decor = next.decor;
        counts[kind] += 1;
      }
    }
  }

  return validate(state, FIXED_NOW);
}

function preloadSource(state, prefs, seed = BASE_SEED) {
  const guestKey = JSON.stringify(KEY);
  const stateJson = JSON.stringify(JSON.stringify(state));
  const prefsJson = prefs === null ? 'null' : JSON.stringify(JSON.stringify(prefs));
  return `(() => {
    try {
      const fixedNow = ${FIXED_NOW};
      const seed0 = ${seed >>> 0};
      let seed = seed0 || 1;
      Math.random = () => {
        seed = (seed + 0x6d2b79f5) >>> 0;
        let t = seed;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
      const NativeDate = Date;
      class FixedDate extends NativeDate {
        constructor(...args) { super(...(args.length ? args : [fixedNow])); }
        static now() { return fixedNow; }
      }
      Object.setPrototypeOf(FixedDate, NativeDate);
      globalThis.Date = FixedDate;
      localStorage.setItem(${guestKey}, ${stateJson});
      localStorage.removeItem('mofish.auth.session');
      localStorage.removeItem('mofish.auth.flow');
      ${prefsJson === 'null' ? "localStorage.removeItem('mofish.prefs');" : `localStorage.setItem('mofish.prefs', ${prefsJson});`}
    } catch (error) { globalThis.__mofishSeedError = String(error); }
  })();`;
}

let nextCdpId = 0;
async function connect(wsUrl, { pageDomains = true } = {}) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  const events = [];
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    if (ws.readyState !== WebSocket.OPEN) { reject(new Error('task browser connection closed')); return; }
    const id = ++nextCdpId;
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`CDP 超时：${method}`)); }, 20000);
    pending.set(id, { resolve, reject, timeout });
    ws.send(JSON.stringify({ id, method, params }));
  });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('CDP 连接超时')), 15000);
    ws.addEventListener('open', () => { clearTimeout(timeout); resolve(); }, { once: true });
    ws.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('CDP 连接失败')); }, { once: true });
  });
  ws.addEventListener('close', () => {
    for (const call of pending.values()) { clearTimeout(call.timeout); call.reject(new Error('CDP 连接已关闭')); }
    pending.clear();
  });
  ws.addEventListener('message', event => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.id && pending.has(message.id)) {
      const call = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(call.timeout);
      message.error ? call.reject(new Error(`${message.error.code} ${message.error.message}`)) : call.resolve(message.result);
    } else if (message.method) events.push(message);
  });
  if (pageDomains) {
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Log.enable');
    await send('Network.enable');
    await send('Performance.enable');
  }
  return { ws, send, events, async close() { try { ws.close(); } catch {} } };
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function evaluate(page, expression) {
  const result = await page.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) {
    const detail = result.exceptionDetails.exception?.description || result.exceptionDetails.text;
    throw new Error(`页面异常：${detail}`);
  }
  return result.result.value;
}

async function waitFor(page, expression, { timeoutMs = 60000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = await evaluate(page, expression);
      if (value) return value;
    } catch {}
    await sleep(intervalMs);
  }
  throw new Error(`等待页面条件超时：${expression}`);
}

async function openSamplePage(browser, debugPort, appUrl, state, prefs, seed) {
  const { browserContextId } = await browser.send('Target.createBrowserContext', { disposeOnDetach: true });
  let page;
  try {
    const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank', browserContextId });
    let target;
    for (let attempt = 0; attempt < 40 && !target; attempt += 1) {
      const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
      target = targets.find(item => item.id === targetId);
      if (!target) await sleep(100);
    }
    if (!target) throw new Error(`找不到新建页面 target=${targetId}`);
    page = await connect(target.webSocketDebuggerUrl);
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: preloadSource(state, prefs, seed) });
    await page.send('Emulation.setDeviceMetricsOverride', VIEWPORT);
    await page.send('Network.setCacheDisabled', { cacheDisabled: true });
    await page.send('Network.setBypassServiceWorker', { bypass: true });
    try { await browser.send('Target.activateTarget', { targetId }); } catch {}
    page.events.length = 0;
    await page.send('Page.navigate', { url: appUrl });
    await page.send('Page.bringToFront');
    await waitFor(page, `(() => {
      const aquarium = document.getElementById('aquarium');
      const app = window.__mofish;
      return aquarium && app && app.renderer ? {renderer:app.renderer, fish:app.state?.fish?.length, decor:app.state?.decor?.length} : null;
    })()`);
    await evaluate(page, `(() => {
      document.getElementById('aquarium')?.scrollIntoView({block:'center', inline:'nearest'});
      return true;
    })()`);
    await waitFor(page, `(() => {
      const aquarium = document.getElementById('aquarium');
      const rect = aquarium?.getBoundingClientRect();
      const app = window.__mofish;
      return !document.hidden && rect && rect.top < innerHeight && rect.bottom > 0 && app?.renderer === '3d'
        ? {renderer:app.renderer, fish:app.state?.fish?.length, decor:app.state?.decor?.length} : null;
    })()`);
    return { page, browserContextId, targetId };
  } catch (error) {
    if (page) await page.close();
    try { await browser.send('Target.disposeBrowserContext', { browserContextId }); } catch {}
    throw error;
  }
}

function metricsMap(result) {
  return Object.fromEntries((result.metrics || []).map(item => [item.name, item.value]));
}

async function getPageMetrics(page) {
  const result = await page.send('Performance.getMetrics');
  return metricsMap(result);
}

async function captureAppSnapshot(page) {
  return evaluate(page, `(() => {
    const app = window.__mofish || null;
    const state = app?.state || null;
    const canvas = document.getElementById('tank');
    let webgl = null;
    try {
      const gl = canvas?.getContext('webgl2') || canvas?.getContext('webgl');
      if (gl) {
        const ext = gl.getExtension('WEBGL_debug_renderer_info');
        webgl = {
          vendor: ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
          renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
          version: gl.getParameter(gl.VERSION)
        };
      }
    } catch (error) { webgl = {error:String(error)}; }
    const clone = value => value == null ? null : JSON.parse(JSON.stringify(value));
    return {
      appPresent: Boolean(app), renderer: app?.renderer ?? null, quality: app?.quality ?? null,
      editMode: app?.editMode ?? null, selectedDecor: app?.selectedDecor ?? null,
      state: state ? {fish:state.fish.length, decor:state.decor.length,
        decorCounts:state.decor.reduce((counts,item)=>{counts[item.kind]=(counts[item.kind]||0)+1;return counts;},{})} : null,
      rendererInfo: clone(app?.renderInfo ?? app?.rendererInfo ?? null),
      resourceInfo: clone(app?.resourceInfo ?? null),
      renderPolicy: clone(app?.performanceInfo ?? app?.renderPolicy ?? app?.policySnapshot ?? null),
      prefs: (() => { try { return JSON.parse(localStorage.getItem('mofish.prefs') || '{}'); } catch { return null; } })(),
      webgl, devicePixelRatio:devicePixelRatio, innerWidth, innerHeight,
      documentHidden:document.hidden, seedError:window.__mofishSeedError || null
    };
  })()`);
}

async function collectRequestSummary(page) {
  const requests = new Map();
  for (const { method, params } of page.events) {
    if (method === 'Network.requestWillBeSent') {
      requests.set(params.requestId, {
        requestId: params.requestId,
        url: params.request?.url || '',
        method: params.request?.method || 'GET',
        type: params.type || null,
        initiatorType: params.initiator?.type || null
      });
    } else if (method === 'Network.responseReceived') {
      const request = requests.get(params.requestId) || { requestId: params.requestId };
      request.status = params.response?.status ?? null;
      request.mimeType = params.response?.mimeType || '';
      request.fromDiskCache = params.response?.fromDiskCache === true;
      request.fromServiceWorker = params.response?.fromServiceWorker === true;
      request.contentLength = Number(params.response?.headers?.['content-length']) || null;
      requests.set(params.requestId, request);
    } else if (method === 'Network.loadingFinished') {
      const request = requests.get(params.requestId);
      if (request) request.encodedBytes = Number(params.encodedDataLength) || 0;
    } else if (method === 'Network.loadingFailed') {
      const request = requests.get(params.requestId);
      if (request) request.failure = params.errorText || 'loading failed';
    }
  }
  const scripts = [...requests.values()].filter(request => request.type === 'Script'
    || /(?:javascript|ecmascript)/i.test(request.mimeType || '')
    || /\.m?js(?:[?#]|$)/i.test(request.url || ''));
  const scriptBodies = [];
  for (const script of scripts) {
    let bodyBytes = null;
    if (script.status >= 200 && script.status < 300) {
      try {
        const result = await page.send('Network.getResponseBody', { requestId: script.requestId });
        bodyBytes = result.base64Encoded ? Buffer.from(result.body, 'base64').length : Buffer.byteLength(result.body, 'utf8');
      } catch { /* cached or evicted resources retain their transport metadata */ }
    }
    scriptBodies.push({
      url: script.url, status: script.status ?? null, mimeType: script.mimeType || null,
      bodyBytes, encodedBytes: script.encodedBytes ?? null,
      contentLength: script.contentLength ?? null, fromDiskCache: script.fromDiskCache === true
    });
  }
  const all = [...requests.values()];
  return {
    requestCount: all.length,
    successfulCount: all.filter(item => item.status >= 200 && item.status < 400).length,
    failed: all.filter(item => item.failure).map(({ url, failure }) => ({ url, failure })),
    jsResponseCount: scriptBodies.length,
    jsBodyBytes: scriptBodies.reduce((sum, item) => sum + (item.bodyBytes ?? item.encodedBytes ?? 0), 0),
    jsEncodedBytes: scriptBodies.reduce((sum, item) => sum + (item.encodedBytes ?? 0), 0),
    jsResponses: scriptBodies,
    resources: all.map(({ requestId, ...resource }) => resource)
  };
}

async function getRuntimeInfo(browser, page) {
  let version = null;
  let system = null;
  try { version = await browser.send('Browser.getVersion'); } catch (error) { version = { error: error.message }; }
  try { system = await browser.send('SystemInfo.getInfo'); } catch (error) { system = { error: error.message }; }
  let webgl = null;
  try { webgl = await captureAppSnapshot(page); } catch (error) { webgl = { error: error.message }; }
  return { browserVersion: version, systemInfo: system, initialPage: webgl };
}

function summarize(values) {
  const nums = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!nums.length) return { count: 0, mean: null, median: null, p95: null, min: null, max: null };
  const mean = nums.reduce((sum, value) => sum + value, 0) / nums.length;
  const at = p => nums[Math.min(nums.length - 1, Math.ceil(p * nums.length) - 1)];
  return { count: nums.length, mean, median: at(0.5), p95: at(0.95), min: nums[0], max: nums.at(-1) };
}

async function startRafObserver(page) {
  return evaluate(page, `(() => {
    const collector = {intervals:[], longTasks:[], active:true, previous:null, dropped:0};
    window.__mofishPerfCollector = collector;
    const raf = timestamp => {
      if (!collector.active) return;
      if (collector.previous !== null) collector.intervals.push(timestamp - collector.previous);
      collector.previous = timestamp;
      requestAnimationFrame(raf);
    };
    try {
      if ('PerformanceObserver' in window && PerformanceObserver.supportedEntryTypes?.includes('longtask')) {
        const observer = new PerformanceObserver(entries => {
          for (const entry of entries.getEntries()) collector.longTasks.push({startTime:entry.startTime,duration:entry.duration});
        });
        observer.observe({type:'longtask', buffered:false});
        collector.observer = observer;
      }
    } catch (error) { collector.observerError = String(error); }
    requestAnimationFrame(raf);
    return {started:true, longTaskObserver:Boolean(collector.observer)};
  })()`);
}

async function stopRafObserver(page) {
  return evaluate(page, `(() => {
    const collector = window.__mofishPerfCollector;
    if (!collector) return null;
    collector.active = false;
    collector.observer?.disconnect();
    const values = collector.intervals;
    const longs = collector.longTasks;
    const sorted = [...values].sort((a,b)=>a-b);
    const at = p => sorted.length ? sorted[Math.min(sorted.length-1,Math.ceil(p*sorted.length)-1)] : null;
    return {
      intervals:values,
      intervalSummary:{count:values.length,mean:values.length?values.reduce((a,b)=>a+b,0)/values.length:null,
        median:at(.5),p95:at(.95),max:sorted.at(-1)??null},
      longTasks:longs,
      longTaskSummary:{count:longs.length,totalDurationMs:longs.reduce((sum,item)=>sum+item.duration,0),
        maxDurationMs:longs.reduce((max,item)=>Math.max(max,item.duration),0)},
      observerError:collector.observerError||null
    };
  })()`);
}

async function consoleErrors(page) {
  const errors = [];
  for (const event of page.events) {
    if (event.method === 'Log.entryAdded' && event.params.entry?.level === 'error') errors.push(event.params.entry.text);
    else if (event.method === 'Runtime.consoleAPICalled' && event.params.type === 'error') {
      errors.push((event.params.args || []).map(item => item.value ?? item.description ?? '').join(' '));
    } else if (event.method === 'Runtime.exceptionThrown') {
      errors.push(event.params.exceptionDetails?.exception?.description || event.params.exceptionDetails?.text || 'runtime exception');
    }
  }
  return errors;
}

async function warmup(page, seconds) {
  console.log(`  预热 ${seconds}s；页面保持前台，鱼缸在视口内`);
  await sleep(seconds * 1000);
  const snapshot = await captureAppSnapshot(page);
  if (snapshot.documentHidden) throw new Error('采样页面进入后台，拒绝记录被节流的数据');
  if (snapshot.renderer !== '3d') throw new Error(`3D 渲染不可用：renderer=${snapshot.renderer}`);
  return snapshot;
}

async function runMeasuredSample({ browser, debugPort, previewUrl, scenario, scenarioIndex, sampleIndex, prefs, seed, seconds, output, record }) {
  const state = makeScenario(scenario);
  const appUrl = `${previewUrl}/?v02=${scenario}-${scenarioIndex}-${sampleIndex}`;
  const { page, browserContextId, targetId } = await openSamplePage(browser, debugPort, appUrl, state, prefs, seed);
  const meta = {
    id: `${scenario}-${String(sampleIndex).padStart(2, '0')}`,
    scenario, sample: sampleIndex,
    requestedCounts: { fish: state.fish.length, decor: scenario === 'full' ? { ...REQUESTED_FULL_COUNTS } : null },
    actualCounts: {
      fish: state.fish.length,
      decor: state.decor.reduce((counts,item) => { counts[item.kind] += 1; return counts; }, { plant:0,rock:0,wood:0 })
    },
    caps: { totalDecor: DECOR_MAX, perKind: Object.fromEntries(Object.entries(DECOR_KINDS).map(([kind,bucket]) => [kind,bucket.max])) },
    viewport: { ...VIEWPORT }, seed, fixedDate: new Date(FIXED_NOW).toISOString(),
    preferences: prefs, warmupSeconds: 10, requestedMeasurementSeconds: seconds,
    startedAt: new Date().toISOString()
  };
  try {
    const loaded = await captureAppSnapshot(page);
    meta.loadedState = loaded.state;
    if (loaded.seedError) throw new Error(`预置本机存档失败：${loaded.seedError}`);
    if (loaded.state?.fish !== state.fish.length || loaded.state?.decor !== state.decor.length) {
      throw new Error(`存档未被静态版本接受：requested fish=${state.fish.length}/decor=${state.decor.length}, loaded=${JSON.stringify(loaded.state)}`);
    }
    const runtime = await getRuntimeInfo(browser, page);
    if (!record.runtime) record.runtime = runtime;
    meta.browser = runtime.browserVersion;
    meta.gpu = runtime.systemInfo;
    meta.webgl = loaded.webgl;
    const warmed = await warmup(page, 10);
    meta.warmedSnapshot = warmed;
    await startRafObserver(page);
    const startMetrics = await getPageMetrics(page);
    const intervals = [];
    const started = process.hrtime.bigint();
    let lastMetrics = startMetrics;
    let previous = started;
    const intervalDuration = 5;
    const intervalCount = Math.ceil(seconds / intervalDuration);
    for (let step = 1; step <= intervalCount; step += 1) {
      const targetSeconds = Math.min(seconds, step * intervalDuration);
      const targetMs = targetSeconds * 1000;
      const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
      await sleep(Math.max(0, targetMs - elapsedMs));
      const now = process.hrtime.bigint();
      const current = await getPageMetrics(page);
      const wallSeconds = Number(now - previous) / 1e9;
      const taskDelta = Number(current.TaskDuration) - Number(lastMetrics.TaskDuration);
      intervals.push({
        elapsedSeconds: Number(now - started) / 1e9,
        durationSeconds: wallSeconds,
        taskDurationSeconds: Number.isFinite(taskDelta) ? taskDelta : null,
        cpuWorkMsPerSecond: Number.isFinite(taskDelta) && wallSeconds > 0 ? taskDelta / wallSeconds * 1000 : null,
        jsHeapUsedBytes: Number.isFinite(current.JSHeapUsedSize) ? current.JSHeapUsedSize : null,
        jsHeapTotalBytes: Number.isFinite(current.JSHeapTotalSize) ? current.JSHeapTotalSize : null
      });
      lastMetrics = current;
      previous = now;
      console.log(`  ${meta.id} ${Math.min(targetSeconds, seconds).toFixed(0)}/${seconds}s · CPU ${intervals.at(-1).cpuWorkMsPerSecond?.toFixed(1) ?? 'n/a'} ms/s · heap ${(intervals.at(-1).jsHeapUsedBytes / 1048576)?.toFixed(1) ?? 'n/a'} MiB`);
    }
    const elapsed = Number(process.hrtime.bigint() - started) / 1e9;
    const finalMetrics = await getPageMetrics(page);
    const raf = await stopRafObserver(page);
    const finalSnapshot = await captureAppSnapshot(page);
    const requests = await collectRequestSummary(page);
    const errors = await consoleErrors(page);
    const cpu = intervals.map(item => item.cpuWorkMsPerSecond).filter(Number.isFinite);
    const heaps = intervals.map(item => item.jsHeapUsedBytes).filter(Number.isFinite);
    const meanTaskSeconds = Number(finalMetrics.TaskDuration) - Number(startMetrics.TaskDuration);
    const wallSeconds = Number(process.hrtime.bigint() - started) / 1e9;
    Object.assign(meta, {
      completedAt: new Date().toISOString(), elapsedSeconds: elapsed,
      metrics: {
        taskDurationSeconds: Number.isFinite(meanTaskSeconds) ? meanTaskSeconds : null,
        cpuWorkMsPerSecond: Number.isFinite(meanTaskSeconds) && wallSeconds > 0 ? meanTaskSeconds / wallSeconds * 1000 : null,
        cpuWorkIntervals: summarize(cpu),
        jsHeapUsedBytes: finalMetrics.JSHeapUsedSize ?? null,
        jsHeapUsedMiB: Number.isFinite(finalMetrics.JSHeapUsedSize) ? finalMetrics.JSHeapUsedSize / 1048576 : null,
        jsHeapSamples: summarize(heaps), jsHeapTotalBytes: finalMetrics.JSHeapTotalSize ?? null,
        rafIntervalMs: raf?.intervalSummary ?? null, rafIntervals: raf?.intervals ?? [],
        longTaskSummary: raf?.longTaskSummary ?? null, longTasks: raf?.longTasks ?? [],
        rendererInfo: finalSnapshot.rendererInfo, resourceInfo: finalSnapshot.resourceInfo,
        renderPolicy: finalSnapshot.renderPolicy,
        finalSnapshot, intervals, requests, consoleErrors: errors
      }
    });
    record.samples.push(meta);
    record.updatedAt = new Date().toISOString();
    writeJsonIncremental(output, record);
    console.log(`  完成 ${meta.id}: CPU ${meta.metrics.cpuWorkMsPerSecond?.toFixed(1) ?? 'n/a'} ms/s, RAF p95 ${meta.metrics.rafIntervalMs?.p95?.toFixed(2) ?? 'n/a'} ms, ${requests.requestCount} requests / ${requests.jsBodyBytes} JS bytes`);
    return meta;
  } catch (error) {
    meta.error = error.message;
    meta.failedAt = new Date().toISOString();
    record.failures.push(meta);
    record.updatedAt = new Date().toISOString();
    writeJsonIncremental(output, record);
    throw error;
  } finally {
    await page.close();
    try { await browser.send('Target.disposeBrowserContext', { browserContextId }); } catch {}
    try { await browser.send('Target.closeTarget', { targetId }); } catch {}
  }
}

async function getGpuIdentity(browser) {
  let version = null;
  let systemInfo = null;
  try { version = await browser.send('Browser.getVersion'); } catch (error) { version = { error: error.message }; }
  try { systemInfo = await browser.send('SystemInfo.getInfo'); } catch (error) { systemInfo = { error: error.message }; }
  return { version, systemInfo };
}

async function runSoak({ browser, debugPort, previewUrl, prefs, output, record, seconds }) {
  const state = makeScenario('full');
  const appUrl = `${previewUrl}/?v02=soak`;
  const { page, browserContextId, targetId } = await openSamplePage(browser, debugPort, appUrl, state, prefs, BASE_SEED);
  try {
    const initial = await captureAppSnapshot(page);
    if (initial.state?.fish !== 12 || initial.state?.decor !== state.decor.length) {
      throw new Error(`soak 存档未加载：${JSON.stringify(initial.state)}`);
    }
    await warmup(page, 10);
    await evaluate(page, `document.getElementById('aquarium')?.scrollIntoView({block:'center'})`);
    // Warm lazy shader/selection resources before comparing memory. A first-use
    // upload is bounded initialization, not a retained-resource leak.
    await evaluate(page, `(() => {
      document.getElementById('mode-decor').click();
      const picker=document.getElementById('decor-picker');
      picker.value=window.__mofish.state.decor[0].id;
      picker.dispatchEvent(new Event('change',{bubbles:true}));
      return true;
    })()`);
    await sleep(750);
    await evaluate(page, `document.getElementById('mode-view').click()`);
    await evaluate(page, `(() => {const q=document.getElementById('quality');q.value='high';q.dispatchEvent(new Event('change'));})()`);
    await sleep(750);
    await evaluate(page, `(() => {const q=document.getElementById('quality');q.value='auto';q.dispatchEvent(new Event('change'));})()`);
    await warmup(page, 15);
    await page.send('HeapProfiler.enable');
    await page.send('HeapProfiler.collectGarbage');
    const beforeMetrics = await getPageMetrics(page);
    const before = await captureAppSnapshot(page);
    const initialDecorJson = await evaluate(page, `JSON.stringify(window.__mofish.state.decor)`);
    const initialDecor = JSON.parse(initialDecorJson);
    const targetDecor = initialDecor[0];
    if (!targetDecor?.id) throw new Error('满配存档没有可供换型的造景');
    if (before.renderer !== '3d' || before.quality !== 'auto' || before.editMode !== 'view') {
      throw new Error(`soak 初始状态不符合候选默认值：${JSON.stringify({renderer:before.renderer,quality:before.quality,editMode:before.editMode})}`);
    }
    const start = process.hrtime.bigint();
    const startedAt = new Date().toISOString();
    const actionLog = [];
    const resourceSnapshots = [];
    const metricIntervals = [];
    const cycleTimes = Array.from({length:20}, (_,index) => Math.floor((index + 1) * seconds * 0.55 / 20));
    const reshuffleTimes = Array.from({length:50}, (_,index) => Math.floor(seconds * 0.45 + (index + 1) * seconds * 0.45 / 50));
    let cycleIndex = 0;
    let reshuffleIndex = 0;
    let lastMetricAt = 0;
    let lastLogAt = -30;

    async function saveProgress(force = false) {
      const elapsed = Number(process.hrtime.bigint() - start) / 1e9;
      const due = elapsed - lastMetricAt >= 5;
      if (!force && !due) return;
      if (due) {
        const metrics = await getPageMetrics(page);
        const snapshot = await captureAppSnapshot(page);
        metricIntervals.push({
          atSeconds:elapsed,
          jsHeapUsedBytes:metrics.JSHeapUsedSize ?? null,
          taskDurationSeconds:metrics.TaskDuration ?? null,
          rendererInfo:snapshot.rendererInfo,
          resourceInfo:snapshot.resourceInfo,
          renderPolicy:snapshot.renderPolicy
        });
        lastMetricAt = elapsed;
      }
      record.soak = {
        progress:{elapsedSeconds:elapsed,rendererQualityCycles:cycleIndex,decorReshuffles:reshuffleIndex},
        metricsEveryFiveSeconds:metricIntervals,
        resourceSnapshots,
        actionLog
      };
      record.updatedAt = new Date().toISOString();
      writeJsonIncremental(output, record);
      if (elapsed - lastLogAt >= 30) {
        console.log(`  soak ${Math.round(elapsed)}/${seconds}s · 切换 ${cycleIndex}/20 · 造景 ${reshuffleIndex}/50`);
        lastLogAt = elapsed;
      }
    }

    async function waitForAutoStability() {
      const waitStarted = Date.now();
      let previousLevel = null;
      let stablePolls = 0;
      let lastInfo = null;
      while (Date.now() - waitStarted < 25000) {
        await sleep(500);
        lastInfo = await evaluate(page, `window.__mofish?.performanceInfo || null`);
        if (!lastInfo || lastInfo.policy !== 'auto') throw new Error(`auto 策略未恢复：${JSON.stringify(lastInfo)}`);
        const elapsedMs = Date.now() - waitStarted;
        if (elapsedMs >= 11000) {
          if (lastInfo.effectsLevel === previousLevel) stablePolls += 1;
          else { previousLevel = lastInfo.effectsLevel; stablePolls = 1; }
          if (stablePolls >= 3) return lastInfo;
        } else {
          previousLevel = lastInfo.effectsLevel;
          stablePolls = 0;
        }
        await saveProgress();
      }
      throw new Error(`auto effectsLevel 未稳定：${JSON.stringify(lastInfo)}`);
    }

    async function setQuality(policy) {
      await evaluate(page, `(() => {
        const control=document.getElementById('quality');
        control.value=${JSON.stringify(policy)};
        control.dispatchEvent(new Event('change',{bubbles:true}));
        return true;
      })()`);
      await waitFor(page, `window.__mofish?.quality === ${JSON.stringify(policy)} && window.__mofish?.performanceInfo?.policy === ${JSON.stringify(policy)}`);
    }

    async function cycleRendererAndQuality(index) {
      if (await evaluate(page, `window.__mofish.renderer`) !== '3d') throw new Error(`第 ${index} 轮开始时不在 3D`);
      await evaluate(page, `document.getElementById('toggle-2d').click()`);
      await waitFor(page, `window.__mofish?.renderer === '2d'`);
      await evaluate(page, `document.getElementById('toggle-2d').click()`);
      await waitFor(page, `window.__mofish?.renderer === '3d' && Boolean(window.__mofish.resourceInfo)`);
      const temporaryPolicy = index % 2 === 0 ? 'high' : 'low';
      await setQuality(temporaryPolicy);
      await setQuality('auto');
      const policyInfo = await waitForAutoStability();
      const snapshot = await captureAppSnapshot(page);
      if (snapshot.renderer !== '3d' || snapshot.quality !== 'auto' || snapshot.renderPolicy?.policy !== 'auto') {
        throw new Error(`第 ${index} 轮没有回到 3D/auto：${JSON.stringify(snapshot)}`);
      }
      resourceSnapshots.push({
        cycle:index, atSeconds:Number(process.hrtime.bigint()-start)/1e9,
        effectsLevel:policyInfo.effectsLevel, rendererInfo:snapshot.rendererInfo,
        resourceInfo:snapshot.resourceInfo, renderPolicy:snapshot.renderPolicy
      });
      cycleIndex += 1;
      actionLog.push({type:'renderer-quality-cycle',iteration:index,temporaryPolicy,restoredPolicy:'auto',effectsLevel:policyInfo.effectsLevel,atSeconds:Number(process.hrtime.bigint()-start)/1e9});
      await saveProgress(true);
    }

    async function selectOriginalDecor() {
      if (await evaluate(page, `window.__mofish.renderer`) !== '3d') throw new Error('造景换型前没有恢复到 3D');
      await evaluate(page, `document.getElementById('mode-decor').click()`);
      await waitFor(page, `window.__mofish?.editMode === 'decor' && Boolean(document.getElementById('decor-picker'))`);
      await evaluate(page, `(() => {
        const picker=document.getElementById('decor-picker');
        picker.value=${JSON.stringify(targetDecor.id)};
        picker.dispatchEvent(new Event('change',{bubbles:true}));
        return true;
      })()`);
      await waitFor(page, `window.__mofish?.selectedDecor === ${JSON.stringify(targetDecor.id)}`);
    }

    async function reshuffleAndUndo(index) {
      const currentJson = await evaluate(page, `JSON.stringify(window.__mofish.state.decor)`);
      if (currentJson !== initialDecorJson) throw new Error(`第 ${index} 次换型前场景已偏离初始 decor JSON`);
      const oldSeed = await evaluate(page, `window.__mofish.state.decor.find(item=>item.id===${JSON.stringify(targetDecor.id)})?.seed`);
      await evaluate(page, `document.getElementById('decor-reshuffle').click()`);
      const changedSeed = await waitFor(page, `(() => {
        const item=window.__mofish?.state?.decor?.find(item=>item.id===${JSON.stringify(targetDecor.id)});
        return item && item.seed !== ${oldSeed} ? {seed:item.seed} : null;
      })()`);
      await evaluate(page, `document.getElementById('decor-undo').click()`);
      const restored = await waitFor(page, `JSON.stringify(window.__mofish.state.decor) === ${JSON.stringify(initialDecorJson)}`);
      if (!restored) throw new Error(`第 ${index} 次换型撤销没有恢复完整 decor JSON`);
      const selected = await evaluate(page, `window.__mofish.selectedDecor`);
      if (selected !== targetDecor.id) await selectOriginalDecor();
      reshuffleIndex += 1;
      actionLog.push({type:'decor-reshuffle-undo',iteration:index,id:targetDecor.id,seedBefore:oldSeed,seedDuring:changedSeed,seedAfter:targetDecor.seed,atSeconds:Number(process.hrtime.bigint()-start)/1e9});
      await saveProgress(true);
    }

    while (Number(process.hrtime.bigint() - start) / 1e9 < seconds) {
      const elapsed = Number(process.hrtime.bigint() - start) / 1e9;
      if (cycleIndex < 20 && elapsed >= cycleTimes[cycleIndex]) {
        await cycleRendererAndQuality(cycleIndex + 1);
      } else if (cycleIndex === 20 && reshuffleIndex < 50 && elapsed >= reshuffleTimes[reshuffleIndex]) {
        if (reshuffleIndex === 0) await selectOriginalDecor();
        await reshuffleAndUndo(reshuffleIndex + 1);
      }
      await saveProgress();
      await sleep(500);
    }

    if (cycleIndex !== 20 || reshuffleIndex !== 50) throw new Error(`soak 操作不完整：切换 ${cycleIndex}/20，造景 ${reshuffleIndex}/50`);
    const finalStateJson = await evaluate(page, `JSON.stringify(window.__mofish.state.decor)`);
    if (finalStateJson !== initialDecorJson) throw new Error('soak 最终 decor JSON 与初始存档不一致');
    if (await evaluate(page, `window.__mofish.renderer`) !== '3d') throw new Error('soak 结束时渲染器不是 3D');
    if (await evaluate(page, `window.__mofish.quality`) !== 'auto') await setQuality('auto');
    if (await evaluate(page, `window.__mofish.editMode`) !== 'view') await evaluate(page, `document.getElementById('mode-view').click()`);
    const finalPolicy = await waitForAutoStability();
    const finalBeforeGc = await captureAppSnapshot(page);
    await page.send('HeapProfiler.collectGarbage');
    await sleep(2000);
    await page.send('HeapProfiler.collectGarbage');
    const afterMetrics = await getPageMetrics(page);
    const after = await captureAppSnapshot(page);
    const initialResources = before.resourceInfo;
    const finalResources = after.resourceInfo;
    const heapBefore = beforeMetrics.JSHeapUsedSize;
    const heapAfter = afterMetrics.JSHeapUsedSize;
    const result = {
      startedAt, completedAt:new Date().toISOString(),
      durationSeconds:Number(process.hrtime.bigint()-start)/1e9,
      requestedDurationSeconds:seconds, actionCounts:{rendererQualityCycles:cycleIndex, decorReshuffles:reshuffleIndex, undoCount:reshuffleIndex},
      initialSnapshot:before, finalSnapshot:after, finalBeforeGcSnapshot:finalBeforeGc,
      initialDecor, finalDecor:JSON.parse(finalStateJson), decorJsonRestored:finalStateJson===initialDecorJson,
      finalEffectsLevel:finalPolicy.effectsLevel,
      initialMetrics:beforeMetrics, finalMetrics:afterMetrics,
      heapNetBytes:Number.isFinite(heapBefore)&&Number.isFinite(heapAfter)?heapAfter-heapBefore:null,
      heapNetMiB:Number.isFinite(heapBefore)&&Number.isFinite(heapAfter)?(heapAfter-heapBefore)/1048576:null,
      heapLimitBytes:5*1048576,
      heapPass:Number.isFinite(heapBefore)&&Number.isFinite(heapAfter)?heapAfter-heapBefore<=5*1048576:null,
      resourceRecovery:{
        geometryBefore:initialResources?.geometries ?? null,geometryAfter:finalResources?.geometries ?? null,
        textureBefore:initialResources?.textures ?? null,textureAfter:finalResources?.textures ?? null,
        geometriesRecovered:initialResources?.geometries === finalResources?.geometries,
        texturesRecovered:initialResources?.textures === finalResources?.textures,
        drawCallsBefore:initialResources?.drawCalls ?? null,drawCallsAfter:finalResources?.drawCalls ?? null,
        trianglesBefore:initialResources?.triangles ?? null,trianglesAfter:finalResources?.triangles ?? null
      },
      actionLog,resourceSnapshots,metricsEveryFiveSeconds:metricIntervals
    };
    record.soak = result;
    record.updatedAt = new Date().toISOString();
    writeJsonIncremental(output, record);
    console.log(`  soak 完成：切换 ${cycleIndex}，造景 ${reshuffleIndex}；heap 净增 ${result.heapNetMiB?.toFixed(2) ?? 'n/a'} MiB`);
    return result;
  } catch (error) {
    record.soak = { ...(record.soak || {}), error:error.message, updatedAt:new Date().toISOString() };
    writeJsonIncremental(output, record);
    throw error;
  } finally {
    await page.close();
    try { await browser.send('Target.disposeBrowserContext', { browserContextId }); } catch {}
    try { await browser.send('Target.closeTarget', { targetId }); } catch {}
  }
}

async function launchBrowser(chromePath, profileDir) {
  const args = [
    '--headless=new', '--mute-audio', '--disable-gpu', '--hide-scrollbars',
    '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader',
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
    '--remote-debugging-port=0', `--user-data-dir=${profileDir}`, 'about:blank'
  ];
  const child = spawn(chromePath, args, { stdio:['ignore','ignore','pipe'], detached:false });
  let diagnostics = '';
  child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk.toString()).slice(-12000); });
  let spawnError = null;
  child.once('error', error => { spawnError = error; });
  console.log(`Chrome PID ${child.pid ?? '启动失败'} · 私有 profile ${profileDir}`);
  let port = null;
  let version = null;
  for (let attempt = 0; attempt < 60 && !version; attempt += 1) {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Chrome 启动失败：${child.exitCode ?? child.signalCode}\n${diagnostics}`);
    await sleep(250);
    try {
      port = Number(readFileSync(path.join(profileDir, 'DevToolsActivePort'), 'utf8').split('\n')[0]);
      version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    } catch {}
  }
  if (!version) throw new Error(`Chrome 调试端口不可达：${diagnostics}`);
  const browser = await connect(version.webSocketDebuggerUrl, { pageDomains:false });
  return { child, browser, port, diagnostics:() => diagnostics, args };
}

async function shutdownBrowser(browserRun) {
  if (!browserRun) return;
  try { await browserRun.browser.close(); } catch {}
  const child = browserRun.child;
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  const exited = await Promise.race([
    new Promise(resolve => child.once('exit', () => resolve(true))),
    sleep(10000).then(() => false)
  ]);
  if (!exited && child.exitCode === null) {
    child.kill('SIGKILL');
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), sleep(3000)]);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { help(); return; }
  const staticDir = path.resolve(args.dir);
  if (!existsSync(path.join(staticDir, 'index.html'))) throw new Error(`静态目录缺少 index.html：${staticDir}`);
  const output = path.resolve(args.out);
  const evidenceDir = path.dirname(output);
  mkdirSync(evidenceDir, { recursive:true });
  const seconds = args.seconds ?? (args.mode === 'soak' ? 900 : 60);
  const samples = args.mode === 'soak' ? 1 : args.samples;
  const chromePath = chooseChrome(args.chrome);
  const profileDir = mkdtempSync(path.join(evidenceDir, '.performance-profile-'));
  let preview = null;
  let browserRun = null;
  const record = {
    schema:'mofish-performance-v1', mode:args.mode, staticDir, output,
    startedAt:new Date().toISOString(), updatedAt:new Date().toISOString(),
    fixedDate:new Date(FIXED_NOW).toISOString(), seed:BASE_SEED,
    browserExecutable:chromePath, browserArgs:null,
    preview:null, runtime:null,
    benchmark:{viewport:VIEWPORT,warmupSeconds:10,secondsPerSample:seconds,samplesPerScenario:samples,
      scenarios:args.mode==='soak'?['full']:['default','full'],fullCounts:{fish:12,decor:{...REQUESTED_FULL_COUNTS},total:24},
      requestedPerKindCaps:Object.fromEntries(Object.entries(DECOR_KINDS).map(([kind,bucket])=>[kind,bucket.max])),
      note:'DECOR_KINDS 是分类上限；全局 DECOR_MAX=24，默认满配为 14 草 + 6 石 + 4 木，总数 24。'},
    samples:[], failures:[], soak:null, cleanup:{profile:profileDir,chromePid:null,previewPid:null}
  };
  writeJsonIncremental(output, record);
  try {
    preview = await startPreviewServer({ dir:staticDir, port:0 });
    record.preview = {url:preview.url,port:preview.port,staticDir};
    record.cleanup.previewPid = process.pid;
    console.log(`静态预览 ${preview.url} · 目录 ${staticDir} · server PID ${process.pid}`);
    browserRun = await launchBrowser(chromePath, profileDir);
    record.browserArgs = browserRun.args;
    record.cleanup.chromePid = browserRun.child.pid;
    const runtime = await getGpuIdentity(browserRun.browser);
    record.runtime = runtime;
    record.updatedAt = new Date().toISOString();
    writeJsonIncremental(output, record);
    console.log(`GPU/GL 信息已采集；以 SystemInfo 和 WebGL 实际 renderer 为准：${runtime.systemInfo?.gpu?.auxAttributes?.glRenderer || 'SystemInfo 未提供 glRenderer'}`);

    if (args.mode === 'soak') {
      const prefs = args.mode === 'baseline' ? { renderer:'3d',quality:'high' } : null;
      const result = await runSoak({browser:browserRun.browser,debugPort:browserRun.port,previewUrl:preview.url,prefs,output,record,seconds});
      if (!result.heapPass || !result.resourceRecovery.geometriesRecovered || !result.resourceRecovery.texturesRecovered || !result.decorJsonRestored || result.actionCounts.rendererQualityCycles !== 20 || result.actionCounts.decorReshuffles !== 50) {
        throw new Error('Stability acceptance failed; inspect soak resource/heap/action results.');
      }
    } else {
      const scenarios = ['default','full'];
      for (let scenarioIndex = 0; scenarioIndex < scenarios.length; scenarioIndex += 1) {
        const scenario = scenarios[scenarioIndex];
        // Frozen baseline records its historical desktop high-quality default explicitly.
        // Candidate leaves prefs absent so the current implementation chooses its default/auto policy.
        const prefs = args.mode === 'baseline' ? { renderer:'3d',quality:'high' } : null;
        for (let sampleIndex = 1; sampleIndex <= samples; sampleIndex += 1) {
          const result = await runMeasuredSample({
            browser:browserRun.browser,debugPort:browserRun.port,previewUrl:preview.url,
            scenario,scenarioIndex:scenarioIndex+1,sampleIndex,prefs,
            seed:(BASE_SEED + scenarioIndex * 0x10000) >>> 0,seconds,output,record
          });
          console.log(`增量 JSON 已写入 ${output}`);
          if (typeof process.send === 'function') process.send({ type:'sample-complete', id:result.id, cpuWorkMsPerSecond:result.metrics.cpuWorkMsPerSecond });
        }
      }
    }
    record.completedAt = new Date().toISOString();
    record.updatedAt = record.completedAt;
    record.status = 'complete';
    writeJsonIncremental(output, record);
    console.log(`完成：${output}`);
  } catch (error) {
    record.status = 'failed';
    record.error = error.stack || error.message;
    record.updatedAt = new Date().toISOString();
    writeJsonIncremental(output, record);
    throw error;
  } finally {
    console.log(`清理 task-owned Chrome/preview；profile=${profileDir}`);
    await shutdownBrowser(browserRun);
    if (preview) await preview.close();
    rmSync(profileDir,{recursive:true,force:true});
    record.cleanup.profileRemoved = true;
    record.cleanup.chromeStopped = !browserRun || browserRun.child.exitCode !== null;
    record.cleanup.previewStopped = Boolean(preview);
    record.updatedAt = new Date().toISOString();
    writeJsonIncremental(output,record);
  }
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});

