"use client";
import { useState } from "react";
import { killProvider, restoreProvider } from "../lib/api";

export function ChaosPanel() {
  const [killed, setKilled] = useState<Record<string, boolean>>({});

  async function toggle(p: string) {
    if (killed[p]) {
      await restoreProvider(p);
      setKilled(s => ({ ...s, [p]: false }));
    } else {
      await killProvider(p);
      setKilled(s => ({ ...s, [p]: true }));
    }
  }

  return (
    <div style={{ fontFamily: "monospace", padding: "12px 16px", background: "#1a1a2e", borderRadius: 8, marginBottom: 16 }}>
      <div style={{ color: "#6b7280", fontSize: 11, marginBottom: 8 }}>CHAOS PANEL</div>
      {["claude", "llama"].map(p => (
        <button key={p} onClick={() => toggle(p)} style={{
          marginRight: 10, padding: "6px 14px", borderRadius: 6, border: "none", cursor: "pointer",
          background: killed[p] ? "#7f1d1d" : "#1f2937", color: killed[p] ? "#fca5a5" : "#9ca3af", fontSize: 12,
        }}>
          {killed[p] ? `✕ ${p} killed` : `kill ${p}`}
        </button>
      ))}
    </div>
  );
}
