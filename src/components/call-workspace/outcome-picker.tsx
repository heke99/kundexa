"use client";

import { useEffect, useMemo, useState } from "react";
import { callbackPresets, groupOutcomes, type OutcomeOption } from "@/lib/dialer/outcomes";

/**
 * Utfallet som knappar grupperade efter betydelse. Siffertangent 1–9 väljer
 * utfall när fokus inte ligger i ett textfält, så en van säljare klarar
 * efterarbetet utan mus.
 */
export function OutcomePicker({ options, value, onChange, disabled }: {
  options: OutcomeOption[];
  value: string;
  onChange: (key: string) => void;
  disabled?: boolean;
}) {
  const groups = useMemo(() => groupOutcomes(options), [options]);

  useEffect(() => {
    if (disabled) return;
    const byShortcut = new Map<string, string>();
    for (const group of groups) for (const option of group.options) if (option.shortcut) byShortcut.set(String(option.shortcut), option.key);
    function onKey(event: KeyboardEvent) {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return;
      const key = byShortcut.get(event.key);
      if (!key) return;
      event.preventDefault();
      onChange(key);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [groups, onChange, disabled]);

  return <div className="outcome-picker" role="radiogroup" aria-label="Samtalsutfall">
    {groups.map((group) => <div className="outcome-group" key={group.key}>
      <span className="outcome-group-label">{group.label}</span>
      <div className="outcome-chips">
        {group.options.map((option) => <button
          key={option.key}
          type="button"
          role="radio"
          aria-checked={value === option.key}
          className={`outcome-chip outcome-${group.tone}${value === option.key ? " selected" : ""}`}
          onClick={() => onChange(option.key)}
          disabled={disabled}
        >
          {option.shortcut ? <kbd>{option.shortcut}</kbd> : null}
          {option.label}
        </button>)}
      </div>
    </div>)}
  </div>;
}

/** Tid för återkomst: snabbval plus fritt fält. */
export function CallbackTimeField({ value, onChange, required }: { value: string; onChange: (value: string) => void; required?: boolean }) {
  // Räknas vid visning. En klocka som går mellan renderingar behövs inte:
  // efterarbetet tar sekunder, och fältet går alltid att ändra för hand.
  const [presets] = useState(() => callbackPresets(new Date()));
  return <div className="field">
    <span>Tid för återkomst</span>
    <div className="outcome-chips">
      {presets.map((preset) => <button key={preset.label} type="button" className={`outcome-chip outcome-info${value === preset.value ? " selected" : ""}`} onClick={() => onChange(preset.value)}>{preset.label}</button>)}
    </div>
    <input type="datetime-local" required={required} value={value} onChange={(event) => onChange(event.target.value)} />
  </div>;
}
