// src/utils/noteConverter.js
// Konversi musikal & matematis pitch + deteksi chord.
//
// Perbaikan utama dibanding versi sebelumnya:
//  - Deteksi chord memakai PUNCAK spektrum (diinterpolasi parabola) bukan tiap bin FFT.
//    Resolusi bin FFT 2048 (~21 Hz) terlalu kasar untuk nada rendah, sehingga chroma lama
//    sering salah kelas nada.
//  - Chroma diakumulasi antar-frame (memori ~200 ms), dicocokkan dengan cosine similarity,
//    plus syarat margin & kehadiran ketiga nada chord, lalu diberi hysteresis waktu agar
//    hasil tidak berkedip.
//  - Template chord kini mencakup 12 mayor + 12 minor (sebelumnya hanya 9).
//  - analyzePitch punya hysteresis nama nada (tidak bolak-balik C4/C#4 di batas ±50 cent).

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const nowMs = () =>
  typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();

// ---------------------------------------------------------------------------
// Template chord (dibangkitkan, 12 mayor + 12 minor)
// ---------------------------------------------------------------------------

// Urutan chord lama dipertahankan di depan agar urutan dropdown tidak berubah
const ORIGINAL_CHORD_ORDER = ['C', 'G', 'Am', 'F', 'D', 'Em', 'Dm', 'E', 'A'];

function makeTemplate(rootIdx, quality) {
  const third = quality === 'major' ? 4 : 3;
  const bins = [rootIdx, (rootIdx + third) % 12, (rootIdx + 7) % 12];
  return {
    name: `${NOTE_NAMES[rootIdx]} ${quality === 'major' ? 'Major' : 'Minor'}`,
    notes: bins.map((b) => NOTE_NAMES[b]),
    bins,
    root: NOTE_NAMES[rootIdx],
    quality,
  };
}

function buildChordTemplates() {
  const all = {};
  NOTE_NAMES.forEach((root, idx) => {
    all[root] = makeTemplate(idx, 'major');
    all[`${root}m`] = makeTemplate(idx, 'minor');
  });
  const ordered = {};
  ORIGINAL_CHORD_ORDER.forEach((key) => {
    ordered[key] = all[key];
  });
  Object.keys(all).forEach((key) => {
    if (!(key in ordered)) ordered[key] = all[key];
  });
  return ordered;
}

/**
 * Template chord untuk pengenalan otomatis (chroma matching)
 */
export const CHORD_TEMPLATES = buildChordTemplates();

/**
 * Konfigurasi chord untuk dropdown + Auto-Detect
 */
export const CHORD_DEFINITIONS = {
  AUTO: { label: 'Auto-Detect (Ikuti Nada Otomatis)', notes: [] },
  ...Object.fromEntries(
    Object.entries(CHORD_TEMPLATES).map(([key, tpl]) => [
      key,
      { label: `${tpl.name} (${tpl.notes.join(', ')})`, notes: tpl.notes },
    ])
  ),
};

/**
 * Skala nada untuk sumbu Y (dari C5 turun ke C3)
 */
export const DISPLAY_Y_NOTES = [
  'C5', 'A4', 'G4', 'F4', 'E4', 'D4', 'C4',
  'B3', 'A3', 'G3', 'F3', 'E3', 'D3', 'C3',
];

// ---------------------------------------------------------------------------
// Konversi dasar
// ---------------------------------------------------------------------------

/**
 * Frekuensi (Hz) -> nomor MIDI pecahan. MIDI = 69 + 12 * log2(Hz / 440)
 */
export function freqToMidi(freqHz) {
  if (!freqHz || freqHz <= 0) return null;
  return 69 + 12 * Math.log2(freqHz / 440);
}

/**
 * Nomor MIDI -> frekuensi ideal. Hz = 440 * 2^((MIDI - 69) / 12)
 */
export function midiToFreq(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/**
 * Nomor MIDI -> nama nada + oktaf (60 -> 'C4', 69 -> 'A4')
 */
export function midiToNoteName(midiNumber) {
  const roundedMidi = Math.round(midiNumber);
  const noteIndex = ((roundedMidi % 12) + 12) % 12;
  const octave = Math.floor(roundedMidi / 12) - 1;
  return `${NOTE_NAMES[noteIndex]}${octave}`;
}

/**
 * Nama nada tanpa oktaf ('C#4' -> 'C#')
 */
export function getBaseNoteName(noteWithOctave) {
  return noteWithOctave ? noteWithOctave.replace(/[0-9\-]/g, '') : '';
}

/**
 * Deviasi cent dari nada terdekat (-50..+50)
 */
export function getCentsOffset(freqHz) {
  if (!freqHz || freqHz <= 0) return 0;
  const midiFloat = freqToMidi(freqHz);
  const nearestMidi = Math.round(midiFloat);
  const idealFreq = midiToFreq(nearestMidi);
  return Math.round(1200 * Math.log2(freqHz / idealFreq));
}

// ---------------------------------------------------------------------------
// Deteksi chord dari spektrum
// ---------------------------------------------------------------------------

const CHORD_DETECTION_OPTIONS = {
  minFreq: 75, // ~E2
  maxFreq: 1500,
  presenceDb: -65, // puncak terkuat harus di atas ini, selain itu dianggap hening
  dynamicRangeDb: 28, // abaikan puncak yang >28 dB lebih lemah dari puncak terkuat
  memoryMs: 220, // konstanta waktu akumulasi chroma
  minScore: 0.8, // cosine similarity minimum
  minMargin: 0.04, // selisih minimum dengan kandidat terbaik kedua
  minToneRatio: 0.15, // tiap nada chord minimal 15% dari kelas nada terkuat
  confirmMs: 120, // kandidat harus unggul selama ini sebelum menggantikan chord aktif
  candidateGraceMs: 150, // kandidat tetap hidup selama ragu sesaat (skor berfluktuasi)
  holdMs: 1200, // chord ditahan selama ini setelah sinyal hilang
};

// Bobot nada dalam template: root sedikit lebih penting
const TEMPLATE_WEIGHTS = [1.0, 0.95, 0.9];

const TEMPLATE_VECTORS = Object.entries(CHORD_TEMPLATES).map(([key, tpl]) => {
  const vec = new Float32Array(12);
  tpl.bins.forEach((bin, i) => {
    vec[bin] = TEMPLATE_WEIGHTS[i];
  });
  let norm = 0;
  for (let i = 0; i < 12; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  for (let i = 0; i < 12; i++) vec[i] /= norm;
  return { key, bins: tpl.bins, vec };
});

/**
 * Chroma (Pitch Class Profile) satu frame dari puncak spektrum.
 * @returns {Float32Array|null} 12 bin, atau null bila hening / tak ada puncak
 */
function computeFrameChroma(freqData, sampleRate, fftSize, o) {
  const binRes = sampleRate / fftSize;
  const lo = Math.max(2, Math.ceil(o.minFreq / binRes));
  const hi = Math.min(freqData.length - 3, Math.floor(o.maxFreq / binRes));
  if (hi <= lo) return null;

  let maxDb = -Infinity;
  for (let i = lo; i <= hi; i++) {
    if (freqData[i] > maxDb) maxDb = freqData[i];
  }
  if (!(maxDb > o.presenceDb)) return null; // hening (juga menangani NaN / -Infinity)

  const floorDb = maxDb - o.dynamicRangeDb;
  const chroma = new Float32Array(12);
  let peakCount = 0;

  for (let i = lo; i <= hi; i++) {
    const b = freqData[i];
    if (b < floorDb) continue;
    const a = freqData[i - 1];
    const c = freqData[i + 1];
    // Hanya puncak lokal. Syarat "menonjol" yang lebih ketat sengaja TIDAK dipakai: pada
    // FFT 2048 nada rendah yang berdekatan saling menempel (lebar lobus utama ~6 bin),
    // sehingga puncak lemah (mis. terts chord) di dekat puncak kuat akan ikut terbuang.
    // Riak noise sudah tersaring oleh batas dynamicRangeDb di atas.
    if (!(b > a && b >= c)) continue;

    // Interpolasi parabola pada dB -> frekuensi sub-bin
    let p = 0;
    if (Number.isFinite(a) && Number.isFinite(c)) {
      const denom = a - 2 * b + c;
      if (denom !== 0) p = clamp((0.5 * (a - c)) / denom, -0.5, 0.5);
    }
    const freq = (i + p) * binRes;

    const midi = 69 + 12 * Math.log2(freq / 440);
    const nearest = Math.round(midi);
    const frac = Math.abs(midi - nearest);

    const amplitude = Math.sqrt(Math.pow(10, (b - maxDb) / 20)); // kompresi sqrt
    const tuning = Math.max(0.3, 1 - 1.4 * frac); // puncak jauh dari semiton -> kurang meyakinkan
    const lowBias = 1 / (1 + freq / 1000); // harmonik tinggi kurang berbobot

    chroma[((nearest % 12) + 12) % 12] += amplitude * tuning * lowBias;
    peakCount++;
  }

  return peakCount > 0 ? chroma : null;
}

/**
 * Detector chord stateful: akumulasi chroma + hysteresis waktu.
 */
export class ChordDetector {
  constructor(options = {}) {
    this.options = { ...CHORD_DETECTION_OPTIONS, ...options };
    this.reset();
  }

  reset() {
    this._chroma = new Float32Array(12);
    this._lastTime = 0;
    this._lastSignalAt = 0;
    this._current = null;
    this._candidate = null;
    this._candidateSince = 0;
    this._candidateLastSeen = 0;
  }

  /**
   * @param {Float32Array} freqData - dB dari analyser.getFloatFrequencyData
   * @param {number} sampleRate
   * @param {number} [fftSize] - default freqData.length * 2
   * @param {number} [timeMs] - override waktu (untuk pengujian)
   * @returns {string|null} kunci chord (mis. 'Am') atau null
   */
  update(freqData, sampleRate, fftSize = (freqData ? freqData.length * 2 : 0), timeMs = nowMs()) {
    if (!freqData || freqData.length === 0 || !(sampleRate > 0)) return this._current;
    const o = this.options;

    const dt = this._lastTime ? clamp(timeMs - this._lastTime, 1, 200) : 16;
    this._lastTime = timeMs;

    const frame = computeFrameChroma(freqData, sampleRate, fftSize, o);

    if (!frame) {
      // Tidak ada sinyal: tahan chord terakhir sebentar, lalu lepas
      if (this._current !== null && timeMs - this._lastSignalAt > o.holdMs) {
        this.reset();
      }
      return this._current;
    }

    this._lastSignalAt = timeMs;

    // Akumulasi chroma (exponential moving average, independen dari frame rate)
    const alpha = 1 - Math.exp(-dt / o.memoryMs);
    for (let i = 0; i < 12; i++) {
      this._chroma[i] += (frame[i] - this._chroma[i]) * alpha;
    }

    const match = this._match();
    const confident =
      match &&
      match.score >= o.minScore &&
      match.margin >= o.minMargin &&
      match.weakestTone >= o.minToneRatio;

    if (confident && match.key !== this._current) {
      if (this._candidate !== match.key) {
        this._candidate = match.key;
        this._candidateSince = timeMs;
      }
      this._candidateLastSeen = timeMs;
      if (timeMs - this._candidateSince >= o.confirmMs) {
        this._current = match.key;
        this._candidate = null;
      }
    } else if (confident) {
      // sama dengan chord aktif -> tidak ada kandidat baru
      this._candidate = null;
    } else if (this._candidate !== null && timeMs - this._candidateLastSeen > o.candidateGraceMs) {
      // skor sempat ragu sebentar boleh (fluktuasi normal); ragu lama -> batalkan kandidat
      this._candidate = null;
    }

    return this._current;
  }

  _match() {
    const chroma = this._chroma;
    let norm = 0;
    let maxC = 0;
    for (let i = 0; i < 12; i++) {
      norm += chroma[i] * chroma[i];
      if (chroma[i] > maxC) maxC = chroma[i];
    }
    if (norm <= 0 || maxC <= 0) return null;
    norm = Math.sqrt(norm);

    let best = null;
    let bestScore = -1;
    let secondScore = -1;
    for (const tpl of TEMPLATE_VECTORS) {
      let dot = 0;
      for (const b of tpl.bins) dot += chroma[b] * tpl.vec[b];
      const score = dot / norm; // cosine similarity
      if (score > bestScore) {
        secondScore = bestScore;
        bestScore = score;
        best = tpl;
      } else if (score > secondScore) {
        secondScore = score;
      }
    }

    // Semua nada chord harus benar-benar hadir (menolak nada tunggal berharmonik)
    let weakestTone = Infinity;
    for (const b of best.bins) weakestTone = Math.min(weakestTone, chroma[b] / maxC);

    return { key: best.key, score: bestScore, margin: bestScore - secondScore, weakestTone };
  }
}

const defaultChordDetector = new ChordDetector();

/**
 * API lama (kompatibel): perkirakan chord dari spektrum.
 * Sekarang stateful (akumulasi + hysteresis), panggil tiap frame.
 * @param {Float32Array} freqData - dB dari analyser.getFloatFrequencyData
 * @param {number} sampleRate
 * @param {number} fftSize
 * @returns {string|null} kunci chord atau null
 */
export function detectChordFromSpectrum(freqData, sampleRate, fftSize) {
  return defaultChordDetector.update(freqData, sampleRate, fftSize);
}

export function resetChordDetector() {
  defaultChordDetector.reset();
}

// ---------------------------------------------------------------------------
// Interval & analisis pitch
// ---------------------------------------------------------------------------

const INTERVAL_NAMES = {
  0: 'Root (1)',
  1: 'b2',
  2: 'Major 2nd (2)',
  3: 'Minor 3rd (b3)',
  4: 'Major 3rd (3)',
  5: 'Perfect 4th (4)',
  6: 'b5 / #4',
  7: 'Perfect 5th (5)',
  8: 'b6',
  9: 'Major 6th (6)',
  10: 'Minor 7th (b7)',
  11: 'Major 7th (7)',
};

/**
 * Interval antara sebuah nada dan root chord
 */
export function getIntervalName(noteMidi, chordKey) {
  const tpl = chordKey && chordKey !== 'AUTO' ? CHORD_TEMPLATES[chordKey] : null;
  if (!tpl) return null;
  const noteIndex = ((Math.round(noteMidi) % 12) + 12) % 12;
  return INTERVAL_NAMES[(noteIndex - tpl.bins[0] + 12) % 12] || null;
}

// Nada sebelumnya dipertahankan sampai pitch menyimpang lebih dari ini (semiton),
// sehingga label tidak berkedip di batas dua nada (±50 cent).
const NOTE_HYSTERESIS = 0.58;

const SILENT_ANALYSIS = {
  freq: 0,
  midi: null,
  roundedMidi: null,
  noteName: '--',
  baseNote: '',
  octave: null,
  cents: 0,
  status: 'SILENT',
  guidance: 'Mainkan nada atau bernyanyilah...',
  interval: null,
  isChordTone: null,
};

/**
 * Paket analisis pitch lengkap dengan panduan.
 * @param {number} freqHz
 * @param {string} activeChord - 'AUTO' atau kunci chord
 * @param {string|null} detectedChordKey - chord hasil Auto-Detect
 * @param {number|null} prevRoundedMidi - nada terkunci frame sebelumnya (untuk hysteresis)
 */
export function analyzePitch(
  freqHz,
  activeChord = 'AUTO',
  detectedChordKey = null,
  prevRoundedMidi = null
) {
  if (!freqHz || freqHz <= 0) return { ...SILENT_ANALYSIS };

  const midiFloat = freqToMidi(freqHz);
  let roundedMidi = Math.round(midiFloat);
  if (prevRoundedMidi !== null && Math.abs(midiFloat - prevRoundedMidi) < NOTE_HYSTERESIS) {
    roundedMidi = prevRoundedMidi;
  }

  const noteName = midiToNoteName(roundedMidi);
  const pitchClass = ((roundedMidi % 12) + 12) % 12;
  const baseNote = NOTE_NAMES[pitchClass];
  const octave = Math.floor(roundedMidi / 12) - 1;
  const cents = clamp(Math.round((midiFloat - roundedMidi) * 100), -50, 50);

  let status = 'ON-PITCH';
  let guidance = `Pas di nada ${noteName}! Pertahankan.`;

  if (cents > 10) {
    status = 'SHARP';
    guidance = `Terlalu tinggi (+${cents}c). Turunkan nada vokal Anda sedikit ↓ ke ${noteName}`;
  } else if (cents < -10) {
    status = 'FLAT';
    guidance = `Terlalu rendah (${cents}c). Naikkan nada vokal Anda sedikit ↑ ke ${noteName}`;
  }

  // Hubungan dengan chord
  const chordToUse = activeChord === 'AUTO' ? detectedChordKey : activeChord;
  const interval = getIntervalName(roundedMidi, chordToUse);
  const template = chordToUse ? CHORD_TEMPLATES[chordToUse] : null;
  const isChordTone = template ? template.bins.includes(pitchClass) : null;

  if (interval) {
    guidance = `${guidance} (Interval: ${interval} di chord ${chordToUse})`;
  }

  return {
    freq: Math.round(freqHz),
    midi: midiFloat,
    roundedMidi,
    noteName,
    baseNote,
    octave,
    cents,
    status,
    guidance,
    interval,
    isChordTone,
  };
}