// src/components/HeaderControls.jsx
import React from 'react';
import { CHORD_DEFINITIONS } from '../utils/noteConverter';

export default function HeaderControls({
  isRecording,
  onToggleMic,
  activeChord,
  onChangeChord,
  detectedChordName,
}) {
  return (
    <header className="w-full flex flex-wrap items-center justify-between gap-4 mb-5">
      {/* Title & Live Status */}
      <div className="flex items-center gap-4 flex-wrap">
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-white flex items-center gap-2">
          Vocal Pitch &amp; Chord Matcher
        </h1>

        {isRecording && (
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-red-500/10 border border-red-500/30 text-red-400 text-xs font-semibold tracking-wider animate-pulse">
            <span className="w-2 h-2 rounded-full bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.8)]"></span>
            RECORDING
          </div>
        )}

        <button
          onClick={() => onToggleMic(!isRecording)}
          className={`px-5 py-2 rounded-lg font-bold text-sm tracking-wide shadow-lg transition-all duration-200 cursor-pointer ${
            isRecording
              ? 'bg-[#ef4444] hover:bg-[#dc2626] text-white shadow-red-500/30'
              : 'bg-[#3b82f6] hover:bg-[#2563eb] text-white shadow-blue-500/30'
          }`}
        >
          {isRecording ? 'STOP MIC' : 'START MIC'}
        </button>

        {/* Live Detected Chord Badge when in AUTO mode */}
        {isRecording && activeChord === 'AUTO' && detectedChordName && (
          <div className="flex items-center gap-1.5 px-3 py-1 rounded-lg bg-emerald-500/15 border border-emerald-500/40 text-emerald-300 text-xs font-bold animate-bounce">
            🎸 Chord Gitar: {detectedChordName}
          </div>
        )}
      </div>

      {/* Target Chord Selector */}
      <div className="relative">
        <select
          value={activeChord}
          onChange={(e) => onChangeChord(e.target.value)}
          className="appearance-none bg-[#161c2d] hover:bg-[#1a2237] border border-[#2b354d] text-gray-200 text-sm font-medium rounded-xl px-4 py-2.5 pr-10 focus:outline-none focus:ring-2 focus:ring-blue-500/50 cursor-pointer shadow-md transition-all"
        >
          {Object.entries(CHORD_DEFINITIONS).map(([key, item]) => (
            <option key={key} value={key} className="bg-[#121626] text-white">
              {key === 'AUTO' ? `✨ ${item.label}` : `Target Chord: ${item.label}`}
            </option>
          ))}
        </select>
        {/* Chevron icon */}
        <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-3 text-gray-400">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7" />
          </svg>
        </div>
      </div>
    </header>
  );
}
