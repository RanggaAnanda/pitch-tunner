// src/components/TunerDisplay.jsx
import React from 'react';

export default function TunerDisplay({
  pitchData,
  isRecording,
  sensitivity,
  onSensitivityChange,
  audioDevices,
  selectedDevice,
  onSelectDevice,
  activeChord,
  detectedChordName,
}) {
  const { noteName, cents, status, freq, guidance, interval, stability } = pitchData || {
    noteName: '--',
    cents: 0,
    status: 'SILENT',
    freq: 0,
    guidance: 'Mainkan nada atau bernyanyilah...',
    interval: null,
    stability: 0,
  };

  const isSilent = !isRecording || noteName === '--' || freq === 0;

  // Calculate needle position (-50 to +50 cents -> 5% to 95%)
  const needlePercent = isSilent
    ? 50
    : Math.max(5, Math.min(95, ((cents + 50) / 100) * 100));

  let statusColor = 'text-gray-400';
  let needleColor = 'bg-gray-600';
  let badgeBg = 'bg-gray-800 text-gray-400';

  if (!isSilent) {
    if (Math.abs(cents) <= 10) {
      statusColor = 'text-[#34d399]'; // Mint green (on-pitch)
      needleColor = 'bg-[#34d399] shadow-[0_0_12px_#34d399]';
      badgeBg = 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40';
    } else if (cents < -10) {
      statusColor = 'text-amber-400'; // Flat
      needleColor = 'bg-amber-400 shadow-[0_0_10px_#fbbf24]';
      badgeBg = 'bg-amber-500/20 text-amber-300 border border-amber-500/40';
    } else {
      statusColor = 'text-cyan-400'; // Sharp
      needleColor = 'bg-cyan-400 shadow-[0_0_10px_#22d3ee]';
      badgeBg = 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40';
    }
  }

  const centsLabel = isSilent
    ? '--'
    : cents > 0
    ? `+${cents} cents`
    : `${cents} cents`;

  return (
    <div className="w-full flex flex-col gap-5 mt-4">
      {/* Upper Row: Note Display & Flat/Sharp Tuner */}
      <div className="w-full flex flex-col md:flex-row items-center justify-between gap-6 px-2">
        {/* Left: Current Note and Real-time Navigation Guidance */}
        <div className="flex flex-col items-center md:items-start text-center md:text-left">
          <div className="flex items-center gap-3 flex-wrap justify-center md:justify-start">
            <div className="text-3xl sm:text-4xl font-extrabold tracking-tight text-[#34d399] drop-shadow-[0_0_15px_rgba(52,211,153,0.3)]">
              {isSilent ? '--' : noteName}
            </div>
            {!isSilent && (
              <span className={`text-xs px-2.5 py-1 rounded-md font-bold uppercase tracking-wider ${badgeBg}`}>
                {status}
              </span>
            )}
            {interval && (
              <span className="text-xs px-2.5 py-1 rounded-md font-bold uppercase tracking-wider bg-purple-500/20 text-purple-300 border border-purple-500/40">
                {interval}
              </span>
            )}
            {!isSilent && (
              <span className="text-xs font-bold text-gray-500">
                Stability: {stability}%
              </span>
            )}
          </div>

          <div className="text-sm font-medium text-gray-300 mt-1 flex items-center gap-2 flex-wrap justify-center md:justify-start">
            <span>Akurasi pitch:</span>
            <span className={`font-semibold ${statusColor}`}>
              {isSilent ? '--' : `${centsLabel} (${status})`}
            </span>
            {!isSilent && freq > 0 && (
              <span className="text-gray-500 font-mono text-xs">({freq} Hz)</span>
            )}
          </div>

          {/* Interactive Singing Guide */}
          {!isSilent && (
            <div className="mt-2 text-xs font-medium text-cyan-200/90 bg-cyan-950/40 border border-cyan-800/50 px-3 py-1.5 rounded-lg flex items-center gap-2">
              <span>🎯</span>
              <span>{guidance}</span>
            </div>
          )}
        </div>

        {/* Right: Flat / Sharp Tuning Meter */}
        <div className="bg-[#121626] border border-[#222a40] rounded-xl px-6 py-3.5 flex flex-col items-center min-w-[260px] shadow-lg">
          <span className="text-[11px] font-bold tracking-wider text-gray-400 uppercase mb-2">
            Flat / Sharp
          </span>

          {/* Meter Bar */}
          <div className="w-56 h-4 bg-[#1b2238] rounded-full relative flex items-center px-1 border border-[#2a3450]">
            {/* Center Zero Marker */}
            <div className="absolute left-1/2 -translate-x-1/2 w-0.5 h-full bg-gray-500/50"></div>

            {/* Slider Needle */}
            <div
              className={`absolute top-0.5 bottom-0.5 w-2.5 rounded-full transition-all duration-75 ${needleColor}`}
              style={{ left: `calc(${needlePercent}% - 5px)` }}
            ></div>
          </div>

          <div className="w-56 flex justify-between text-[10px] font-semibold text-gray-400 mt-1.5 px-1">
            <span className="text-amber-400/80">Flat (Kerendahan)</span>
            <span className="text-[#34d399] font-bold">On-Pitch</span>
            <span className="text-cyan-400/80">Sharp (Ketinggian)</span>
          </div>
        </div>
      </div>

      {/* Lower Row: Sensitivity & Audio Input Source */}
      <div className="w-full flex flex-wrap items-center justify-between gap-6 pt-3 border-t border-[#1e263d] text-xs text-gray-400 px-2">
        {/* Sensitivity Slider */}
        <div className="flex items-center gap-3">
          <label htmlFor="sensitivity-range" className="font-medium text-gray-300">
            Sensitivity:
          </label>
          <input
            id="sensitivity-range"
            type="range"
            min="0.05"
            max="0.8"
            step="0.05"
            value={sensitivity}
            onChange={(e) => onSensitivityChange(parseFloat(e.target.value))}
            className="w-28 sm:w-36 h-1.5 bg-[#1f283f] rounded-lg appearance-none cursor-pointer accent-blue-500"
          />
          <span className="text-gray-300 font-mono min-w-[32px]">
            {Math.round(sensitivity * 100)}%
          </span>
        </div>

        {/* Audio Input Device Dropdown */}
        <div className="flex items-center gap-2">
          <label htmlFor="audio-device-select" className="font-medium text-gray-300">
            Audio Input Source:
          </label>
          <select
            id="audio-device-select"
            value={selectedDevice || ''}
            onChange={(e) => onSelectDevice(e.target.value)}
            className="bg-[#141a2c] border border-[#26314c] text-gray-300 text-xs rounded-lg px-2.5 py-1.5 outline-none focus:ring-1 focus:ring-blue-500 cursor-pointer max-w-[220px] truncate"
          >
            {audioDevices.length > 0 ? (
              audioDevices.map((dev, idx) => (
                <option key={dev.deviceId || idx} value={dev.deviceId}>
                  {dev.label || `Microphone ${idx + 1}`}
                </option>
              ))
            ) : (
              <option value="">Default Microphone</option>
            )}
          </select>
        </div>
      </div>
    </div>
  );
}
