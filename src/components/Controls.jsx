// src/components/Controls.jsx
import React from "react";

/**
 * Controls component.
 * Props:
 *   isRecording (bool) – current mic state.
 *   onToggleMic (fn) – called with new boolean when user clicks the button.
 *   activeChord (string) – currently selected chord identifier.
 *   onChangeChord (fn) – called with the new chord value when the select changes.
 */
export default function Controls({ isRecording, onToggleMic, activeChord, onChangeChord }) {
  const chordOptions = [
    { value: "C", label: "C Major (C,E,G)" },
    { value: "G", label: "G Major (G,B,D)" },
    { value: "Am", label: "A Minor (A,C,E)" },
    { value: "F", label: "F Major (F,A,C)" },
  ];

  return (
    <div className="flex flex-col sm:flex-row items-center justify-between p-4 bg-gray-800 rounded-lg mb-4">
      {/* Start / Stop Mic */}
      <button
        onClick={() => onToggleMic(!isRecording)}
        className={
          "px-4 py-2 rounded-md font-medium transition-colors " +
          (isRecording ? "bg-red-600 hover:bg-red-700" : "bg-green-600 hover:bg-green-700")
        }
      >
        {isRecording ? "Stop Mic" : "Start Mic"}
      </button>

      {/* Chord selector */}
      <div className="mt-4 sm:mt-0">
        <label htmlFor="chord-select" className="mr-2 text-gray-200">
          Target Chord:
        </label>
        <select
          id="chord-select"
          value={activeChord}
          onChange={(e) => onChangeChord(e.target.value)}
          className="bg-gray-700 text-white rounded-md p-2 focus:outline-none"
        >
          {chordOptions.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
