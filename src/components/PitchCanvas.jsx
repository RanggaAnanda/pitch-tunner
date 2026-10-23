// src/components/PitchCanvas.jsx
import React, { useEffect, useRef } from 'react';
import {
  DISPLAY_Y_NOTES,
  CHORD_DEFINITIONS,
  CHORD_TEMPLATES,
  freqToMidi,
  detectChordFromSpectrum,
  NOTE_NAMES
} from '../utils/noteConverter';

const NOTE_TO_MIDI = {
  'C3': 48, 'D3': 50, 'E3': 52, 'F3': 53, 'G3': 55, 'A3': 57, 'B3': 59,
  'C4': 60, 'D4': 62, 'E4': 64, 'F4': 65, 'G4': 67, 'A4': 69, 'B4': 71,
  'C5': 72,
};

const MIN_MIDI = 48; // C3
const MAX_MIDI = 72; // C5

export default function PitchCanvas({
  isRecording,
  audioEngine,
  activeChord,
  sensitivity = 0.3,
  onPitchUpdate,
  onAutoChordDetected,
}) {
  const canvasRef = useRef(null);
  const animFrameRef = useRef(null);
  const pitchHistoryRef = useRef([]);
  const smoothedYRef = useRef(null);
  const autoDetectedChordRef = useRef(null);
  const lastActiveTargetNotesRef = useRef([]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    const handleResize = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      ctx.resetTransform();
      ctx.scale(dpr, dpr);
    };

    handleResize();
    window.addEventListener('resize', handleResize);

    const historyLength = 120;
    if (pitchHistoryRef.current.length === 0) {
      pitchHistoryRef.current = new Array(historyLength).fill(null);
    }

    let isRunning = true;

    const midiToY = (midiVal, h, paddingTop = 20, paddingBottom = 20) => {
      const usableHeight = h - paddingTop - paddingBottom;
      const normalized = (midiVal - MIN_MIDI) / (MAX_MIDI - MIN_MIDI);
      const clamped = Math.max(0, Math.min(1, normalized));
      return paddingTop + (1 - clamped) * usableHeight;
    };

    const render = () => {
      if (!isRunning) return;

      const rect = canvas.getBoundingClientRect();
      const width = rect.width;
      const height = rect.height;

      const leftMargin = 60;
      const graphWidth = width - leftMargin - 15;
      const paddingTop = 20;
      const paddingBottom = 20;
      const usableHeight = height - paddingTop - paddingBottom;
      const semitoneHeight = usableHeight / (MAX_MIDI - MIN_MIDI);

      // 1. Process Live Audio
      let currentFreq = null;
      let detectedChordKey = null;

      if (isRecording && audioEngine && audioEngine.analyser) {
        const timeBuffer = new Float32Array(audioEngine.analyser.fftSize);
        audioEngine.analyser.getFloatTimeDomainData(timeBuffer);

        if (audioEngine.detectPitch) {
          currentFreq = audioEngine.detectPitch(timeBuffer, sensitivity);
        }

        // Run Chromagram Chord Recognition (if in AUTO mode)
        if (activeChord === 'AUTO') {
          const freqBuffer = new Float32Array(audioEngine.analyser.frequencyBinCount);
          audioEngine.analyser.getFloatFrequencyData(freqBuffer);

          detectedChordKey = detectChordFromSpectrum(
            freqBuffer,
            audioEngine.audioContext.sampleRate,
            audioEngine.analyser.fftSize
          );

          if (detectedChordKey && detectedChordKey !== autoDetectedChordRef.current) {
            autoDetectedChordRef.current = detectedChordKey;
            if (onAutoChordDetected) {
              onAutoChordDetected(detectedChordKey);
            }
          }
        }
      }

      // Notify parent of live pitch
      if (onPitchUpdate) {
        onPitchUpdate(currentFreq);
      }

      // Calculate Target Notes for Highlight Bands
      let activeNotesToHighlight = [];

      if (activeChord === 'AUTO') {
        // If a guitar chord was detected in spectrum, highlight its notes
        if (autoDetectedChordRef.current && CHORD_TEMPLATES[autoDetectedChordRef.current]) {
          activeNotesToHighlight = CHORD_TEMPLATES[autoDetectedChordRef.current].notes;
        } else if (currentFreq && currentFreq > 0) {
          // If singing a single note, dynamically highlight nearest note target!
          const midi = freqToMidi(currentFreq);
          const nearestMidi = Math.round(midi);
          const baseName = NOTE_NAMES[((nearestMidi % 12) + 12) % 12];
          activeNotesToHighlight = [baseName];
        } else if (lastActiveTargetNotesRef.current.length > 0) {
          // Keep previous target visible during brief pauses
          activeNotesToHighlight = lastActiveTargetNotesRef.current;
        }
      } else {
        // Fixed manual chord
        const targetData = CHORD_DEFINITIONS[activeChord] || CHORD_DEFINITIONS['C'];
        activeNotesToHighlight = targetData.notes || [];
      }

      if (activeNotesToHighlight.length > 0) {
        lastActiveTargetNotesRef.current = activeNotesToHighlight;
      }

      // Convert current frequency to smoothed canvas Y
      let targetY = null;
      let isCurrentOnPitch = false;

      if (currentFreq && currentFreq > 0) {
        const midi = freqToMidi(currentFreq);
        if (midi >= MIN_MIDI - 1 && midi <= MAX_MIDI + 1) {
          targetY = midiToY(midi, height, paddingTop, paddingBottom);
          const nearestMidi = Math.round(midi);
          const centsDiff = Math.abs(1200 * (midi - nearestMidi));
          isCurrentOnPitch = centsDiff <= 12;
        }
      }

      // Exponential moving average filter
      if (targetY !== null) {
        if (smoothedYRef.current === null) {
          smoothedYRef.current = targetY;
        } else {
          smoothedYRef.current += (targetY - smoothedYRef.current) * 0.35;
        }
      } else {
        smoothedYRef.current = null;
      }

      pitchHistoryRef.current.shift();
      pitchHistoryRef.current.push(smoothedYRef.current);

      // --- CANVAS RENDERING ---
      ctx.clearRect(0, 0, width, height);

      // Dark background gradient
      const bgGrad = ctx.createLinearGradient(0, 0, 0, height);
      bgGrad.addColorStop(0, '#101423');
      bgGrad.addColorStop(1, '#0c0f1b');
      ctx.fillStyle = bgGrad;
      ctx.fillRect(0, 0, width, height);

      // 2. Draw Target Chord / Note Highlight Bands
      activeNotesToHighlight.forEach((noteLetter) => {
        for (let oct = 3; oct <= 5; oct++) {
          const noteKey = `${noteLetter}${oct}`;
          const midiVal = NOTE_TO_MIDI[noteKey];
          if (midiVal !== undefined && midiVal >= MIN_MIDI && midiVal <= MAX_MIDI) {
            const centerY = midiToY(midiVal, height, paddingTop, paddingBottom);
            const bandHeight = semitoneHeight * 1.05;
            const topY = centerY - bandHeight / 2;

            // When singing right on target, band glows brighter emerald green!
            if (isCurrentOnPitch && Math.abs((smoothedYRef.current || 0) - centerY) < bandHeight) {
              ctx.fillStyle = 'rgba(52, 211, 153, 0.40)';
            } else {
              ctx.fillStyle = 'rgba(110, 231, 183, 0.25)';
            }

            ctx.fillRect(leftMargin, topY, graphWidth, bandHeight);

            // Subtle border accents on band
            ctx.fillStyle = 'rgba(110, 231, 183, 0.45)';
            ctx.fillRect(leftMargin, topY, graphWidth, 1);
            ctx.fillRect(leftMargin, topY + bandHeight - 1, graphWidth, 1);
          }
        }
      });

      // 3. Draw Grid Lines and Y-Axis Labels
      DISPLAY_Y_NOTES.forEach((noteName) => {
        const midiVal = NOTE_TO_MIDI[noteName];
        if (midiVal !== undefined) {
          const y = midiToY(midiVal, height, paddingTop, paddingBottom);

          // Grid line
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(leftMargin, y);
          ctx.lineTo(leftMargin + graphWidth, y);
          ctx.stroke();

          // Highlight label if it's currently a target note
          const baseName = noteName.replace(/[0-9]/g, '');
          const isTarget = activeNotesToHighlight.includes(baseName);

          ctx.fillStyle = isTarget ? '#a7f3d0' : '#94a3b8';
          ctx.font = isTarget
            ? 'bold 13px system-ui, -apple-system, sans-serif'
            : '500 13px system-ui, -apple-system, sans-serif';
          ctx.textAlign = 'right';
          ctx.textBaseline = 'middle';
          ctx.fillText(noteName, leftMargin - 14, y);
        }
      });

      // 4. Draw Real-time Neon Pitch Waveform
      const history = pitchHistoryRef.current;
      const count = history.length;
      const stepX = graphWidth / (count - 1);

      ctx.save();
      ctx.beginPath();
      ctx.rect(leftMargin, 0, graphWidth + 20, height);
      ctx.clip();

      ctx.strokeStyle = isCurrentOnPitch ? '#34d399' : '#22d3ee'; // Turns emerald green when ON-PITCH
      ctx.lineWidth = 3.5;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.shadowColor = isCurrentOnPitch ? '#34d399' : '#22d3ee';
      ctx.shadowBlur = 10;

      let inLine = false;
      let lastPoint = null;

      ctx.beginPath();
      for (let i = 0; i < count; i++) {
        const yVal = history[i];
        const xPos = leftMargin + i * stepX;

        if (yVal !== null) {
          if (!inLine) {
            ctx.moveTo(xPos, yVal);
            inLine = true;
          } else {
            ctx.lineTo(xPos, yVal);
          }
          lastPoint = { x: xPos, y: yVal };
        } else {
          inLine = false;
        }
      }
      ctx.stroke();

      // 5. Draw Glowing Leading Orb
      if (lastPoint && smoothedYRef.current !== null) {
        const headX = leftMargin + (count - 1) * stepX;
        const headY = smoothedYRef.current;

        const orbColor = isCurrentOnPitch ? '52, 211, 153' : '34, 211, 238';

        const haloGrad = ctx.createRadialGradient(headX, headY, 2, headX, headY, 20);
        haloGrad.addColorStop(0, `rgba(${orbColor}, 0.9)`);
        haloGrad.addColorStop(0.4, `rgba(${orbColor}, 0.4)`);
        haloGrad.addColorStop(1, `rgba(${orbColor}, 0)`);

        ctx.fillStyle = haloGrad;
        ctx.beginPath();
        ctx.arc(headX, headY, 20, 0, Math.PI * 2);
        ctx.fill();

        ctx.shadowColor = isCurrentOnPitch ? '#34d399' : '#38bdf8';
        ctx.shadowBlur = 15;
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(headX, headY, 6.5, 0, Math.PI * 2);
        ctx.fill();

        ctx.strokeStyle = isCurrentOnPitch ? '#34d399' : '#38bdf8';
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(headX, headY, 6.5, 0, Math.PI * 2);
        ctx.stroke();
      }

      ctx.restore();

      animFrameRef.current = requestAnimationFrame(render);
    };

    render();

    return () => {
      isRunning = false;
      if (animFrameRef.current) {
        cancelAnimationFrame(animFrameRef.current);
      }
      window.removeEventListener('resize', handleResize);
    };
  }, [isRecording, audioEngine, activeChord, sensitivity]);

  return (
    <div className="w-full h-full relative">
      <canvas
        ref={canvasRef}
        className="w-full h-[400px] block rounded-xl shadow-2xl"
      />
    </div>
  );
}
