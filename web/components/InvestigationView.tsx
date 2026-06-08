"use client";
import { useEffect, useRef, useState } from "react";
import { sseUrl } from "../lib/api";

interface Evt { type: string; data: Record<string, unknown>; }

export function InvestigationView({ incidentId }: { incidentId: string }) {
  const [events, setEvents] = useState<Evt[]>([]);
  const [report, setReport] = useState<string | null>(null);
  const [disposition, setDisposition] = useState<string | null>(null);
  const [failover, setFailover] = useState<string | null>(null);
  const [flagged, setFlagged] = useState<string | null>(null);
  const [resolvedModel, setResolvedModel] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const es = new EventSource(sseUrl(incidentId));
    const on = (type: string) => (e: MessageEvent) => {
      const data = JSON.parse(e.data as string) as Record<string, unknown>;
      setEvents(p => [...p, { type, data }]);
      if (type === "incident_done") { setReport(String(data.report_md ?? "")); setDisposition(String(data.disposition ?? "")); }
      if (type === "failover") setFailover(`${data.from} → ${data.to}`);
      if (type === "divergence" && data.flagged) setFlagged(String(data.summary ?? ""));
      if (type === "primary_step" && data.resolvedModel) setResolvedModel(String(data.resolvedModel));
    };
    ["step_start","primary_step","shadow_step","tool_call","tool_result","divergence","failover","provider_state","incident_done"]
      .forEach(t => es.addEventListener(t, on(t)));
    return () => es.close();
  }, [incidentId]);

  useEffect(() => { bottom.current?.scrollIntoView({ behavior: "smooth" }); }, [events]);

  const dc = disposition === "resolved" ? "#22c55e" : disposition === "degraded" ? "#f59e0b" : "#ef4444";

  return (
    <div style={{ fontFamily: "monospace", padding: 24, maxWidth: 860, margin: "0 auto", color: "#e2e8f0" }}>
      <h2 style={{ color: "#a78bfa", marginBottom: 4 }}>⬡ Cannon — {incidentId}</h2>
      {resolvedModel && <p style={{ color: "#4b5563", fontSize: 11, margin: "0 0 12px" }}>via {resolvedModel}</p>}
      {failover && <Banner color="#7c2d12" text={`⚡ Failover: ${failover}`} />}
      {flagged  && <Banner color="#1e1b4b" text={`🔀 Divergence: ${flagged}`} />}

      <div style={{ background: "#0d1117", borderRadius: 8, padding: 14, height: 360, overflowY: "auto", marginBottom: 16, fontSize: 12 }}>
        {events.map((e, i) => <Row key={i} e={e} />)}
        <div ref={bottom} />
      </div>

      {disposition && (
        <div style={{ border: `2px solid ${dc}`, borderRadius: 8, padding: 16, background: "#0f172a" }}>
          <div style={{ color: dc, fontWeight: 700, marginBottom: 10 }}>DISPOSITION: {disposition.toUpperCase()}</div>
          <pre style={{ whiteSpace: "pre-wrap", fontSize: 13, margin: 0 }}>{report}</pre>
        </div>
      )}
    </div>
  );
}

function Banner({ color, text }: { color: string; text: string }) {
  return <div style={{ background: color, padding: "7px 12px", borderRadius: 6, marginBottom: 10, fontSize: 12 }}>{text}</div>;
}

const COLORS: Record<string, string> = {
  step_start:"#4b5563", primary_step:"#3b82f6", shadow_step:"#8b5cf6",
  tool_call:"#f59e0b", tool_result:"#10b981", failover:"#ef4444",
  divergence:"#a78bfa", incident_done:"#22c55e", provider_state:"#f97316",
};

function Row({ e }: { e: Evt }) {
  const color = COLORS[e.type] ?? "#6b7280";
  let preview = "";
  if (e.type === "tool_call") preview = `${e.data.tool}(${JSON.stringify(e.data.args).slice(0,80)})`;
  else if (e.type === "tool_result") preview = `status=${e.data.status}`;
  else if (e.type === "primary_step") preview = String(e.data.text ?? "").slice(0, 120) + "…";
  else if (e.type === "divergence") preview = String(e.data.summary ?? "");
  else if (e.type === "failover") preview = `${e.data.from} → ${e.data.to}`;
  return <div style={{ color, marginBottom: 3 }}><span style={{ opacity: 0.5 }}>[{e.type}]</span> {preview}</div>;
}
