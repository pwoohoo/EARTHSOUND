/**
 * eicSpatialSynth.ts
 * ──────────────────────────────────────────────────────────────────────────────
 * Connects an HTML5 <video> element to the Web Audio API to produce a
 * real-time, multi-voice, spatially-panned musical track driven by the
 * visual content of the video (e.g. a satellite weather map).
 *
 * Architecture (4 stages):
 *   1. Geographic Meridian Scanner  – captures video → canvas → pixel grid
 *   2. Temporal Derivative Engine   – ΔI/Δt, motion vectors, warmth/coolness
 *   3. Multi-Voice Web Audio Synth  – pad + 12 polyphonic meridian voices
 *   4. Live Justification Feed      – human-readable event log + aria-live
 *
 * Public API:
 *   start(video, options?)   → Promise<void>
 *   stop()                   → void
 *   setLayerMute(layer, on)  → void
 *   getJustificationLog()    → JustificationEntry[]
 * ──────────────────────────────────────────────────────────────────────────────
 */

// ─── Types ──────────────────────────────────────────────────────────────────

/** A single human-readable justification event. */
export interface JustificationEntry {
  /** ISO-8601 timestamp */
  time: string;
  /** Plain-English explanation of the sonic event */
  text: string;
  /** The longitude column index (0–11) that triggered this event */
  columnIndex: number;
  /** Approximate geographic longitude in degrees (–180 to +180) */
  longitude: number;
}

/** Mutable layers the caller can mute / unmute. */
export type SynthLayer = 'pad' | 'meridianVoices' | 'all';

/** Optional overrides passed to `start()`. */
export interface SynthOptions {
  /** Canvas capture width  (default 160) */
  canvasWidth?: number;
  /** Canvas capture height (default 90) */
  canvasHeight?: number;
  /** Capture FPS (default 15) */
  fps?: number;
  /** Temporal derivative threshold for note triggering (0–255, default 12) */
  motionThreshold?: number;
  /** Maximum justification log entries kept in memory (default 500) */
  maxLogEntries?: number;
  /** Existing `aria-live` HTMLElement to receive captions (optional) */
  ariaLiveElement?: HTMLElement | null;
  /** External callback fired on every new justification entry */
  onJustification?: (entry: JustificationEntry) => void;
}

// ─── Constants ──────────────────────────────────────────────────────────────

/** C Dorian scale frequencies across 130 Hz – 4 500 Hz (C3 → C7 region). */
const C_DORIAN_FREQUENCIES: number[] = (() => {
  // C Dorian intervals (semitones from root): 0, 2, 3, 5, 7, 9, 10
  const intervals = [0, 2, 3, 5, 7, 9, 10];
  const freqs: number[] = [];
  const C3 = 130.81; // Hz
  for (let octave = 0; octave < 5; octave++) {
    for (const semi of intervals) {
      const f = C3 * Math.pow(2, octave + semi / 12);
      if (f >= 130 && f <= 4500) freqs.push(f);
    }
  }
  return freqs;
})();

const NUM_COLUMNS = 12;

/**
 * Approximate geographic labels for each of the 12 longitude columns
 * (left → right, i.e. –180° → +180°).
 */
const COLUMN_GEO_LABELS: string[] = [
  'Pacific / Date Line (–180°)',       // col 0
  'Central Pacific (–150°)',           // col 1
  'Eastern Pacific (–120°)',           // col 2
  'Western Americas (–90°)',           // col 3
  'Eastern Americas (–60°)',           // col 4
  'Mid-Atlantic (–30°)',              // col 5
  'Greenwich / W. Europe (0°)',        // col 6
  'Eastern Europe (30°E)',             // col 7
  'Middle East (60°E)',                // col 8
  'South Asia (90°E)',                 // col 9
  'East Asia (120°E)',                 // col 10
  'West Pacific / Date Line (150°E)',  // col 11
];

/** Map column index → approximate longitude in degrees. */
function columnToLongitude(col: number): number {
  // col 0 = –180°, col 6 = 0° (Greenwich), col 11 = +150°
  return -180 + (col + 0.5) * (360 / NUM_COLUMNS);
}

/** Map column index → stereo pan value (–1.0 … +1.0, Greenwich = 0). */
function columnToPan(col: number): number {
  // Column 6 (Greenwich) → 0, col 0 → –1, col 11 → +1
  const center = (NUM_COLUMNS - 1) / 2; // 5.5
  return (col - center) / center;        // –1 … +1
}

// ─── Internal State ─────────────────────────────────────────────────────────

let audioCtx: AudioContext | null = null;
let masterCompressor: DynamicsCompressorNode | null = null;
let masterGain: GainNode | null = null;

let captureCanvas: HTMLCanvasElement | null = null;
let captureCtx: CanvasRenderingContext2D | null = null;

let rafId: number = 0;
let running = false;
let lastFrameTime = 0;

let prevPixels: Uint8ClampedArray | null = null;
let canvasW = 160;
let canvasH = 90;
let targetFPS = 15;
let motionThreshold = 12;
let maxLogEntries = 500;

let justificationLog: JustificationEntry[] = [];
let ariaLiveEl: HTMLElement | null = null;
let onJustificationCb: ((e: JustificationEntry) => void) | null = null;

// Layer mute flags
let mutePad = false;
let muteMeridian = false;

// ─── Audio Nodes ────────────────────────────────────────────────────────────

// Pad voice
let padNoiseSource: AudioBufferSourceNode | null = null;
let padFilter: BiquadFilterNode | null = null;
let padGain: GainNode | null = null;

// Meridian voices: one per column
interface MeridianVoice {
  osc: OscillatorNode;
  filter: BiquadFilterNode;
  gain: GainNode;
  panner: StereoPannerNode;
  active: boolean;
  currentFreq: number;
  releaseTimeout: ReturnType<typeof setTimeout> | null;
}

let meridianVoices: MeridianVoice[] = [];

// ─── Pad (Atmosphere) ───────────────────────────────────────────────────────

function createPad(): void {
  if (!audioCtx || !masterCompressor) return;

  // Generate 2 seconds of white noise
  const bufferLength = audioCtx.sampleRate * 2;
  const noiseBuffer = audioCtx.createBuffer(1, bufferLength, audioCtx.sampleRate);
  const data = noiseBuffer.getChannelData(0);
  for (let i = 0; i < bufferLength; i++) {
    data[i] = Math.random() * 2 - 1;
  }

  padNoiseSource = audioCtx.createBufferSource();
  padNoiseSource.buffer = noiseBuffer;
  padNoiseSource.loop = true;

  padFilter = audioCtx.createBiquadFilter();
  padFilter.type = 'lowpass';
  padFilter.frequency.setValueAtTime(200, audioCtx.currentTime);
  padFilter.Q.setValueAtTime(1.5, audioCtx.currentTime);

  padGain = audioCtx.createGain();
  padGain.gain.setValueAtTime(0.12, audioCtx.currentTime);

  padNoiseSource.connect(padFilter);
  padFilter.connect(padGain);
  padGain.connect(masterCompressor);

  padNoiseSource.start();
}

/** Drive pad cutoff (100–400 Hz) based on global temperature balance. */
function updatePad(globalWarmth: number): void {
  if (!padFilter || !audioCtx || mutePad) return;
  // globalWarmth is normalised –1 (very cool) … +1 (very warm)
  const cutoff = 250 + globalWarmth * 150; // 100 – 400 Hz
  padFilter.frequency.setTargetAtTime(
    Math.max(100, Math.min(400, cutoff)),
    audioCtx.currentTime,
    0.3,
  );
}

// ─── Meridian Voices ────────────────────────────────────────────────────────

function createMeridianVoices(): void {
  if (!audioCtx || !masterCompressor) return;
  meridianVoices = [];

  for (let col = 0; col < NUM_COLUMNS; col++) {
    const osc = audioCtx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(261.63, audioCtx.currentTime); // C4 default

    const filter = audioCtx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(800, audioCtx.currentTime);
    filter.Q.setValueAtTime(2, audioCtx.currentTime);

    const gain = audioCtx.createGain();
    gain.gain.setValueAtTime(0, audioCtx.currentTime); // start silent

    const panner = audioCtx.createStereoPanner();
    panner.pan.setValueAtTime(columnToPan(col), audioCtx.currentTime);

    osc.connect(filter);
    filter.connect(gain);
    gain.connect(panner);
    panner.connect(masterCompressor);
    osc.start();

    meridianVoices.push({
      osc,
      filter,
      gain,
      panner,
      active: false,
      currentFreq: 261.63,
      releaseTimeout: null,
    });
  }
}

/**
 * Trigger (or sustain) a melodic note on the given meridian voice.
 *
 * @param col       Column index (0–11)
 * @param warmth    Per-column warmth (–1 … +1)
 * @param sharpness Wave sharpness / gradient magnitude (0 … 1)
 * @param velocity  Motion magnitude (0 … 1) used for volume
 */
function triggerMeridianNote(
  col: number,
  warmth: number,
  sharpness: number,
  velocity: number,
): void {
  if (!audioCtx || muteMeridian) return;
  const voice = meridianVoices[col];
  if (!voice) return;

  // Pick a frequency from C Dorian based on warmth
  // warm → higher pitch, cool → lower pitch
  const normWarmth = (warmth + 1) / 2; // 0 … 1
  const idx = Math.min(
    C_DORIAN_FREQUENCIES.length - 1,
    Math.max(0, Math.round(normWarmth * (C_DORIAN_FREQUENCIES.length - 1))),
  );
  const freq = C_DORIAN_FREQUENCIES[idx];

  // Smooth pitch transition
  voice.osc.frequency.setTargetAtTime(freq, audioCtx.currentTime, 0.08);
  voice.currentFreq = freq;

  // Filter resonance reflects sharpness (Q 1–12)
  const q = 1 + sharpness * 11;
  voice.filter.Q.setTargetAtTime(q, audioCtx.currentTime, 0.05);
  voice.filter.frequency.setTargetAtTime(freq * 2, audioCtx.currentTime, 0.05);

  // Volume envelope — smooth attack
  const vol = Math.min(0.22, 0.04 + velocity * 0.18);
  voice.gain.gain.setTargetAtTime(vol, audioCtx.currentTime, 0.06); // ~60ms attack

  voice.active = true;

  // Clear any pending release
  if (voice.releaseTimeout !== null) {
    clearTimeout(voice.releaseTimeout);
    voice.releaseTimeout = null;
  }
}

/** Begin a smooth release on the given meridian voice. */
function releaseMeridianNote(col: number): void {
  if (!audioCtx) return;
  const voice = meridianVoices[col];
  if (!voice || !voice.active) return;

  // Don't double-schedule release
  if (voice.releaseTimeout !== null) return;

  voice.gain.gain.setTargetAtTime(0, audioCtx.currentTime, 0.25); // ~250ms release
  voice.releaseTimeout = setTimeout(() => {
    voice.active = false;
    voice.releaseTimeout = null;
  }, 800);
}

// ─── Justification Engine ───────────────────────────────────────────────────

function freqToNoteName(freq: number): string {
  const noteNames = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
  const midi = Math.round(12 * Math.log2(freq / 440) + 69);
  const name = noteNames[midi % 12];
  const octave = Math.floor(midi / 12) - 1;
  return `${name}${octave}`;
}

function emitJustification(
  col: number,
  warmth: number,
  velocity: number,
  freq: number,
  eventKind: 'triggered' | 'shifted' | 'faded',
): void {
  const pan = columnToPan(col);
  const panPct = Math.abs(Math.round(pan * 100));
  const panDir = pan < -0.01 ? 'left' : pan > 0.01 ? 'right' : 'center';
  const tempLabel = warmth > 0.2 ? 'Warm front' : warmth < -0.2 ? 'Cold front' : 'Neutral air mass';
  const velLabel = velocity > 0.6 ? 'high' : velocity > 0.3 ? 'moderate' : 'low';
  const noteName = freqToNoteName(freq);
  const registerLabel =
    freq < 260 ? 'low-register' : freq < 600 ? 'mid-register' : 'high-register';

  const longitude = columnToLongitude(col);
  const lonStr = longitude >= 0 ? `${Math.round(longitude)}°E` : `${Math.round(Math.abs(longitude))}°W`;
  const geoLabel = COLUMN_GEO_LABELS[col] ?? lonStr;

  let text: string;
  if (eventKind === 'triggered') {
    text =
      `${tempLabel} wave crossing ${lonStr} (${geoLabel}) at ${velLabel} velocity: ` +
      `${eventKind} ${registerLabel} ${noteName} harmonic pulse panned ${panPct}% ${panDir}.`;
  } else if (eventKind === 'shifted') {
    text =
      `${tempLabel} activity shifting near ${lonStr} (${geoLabel}): ` +
      `sustained ${registerLabel} ${noteName} tone, ${panPct}% ${panDir}.`;
  } else {
    text = `Wave fading at ${lonStr} (${geoLabel}): releasing ${noteName} voice.`;
  }

  const entry: JustificationEntry = {
    time: new Date().toISOString(),
    text,
    columnIndex: col,
    longitude,
  };

  justificationLog.push(entry);
  if (justificationLog.length > maxLogEntries) {
    justificationLog = justificationLog.slice(-maxLogEntries);
  }

  // Push to aria-live region
  if (ariaLiveEl) {
    ariaLiveEl.textContent = text;
  }

  // Callback
  if (onJustificationCb) {
    try {
      onJustificationCb(entry);
    } catch {
      // swallow external errors
    }
  }
}

// ─── Frame Analysis (Steps 1 & 2) ──────────────────────────────────────────

interface ColumnMetrics {
  /** Average temporal derivative magnitude (0–255) */
  motionMag: number;
  /** Average horizontal gradient magnitude */
  gradX: number;
  /** Average vertical gradient magnitude */
  gradY: number;
  /** Warmth index: (R – B) normalised to –1 … +1 */
  warmth: number;
  /** Wave sharpness (combined gradient norm, 0 … 1) */
  sharpness: number;
}

function analyseFrame(
  currentPixels: Uint8ClampedArray,
  prevPixels: Uint8ClampedArray,
  width: number,
  height: number,
): { columns: ColumnMetrics[]; globalWarmth: number } {
  const colWidth = Math.floor(width / NUM_COLUMNS);
  const columns: ColumnMetrics[] = [];
  let globalR = 0;
  let globalB = 0;
  let globalCount = 0;

  for (let col = 0; col < NUM_COLUMNS; col++) {
    const x0 = col * colWidth;
    const x1 = col === NUM_COLUMNS - 1 ? width : x0 + colWidth;

    let sumMotion = 0;
    let sumGradX = 0;
    let sumGradY = 0;
    let sumWarmth = 0;
    let pixelCount = 0;

    for (let y = 0; y < height; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * width + x) * 4;

        const r = currentPixels[i];
        const g = currentPixels[i + 1];
        const b = currentPixels[i + 2];

        const pr = prevPixels[i];
        const pg = prevPixels[i + 1];
        const pb = prevPixels[i + 2];

        // Temporal derivative ΔI/Δt (luminance approximation)
        const lumCur = 0.299 * r + 0.587 * g + 0.114 * b;
        const lumPrev = 0.299 * pr + 0.587 * pg + 0.114 * pb;
        sumMotion += Math.abs(lumCur - lumPrev);

        // Horizontal gradient (central difference where possible)
        if (x > 0 && x < width - 1) {
          const iL = (y * width + (x - 1)) * 4;
          const iR = (y * width + (x + 1)) * 4;
          const lumL = 0.299 * currentPixels[iL] + 0.587 * currentPixels[iL + 1] + 0.114 * currentPixels[iL + 2];
          const lumR = 0.299 * currentPixels[iR] + 0.587 * currentPixels[iR + 1] + 0.114 * currentPixels[iR + 2];
          sumGradX += Math.abs(lumR - lumL) * 0.5;
        }

        // Vertical gradient
        if (y > 0 && y < height - 1) {
          const iU = ((y - 1) * width + x) * 4;
          const iD = ((y + 1) * width + x) * 4;
          const lumU = 0.299 * currentPixels[iU] + 0.587 * currentPixels[iU + 1] + 0.114 * currentPixels[iU + 2];
          const lumD = 0.299 * currentPixels[iD] + 0.587 * currentPixels[iD + 1] + 0.114 * currentPixels[iD + 2];
          sumGradY += Math.abs(lumD - lumU) * 0.5;
        }

        // Warmth (R – B)
        sumWarmth += (r - b);

        globalR += r;
        globalB += b;
        globalCount++;
        pixelCount++;
      }
    }

    const invCount = 1 / Math.max(1, pixelCount);
    const avgMotion = sumMotion * invCount;
    const avgGradX = sumGradX * invCount;
    const avgGradY = sumGradY * invCount;
    const avgWarmth = sumWarmth * invCount; // range roughly –255 … +255

    // Normalise sharpness to 0 … 1
    const gradNorm = Math.sqrt(avgGradX * avgGradX + avgGradY * avgGradY);
    const sharpness = Math.min(1, gradNorm / 60); // 60 is an empirical ceiling

    columns.push({
      motionMag: avgMotion,
      gradX: avgGradX,
      gradY: avgGradY,
      warmth: Math.max(-1, Math.min(1, avgWarmth / 128)),
      sharpness,
    });
  }

  const globalWarmth =
    globalCount > 0
      ? Math.max(-1, Math.min(1, (globalR - globalB) / globalCount / 128))
      : 0;

  return { columns, globalWarmth };
}

// ─── Main Loop ──────────────────────────────────────────────────────────────

let videoElement: HTMLVideoElement | null = null;

/**
 * Track which columns had an active justification last frame so we only
 * emit "triggered" once (not every frame) and "faded" once on release.
 */
let prevActiveColumns: boolean[] = new Array(NUM_COLUMNS).fill(false);

function tick(timestamp: number): void {
  if (!running) return;

  rafId = requestAnimationFrame(tick);

  // Throttle to target FPS
  const elapsed = timestamp - lastFrameTime;
  const frameInterval = 1000 / targetFPS;
  if (elapsed < frameInterval) return;
  lastFrameTime = timestamp - (elapsed % frameInterval);

  if (!videoElement || !captureCtx || !captureCanvas) return;

  // Step 1: Capture frame
  try {
    captureCtx.drawImage(videoElement, 0, 0, canvasW, canvasH);
  } catch {
    // tainted canvas – CORS misconfiguration; skip frame
    return;
  }

  let imageData: ImageData;
  try {
    imageData = captureCtx.getImageData(0, 0, canvasW, canvasH);
  } catch {
    // SecurityError – tainted; we've already set crossOrigin but the
    // server may not send the right headers. Skip silently.
    return;
  }

  const currentPixels = imageData.data; // Uint8ClampedArray

  if (prevPixels === null) {
    // First frame – store and skip analysis (no delta yet)
    prevPixels = new Uint8ClampedArray(currentPixels);
    return;
  }

  // Step 2: Analyse
  const { columns, globalWarmth } = analyseFrame(
    currentPixels,
    prevPixels,
    canvasW,
    canvasH,
  );

  // Step 3 & 4: Drive audio + emit justifications
  updatePad(globalWarmth);

  for (let col = 0; col < NUM_COLUMNS; col++) {
    const m = columns[col];
    const isActive = m.motionMag > motionThreshold;
    const velocity = Math.min(1, m.motionMag / 80); // normalise

    if (isActive) {
      const voice = meridianVoices[col];
      const oldFreq = voice ? voice.currentFreq : 0;
      triggerMeridianNote(col, m.warmth, m.sharpness, velocity);
      if (voice) {
        // Justification
        if (!prevActiveColumns[col]) {
          emitJustification(col, m.warmth, velocity, voice.currentFreq, 'triggered');
        } else {
          // Emit "shifted" only if the pitch changed meaningfully (> 1 semitone)
          if (
            oldFreq > 0 &&
            Math.abs(12 * Math.log2(voice.currentFreq / oldFreq)) > 1.5
          ) {
            emitJustification(col, m.warmth, velocity, voice.currentFreq, 'shifted');
          }
        }
      }
      prevActiveColumns[col] = true;
    } else {
      if (prevActiveColumns[col]) {
        const voice = meridianVoices[col];
        releaseMeridianNote(col);
        if (voice) {
          emitJustification(col, columns[col].warmth, velocity, voice.currentFreq, 'faded');
        }
      }
      prevActiveColumns[col] = false;
    }
  }

  // Swap buffers (re-use the previous allocation)
  prevPixels.set(currentPixels);
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Initialise and start the spatial synthesizer.
 *
 * Must be called inside a user-gesture handler (e.g. a "Play" button click)
 * so the AudioContext can be unlocked.
 *
 * @param video   An existing `<video>` element already pointing at a source.
 * @param options Optional configuration overrides.
 */
export async function start(
  video: HTMLVideoElement,
  options?: SynthOptions,
): Promise<void> {
  if (running) return;

  // Apply options
  canvasW = options?.canvasWidth ?? 160;
  canvasH = options?.canvasHeight ?? 90;
  targetFPS = options?.fps ?? 15;
  motionThreshold = options?.motionThreshold ?? 12;
  maxLogEntries = options?.maxLogEntries ?? 500;
  ariaLiveEl = options?.ariaLiveElement ?? null;
  onJustificationCb = options?.onJustification ?? null;

  // CORS – critical for getImageData
  video.crossOrigin = 'anonymous';
  videoElement = video;

  // Hidden canvas
  captureCanvas = document.createElement('canvas');
  captureCanvas.width = canvasW;
  captureCanvas.height = canvasH;
  captureCtx = captureCanvas.getContext('2d', { willReadFrequently: true });

  // Audio context (unlocked by user gesture calling this function)
  audioCtx = new AudioContext();
  if (audioCtx.state === 'suspended') {
    await audioCtx.resume();
  }

  // Master bus: compressor → destination
  masterCompressor = audioCtx.createDynamicsCompressor();
  masterCompressor.threshold.setValueAtTime(-24, audioCtx.currentTime);
  masterCompressor.knee.setValueAtTime(12, audioCtx.currentTime);
  masterCompressor.ratio.setValueAtTime(6, audioCtx.currentTime);
  masterCompressor.attack.setValueAtTime(0.003, audioCtx.currentTime);
  masterCompressor.release.setValueAtTime(0.25, audioCtx.currentTime);

  masterGain = audioCtx.createGain();
  masterGain.gain.setValueAtTime(0.85, audioCtx.currentTime);

  masterCompressor.connect(masterGain);
  masterGain.connect(audioCtx.destination);

  // Build voices
  createPad();
  createMeridianVoices();

  // Reset state
  prevPixels = null;
  justificationLog = [];
  prevActiveColumns = new Array(NUM_COLUMNS).fill(false);
  lastFrameTime = 0;

  running = true;
  rafId = requestAnimationFrame(tick);
}

/** Stop the synthesizer and tear down all audio nodes. */
export function stop(): void {
  running = false;

  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = 0;
  }

  // Stop pad
  try {
    padNoiseSource?.stop();
  } catch {
    /* already stopped */
  }
  padNoiseSource?.disconnect();
  padFilter?.disconnect();
  padGain?.disconnect();
  padNoiseSource = null;
  padFilter = null;
  padGain = null;

  // Stop meridian voices
  for (const v of meridianVoices) {
    if (v.releaseTimeout !== null) clearTimeout(v.releaseTimeout);
    try {
      v.osc.stop();
    } catch {
      /* already stopped */
    }
    v.osc.disconnect();
    v.filter.disconnect();
    v.gain.disconnect();
    v.panner.disconnect();
  }
  meridianVoices = [];

  // Tear down master bus
  masterCompressor?.disconnect();
  masterGain?.disconnect();
  masterCompressor = null;
  masterGain = null;

  // Close context
  if (audioCtx) {
    audioCtx.close().catch(() => {});
    audioCtx = null;
  }

  // Clean up canvas
  captureCanvas = null;
  captureCtx = null;
  videoElement = null;
  prevPixels = null;
}

/**
 * Mute or unmute a synthesis layer at runtime.
 *
 * @param layer  `'pad'` | `'meridianVoices'` | `'all'`
 * @param muted  `true` to mute, `false` to unmute.
 */
export function setLayerMute(layer: SynthLayer, muted: boolean): void {
  switch (layer) {
    case 'pad':
      mutePad = muted;
      if (padGain && audioCtx) {
        padGain.gain.setTargetAtTime(muted ? 0 : 0.12, audioCtx.currentTime, 0.05);
      }
      break;
    case 'meridianVoices':
      muteMeridian = muted;
      if (muted) {
        for (let i = 0; i < meridianVoices.length; i++) {
          releaseMeridianNote(i);
        }
      }
      break;
    case 'all':
      setLayerMute('pad', muted);
      setLayerMute('meridianVoices', muted);
      break;
  }
}

/**
 * Return a snapshot of the justification log (newest entries last).
 */
export function getJustificationLog(): JustificationEntry[] {
  return [...justificationLog];
}
