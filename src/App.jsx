// src/App.jsx
import React, { useState, useRef, useEffect, useCallback } from 'react';
import HeaderControls from './components/HeaderControls';
import PitchCanvas from './components/PitchCanvas';
import TunerDisplay from './components/TunerDisplay';
import { initAudio, stopAudio, getAudioInputDevices } from './utils/audioEngine';
import { analyzePitch, resetChordDetector, CHORD_TEMPLATES } from './utils/noteConverter';

const SILENT_PITCH = {
  noteName: '--',
  cents: 0,
  status: 'SILENT',
  freq: 0,
  guidance: 'Mainkan nada atau bernyanyilah...',
  stability: 0,
};

// Jumlah frame terakhir yang dipakai untuk menghitung stabilitas nada
const STABILITY_WINDOW = 20;

/**
 * Stabilitas 0..100 dari deviasi standar pitch (dalam cent) pada jendela terakhir.
 * <= 5 cent -> 100%, >= 35 cent -> 0%. Skor naik bertahap sampai jendela terisi penuh,
 * jadi nada yang baru mulai tidak langsung dianggap stabil.
 */
function computeStability(history) {
  const n = history.length;
  if (n < 3) return 0;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += history[i];
  mean /= n;
  let variance = 0;
  for (let i = 0; i < n; i++) variance += (history[i] - mean) ** 2;
  const stdCents = Math.sqrt(variance / n) * 100;
  const steadiness = Math.min(1, Math.max(0, (35 - stdCents) / 30));
  const fill = Math.min(1, n / STABILITY_WINDOW);
  return Math.round(steadiness * fill * 100);
}

export default function App() {
  const [isRecording, setIsRecording] = useState(false);
  // Default AUTO agar pengguna tidak perlu memilih chord secara manual
  const [activeChord, setActiveChord] = useState('AUTO');
  const [detectedChordKey, setDetectedChordKey] = useState(null);
  const [sensitivity, setSensitivity] = useState(0.3);
  const [audioDevices, setAudioDevices] = useState([]);
  const [selectedDevice, setSelectedDevice] = useState('');
  const [pitchData, setPitchData] = useState(SILENT_PITCH);

  const audioEngineRef = useRef(null);
  const stabilityRef = useRef({ history: [], lockedMidi: null });

  useEffect(() => {
    getAudioInputDevices().then((devices) => {
      setAudioDevices(devices);
      if (devices.length > 0 && !selectedDevice) {
        setSelectedDevice(devices[0].deviceId);
      }
    });
  }, [selectedDevice]);

  const resetTracking = () => {
    stabilityRef.current.history.length = 0;
    stabilityRef.current.lockedMidi = null;
    resetChordDetector();
  };

  // deviceOverride: dipakai saat ganti mikrofon agar tidak terjebak closure `selectedDevice` lama
  const handleToggleMic = async (shouldStart, deviceOverride = null) => {
    if (shouldStart) {
      try {
        // Jangan biarkan dua engine hidup bersamaan
        if (audioEngineRef.current) {
          stopAudio(audioEngineRef.current);
          audioEngineRef.current = null;
        }

        const deviceId =
          typeof deviceOverride === 'string' ? deviceOverride : selectedDevice || null;
        const engine = await initAudio(deviceId);

        resetTracking();
        audioEngineRef.current = engine; // engine.detectPitch sudah disediakan initAudio
        setIsRecording(true);

        getAudioInputDevices().then(setAudioDevices);
      } catch (err) {
        console.error('Error accessing microphone:', err);
        alert('Tidak dapat mengakses mikrofon. Pastikan izin mikrofon diberikan.');
        setIsRecording(false);
      }
    } else {
      stopAudio(audioEngineRef.current);
      audioEngineRef.current = null;
      resetTracking();
      setIsRecording(false);
      setDetectedChordKey(null);
      setPitchData(SILENT_PITCH);
    }
  };

  const handleSelectDevice = async (deviceId) => {
    setSelectedDevice(deviceId);
    if (isRecording) {
      await handleToggleMic(false);
      await new Promise((resolve) => setTimeout(resolve, 150));
      await handleToggleMic(true, deviceId);
    }
  };

  const handlePitchUpdate = useCallback(
    (freq) => {
      const s = stabilityRef.current;
      const analysis = analyzePitch(freq, activeChord, detectedChordKey, s.lockedMidi);

      if (analysis.midi !== null) {
        s.lockedMidi = analysis.roundedMidi; // kunci nama nada (hysteresis)
        s.history.push(analysis.midi);
        if (s.history.length > STABILITY_WINDOW) s.history.shift();
        analysis.stability = computeStability(s.history);
      } else {
        s.lockedMidi = null;
        s.history.length = 0;
        analysis.stability = 0;
      }

      // Hindari re-render berulang saat tetap hening
      setPitchData((prev) =>
        prev.status === 'SILENT' && analysis.status === 'SILENT' ? prev : analysis
      );
    },
    [activeChord, detectedChordKey]
  );

  const handleAutoChordDetected = useCallback((chordKey) => {
    setDetectedChordKey((prev) => (prev === chordKey ? prev : chordKey));
  }, []);

  useEffect(() => {
    return () => {
      stopAudio(audioEngineRef.current);
    };
  }, []);

  const detectedChordName =
    detectedChordKey && CHORD_TEMPLATES[detectedChordKey]
      ? CHORD_TEMPLATES[detectedChordKey].name
      : null;

  return (
    <div className="min-h-screen bg-[#0a0d17] text-white flex flex-col items-center p-4 sm:p-6 lg:p-8 selection:bg-cyan-500/30">
      <div className="w-full max-w-6xl flex flex-col bg-[#0e1322] border border-[#1b233a] rounded-2xl p-5 sm:p-7 shadow-2xl">
        <HeaderControls
          isRecording={isRecording}
          onToggleMic={handleToggleMic}
          activeChord={activeChord}
          onChangeChord={setActiveChord}
          detectedChordName={detectedChordName}
        />

        <div className="w-full bg-[#101423] border border-[#202942] rounded-xl overflow-hidden shadow-inner">
          <PitchCanvas
            isRecording={isRecording}
            audioEngine={audioEngineRef.current}
            activeChord={activeChord}
            sensitivity={sensitivity}
            onPitchUpdate={handlePitchUpdate}
            onAutoChordDetected={handleAutoChordDetected}
          />
        </div>

        <TunerDisplay
          pitchData={pitchData}
          isRecording={isRecording}
          sensitivity={sensitivity}
          onSensitivityChange={setSensitivity}
          audioDevices={audioDevices}
          selectedDevice={selectedDevice}
          onSelectDevice={handleSelectDevice}
          activeChord={activeChord}
          detectedChordName={detectedChordName}
        />
      </div>
    </div>
  );
}