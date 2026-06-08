"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { startScenario } from "../lib/api";
import { ChaosPanel } from "../components/ChaosPanel";

interface Scenario { id: string; title: string; blurb: string; }
interface Incident { id: string; done: boolean; disposition: string; stepCount: number; scenario: string | null; startedAt: number; }

export function DashboardClient({ incidents, scenarios }: { incidents: Incident[]; scenarios: Scenario[] }) {
  const router = useRouter();
  const [loading, setLoading] = useState<string | null>(null);

  async function launch(scenarioId: string) {
    setLoading(scenarioId);
    try {
      const { id } = await startScenario(scenarioId);
      router.push(`/incident/${id}`);
    } finally {
      setLoading(null);
    }
  }

  const dc = (d: string) => d === "resolved" ? "#22c55e" : d === "degraded" ? "#f59e0b" : d === "inconclusive" ? "#ef4444" : "#6b7280";

  return (
    <div style={{ padding: 24, maxWidth: 900, margin: "0 auto", fontFamily: "monospace" }}>
      <ChaosPanel />

      <h3 style={{ color: "#9ca3af", marginBottom: 12 }}>Scenarios</h3>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 10, marginBottom: 32 }}>
        {scenarios.map((s) => (
          <button key={s.id} onClick={() => launch(s.id)} disabled={loading === s.id}
            style={{ background: "#111827", border: "1px solid #374151", borderRadius: 8, padding: 14, cursor: "pointer", textAlign: "left", color: "#e2e8f0" }}>
            <div style={{ color: "#a78bfa", fontWeight: 700, marginBottom: 4 }}>{s.title}</div>
            <div style={{ color: "#6b7280", fontSize: 11 }}>{s.blurb}</div>
            {loading === s.id && <div style={{ color: "#f59e0b", marginTop: 6, fontSize: 11 }}>injecting fault…</div>}
          </button>
        ))}
      </div>

      <h3 style={{ color: "#9ca3af", marginBottom: 12 }}>Recent Investigations</h3>
      {incidents.length === 0 && <p style={{ color: "#4b5563" }}>No investigations yet. Launch a scenario above.</p>}
      {incidents.map((inc) => (
        <a key={inc.id} href={`/incident/${inc.id}`}
          style={{ display: "block", background: "#111827", border: "1px solid #1f2937", borderRadius: 8, padding: 12, marginBottom: 8, textDecoration: "none" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ color: "#e2e8f0", fontSize: 13 }}>{inc.id}</span>
            <span style={{ color: dc(inc.disposition), fontSize: 12, fontWeight: 700 }}>{inc.disposition.toUpperCase()}</span>
          </div>
          <div style={{ color: "#4b5563", fontSize: 11, marginTop: 4 }}>{inc.stepCount} steps · {inc.scenario ?? "manual"}</div>
        </a>
      ))}
    </div>
  );
}
