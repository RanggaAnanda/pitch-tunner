// src/utils/audioEngine.js
// Audio engine untuk deteksi pitch vokal real-time.
//
// Perbaikan utama dibanding versi sebelumnya:
//  - Deteksi pitch memakai McLeod Pitch Method (NSDF) yang benar: memilih puncak
//    "pertama yang cukup tinggi", sehingga error oktaf/subharmonik jauh berkurang.
//  - Jendela analisis memakai sampel TERBARU, DC offset dibuang, buffer dipakai ulang
//    (tanpa alokasi per frame -> lebih ringan untuk GC).
//  - Rentang lag dibatasi sesuai rentang frekuensi (65–1050 Hz) -> komputasi lebih hemat.
//  - Noise gate dengan hysteresis + ambang "clarity" (tingkat kepastian nada) yang ikut
//    slider sensitivity, jadi desis/napas tidak dibaca sebagai nada.
//  - Tracking: median di domain MIDI (log), konfirmasi lompatan nada/oktaf, dan
//    penahanan singkat saat dropout (konsonan / napas sesaat).
//  - State tidak lagi global: setiap engine punya PitchDetector sendiri.
//  - Mikrofon: AGC dimatikan (agar level RMS konsisten), ditambah filter high-pass
//    dan low-pass untuk membuang rumble dan desis.

const DEFAULT_OPTIONS = {
  minFreq: 65, // ~C2
  maxFreq: 1050, // ~C6
  windowSize: 2048, // jumlah sampel terbaru yang dianalisis
  peakRatio: 0.9, // ambil puncak NSDF pertama >= peakRatio * puncak tertinggi
  medianSize: 5, // panjang jendela median (frame)
  jumpSemitones: 0.7, // perubahan > ini dianggap "lompatan nada"
  jumpConfirmFrames: 2, // frame berturut-turut untuk menerima lompatan biasa
  octaveConfirmFrames: 4, // lebih ketat untuk lompatan mirip oktaf (sering error deteksi)
  dropoutHoldMs: 90, // tahan nada terakhir selama dropout singkat
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const nowMs = () =>
  typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
const hzToMidi = (hz) => 69 + 12 * Math.log2(hz / 440);
const midiToHz = (midi) => 440 * Math.pow(2, (midi - 69) / 12);

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// Lompatan yang mencurigakan: oktaf, oktaf+kuint (harmonik ke-3), dua oktaf
function isOctaveLike(semitones) {
  return [12, 19.02, 24].some((iv) => Math.abs(semitones - iv) < 0.7);
}

/**
 * Normalized Square Difference Function (McLeod & Wyvill).
 * nsdf[tau] = 2 * r(tau) / m(tau), nilai berada di [-1, 1]; 1 = periodik sempurna.
 * m(tau) dihitung rekursif sehingga total biaya hanya O(n * lagMax).
 */
function computeNsdf(x, n, lagMax, out, energy) {
  let m = 2 * energy;
  for (let tau = 0; tau <= lagMax; tau++) {
    if (tau > 0) m -= x[tau - 1] * x[tau - 1] + x[n - tau] * x[n - tau];
    let r = 0;
    const end = n - tau;
    for (let j = 0; j < end; j++) r += x[j] * x[j + tau];
    out[tau] = m > 1e-12 ? (2 * r) / m : 0;
  }
}

/**
 * Pilih lag periode dari NSDF: kumpulkan puncak positif di antara tiap persimpangan nol,
 * lalu ambil puncak PERTAMA yang nilainya >= ratio * puncak tertinggi.
 * @returns {number} indeks lag, atau -1 bila tidak ada
 */
function pickPeriodLag(nsdf, lagMax, minLag, ratio) {
  let pos = 1;
  // lewati lobus positif pertama di sekitar lag 0, lalu wilayah negatifnya
  while (pos < lagMax && nsdf[pos] > 0) pos++;
  while (pos < lagMax && nsdf[pos] <= 0) pos++;

  const peaks = [];
  let curMax = 0;
  while (pos < lagMax) {
    if (nsdf[pos] > 0) {
      if (nsdf[pos] > nsdf[pos - 1] && nsdf[pos] >= nsdf[pos + 1]) {
        if (curMax === 0 || nsdf[pos] > nsdf[curMax]) curMax = pos;
      }
    } else if (curMax > 0) {
      peaks.push(curMax);
      curMax = 0;
    }
    pos++;
  }
  if (curMax > 0) peaks.push(curMax);

  let highest = 0;
  for (const p of peaks) {
    if (p >= minLag && nsdf[p] > highest) highest = nsdf[p];
  }
  if (highest <= 0) return -1;

  const cutoff = ratio * highest;
  for (const p of peaks) {
    if (p >= minLag && nsdf[p] >= cutoff) return p;
  }
  return -1;
}

/**
 * Pitch detector bertingkat (stateful): NSDF/MPM + tracking.
 * Buat satu instance per sumber audio.
 */
export class PitchDetector {
  constructor(options = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this._frame = null;
    this._nsdf = null;
    this.reset();
  }

  reset() {
    this._gateOpen = false;
    this._history = [];
    this._stableMidi = null;
    this._candidate = null;
    this._lastVoicedAt = 0;
    this.clarity = 0; // kepastian nada frame terakhir (0..1)
  }

  /**
   * @param {Float32Array} buffer - data time-domain (analyser.getFloatTimeDomainData)
   * @param {number} sampleRate
   * @param {number} sensitivity - 0..1 (makin tinggi makin sensitif)
   * @param {number} [timeMs] - override waktu (untuk pengujian)
   * @returns {number|null} frekuensi (Hz) atau null bila hening / tak bernada
   */
  detect(buffer, sampleRate, sensitivity = 0.3, timeMs = nowMs()) {
    const o = this.options;
    const sens = clamp(sensitivity, 0.05, 1);

    const n = Math.min(buffer.length, o.windowSize);
    if (n < 512 || !(sampleRate > 0)) return null;

    if (!this._frame || this._frame.length !== n) this._frame = new Float32Array(n);
    const frame = this._frame;
    const src = buffer.subarray(buffer.length - n); // sampel terbaru

    // 1. Buang DC offset + hitung energi / RMS
    let mean = 0;
    for (let i = 0; i < n; i++) mean += src[i];
    mean /= n;
    let energy = 0;
    for (let i = 0; i < n; i++) {
      const v = src[i] - mean;
      frame[i] = v;
      energy += v * v;
    }
    const rms = Math.sqrt(energy / n);

    // 2. Noise gate dengan hysteresis (buka di openThr, tutup di 60% dari itu)
    const openThr = 0.05 * (1.05 - sens);
    const closeThr = openThr * 0.6;
    this._gateOpen = this._gateOpen ? rms >= closeThr : rms >= openThr;
    if (!this._gateOpen) {
      this.reset();
      return null;
    }

    // 3. Estimasi pitch mentah
    const hz = this._estimate(frame, n, energy, sampleRate, sens);

    // 4. Dropout: gate terbuka tapi tidak bernada (konsonan, napas)
    if (hz === null) {
      if (this._stableMidi !== null && timeMs - this._lastVoicedAt < o.dropoutHoldMs) {
        return midiToHz(this._stableMidi);
      }
      this._history.length = 0;
      this._candidate = null;
      this._stableMidi = null;
      return null;
    }
    this._lastVoicedAt = timeMs;

    // 5. Tracking di domain MIDI
    return midiToHz(this._track(hzToMidi(hz)));
  }

  _estimate(frame, n, energy, sampleRate, sens) {
    const o = this.options;

    // lag maksimum dibatasi setengah jendela agar korelasi tetap andal
    const lagMax = Math.min(Math.ceil(sampleRate / o.minFreq) + 2, n >> 1);
    const minLag = Math.max(2, Math.floor(sampleRate / o.maxFreq));
    if (lagMax <= minLag + 2) return null;

    if (!this._nsdf || this._nsdf.length < lagMax + 2) {
      this._nsdf = new Float32Array(lagMax + 2);
    }
    const nsdf = this._nsdf;
    computeNsdf(frame, n, lagMax, nsdf, energy);

    const lag = pickPeriodLag(nsdf, lagMax, minLag, o.peakRatio);
    if (lag < 1) {
      this.clarity = 0;
      return null;
    }

    // Interpolasi parabola -> lag sub-sampel + nilai puncak (clarity)
    const a = nsdf[lag - 1];
    const b = nsdf[lag];
    const c = nsdf[lag + 1];
    const denom = a - 2 * b + c;
    let delta = denom !== 0 ? (0.5 * (a - c)) / denom : 0;
    if (!(Math.abs(delta) <= 1)) delta = 0;
    const refinedLag = lag + delta;
    const clarity = clamp(b - 0.25 * (a - c) * delta, 0, 1);
    this.clarity = clarity;

    // Ambang clarity mengikuti sensitivity: 0.3 -> 0.82, 1.0 -> 0.75
    const clarityMin = 0.85 - 0.1 * sens;
    if (clarity < clarityMin) return null;

    const hz = sampleRate / refinedLag;
    if (hz < o.minFreq || hz > o.maxFreq) return null;
    return hz;
  }

  /**
   * Median di domain MIDI + konfirmasi lompatan.
   * Lompatan nada baru diterima setelah terlihat konsisten beberapa frame; lompatan
   * mirip oktaf butuh lebih banyak konfirmasi karena sering berasal dari error deteksi.
   */
  _track(midi) {
    const o = this.options;

    if (this._stableMidi !== null) {
      const jump = Math.abs(midi - this._stableMidi);
      if (jump > o.jumpSemitones) {
        const need = isOctaveLike(jump) ? o.octaveConfirmFrames : o.jumpConfirmFrames;
        if (this._candidate && Math.abs(midi - this._candidate.midi) < 0.6) {
          this._candidate.count++;
        } else {
          this._candidate = { midi, count: 1 };
        }
        if (this._candidate.count < need) return this._stableMidi; // tahan nada lama
        this._history.length = 0; // nada memang berpindah
        this._candidate = null;
      } else {
        this._candidate = null;
      }
    }

    this._history.push(midi);
    if (this._history.length > o.medianSize) this._history.shift();
    this._stableMidi = median(this._history);
    return this._stableMidi;
  }
}

// ---------------------------------------------------------------------------
// API lama (kompatibel): autoCorrelate(buffer, sampleRate, sensitivity)
// ---------------------------------------------------------------------------
const defaultDetector = new PitchDetector();

export function autoCorrelate(buffer, sampleRate, sensitivity = 0.3) {
  return defaultDetector.detect(buffer, sampleRate, sensitivity);
}

export function resetPitchDetector() {
  defaultDetector.reset();
}

/**
 * Inisialisasi AudioContext + AnalyserNode dari mikrofon.
 * @param {string|null} deviceId - ID perangkat input (opsional)
 * @param {object} [options]
 * @param {number} [options.fftSize=2048]
 * @param {number} [options.highpassHz=60] - buang rumble / hembusan angin
 * @param {number} [options.lowpassHz=2500] - buang desis & harmonik tinggi
 * @param {boolean} [options.autoGainControl=false]
 */
export async function initAudio(deviceId = null, options = {}) {
  const { fftSize = 2048, highpassHz = 60, lowpassHz = 2500, autoGainControl = false } = options;

  const buildConstraints = (withDevice) => ({
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl, // AGC membuat level RMS naik-turun sendiri -> noise gate tidak konsisten
      channelCount: 1,
      ...(withDevice && deviceId ? { deviceId: { exact: deviceId } } : {}),
    },
  });

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia(buildConstraints(true));
  } catch (err) {
    // Perangkat tersimpan sudah tidak ada -> coba lagi dengan perangkat default
    if (deviceId && (err.name === 'OverconstrainedError' || err.name === 'NotFoundError')) {
      stream = await navigator.mediaDevices.getUserMedia(buildConstraints(false));
    } else {
      throw err;
    }
  }

  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  const audioContext = new AudioCtx({ latencyHint: 'interactive' });

  // Resume bila ditangguhkan (kebijakan autoplay browser)
  if (audioContext.state === 'suspended') {
    await audioContext.resume();
  }

  const source = audioContext.createMediaStreamSource(stream);

  const highpass = audioContext.createBiquadFilter();
  highpass.type = 'highpass';
  highpass.frequency.value = highpassHz;

  const lowpass = audioContext.createBiquadFilter();
  lowpass.type = 'lowpass';
  lowpass.frequency.value = lowpassHz;

  const analyser = audioContext.createAnalyser();
  analyser.fftSize = fftSize;

  source.connect(highpass);
  highpass.connect(lowpass);
  lowpass.connect(analyser);

  // Detector milik engine ini (tidak berbagi state dengan engine lain)
  const detector = new PitchDetector();
  const detectPitch = (buffer, sensitivity) =>
    detector.detect(buffer, audioContext.sampleRate, sensitivity);

  return {
    audioContext,
    analyser,
    stream,
    detector,
    detectPitch,
    nodes: [source, highpass, lowpass],
  };
}

/**
 * Hentikan engine: putuskan node, matikan track mikrofon, tutup AudioContext.
 */
export function stopAudio(engine) {
  if (!engine) return;
  try {
    engine.nodes?.forEach((node) => node.disconnect());
  } catch (err) {
    /* node sudah terputus */
  }
  engine.stream?.getTracks?.().forEach((track) => track.stop());
  if (engine.audioContext && engine.audioContext.state !== 'closed') {
    engine.audioContext.close().catch(() => {});
  }
  engine.detector?.reset();
}

/**
 * Daftar perangkat input audio yang tersedia
 */
export async function getAudioInputDevices() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === 'audioinput');
  } catch (err) {
    console.warn('Could not enumerate audio devices:', err);
    return [];
  }
}