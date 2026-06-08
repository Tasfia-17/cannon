const ORCH = process.env.NEXT_PUBLIC_ORCH_URL ?? "http://localhost:7200";

export async function getScenarios() {
  const r = await fetch(`${ORCH}/scenarios`);
  return (await r.json() as { scenarios: unknown[] }).scenarios;
}

export async function startScenario(scenario: string) {
  const r = await fetch(`${ORCH}/scenarios/${scenario}/start`, { method: "POST" });
  return r.json() as Promise<{ ok: boolean; id: string }>;
}

export async function getIncidents() {
  const r = await fetch(`${ORCH}/incidents`, { cache: "no-store" });
  return (await r.json() as { incidents: unknown[] }).incidents;
}

export async function killProvider(provider: string) {
  return fetch(`${ORCH}/chaos/kill-provider`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider }),
  });
}

export async function restoreProvider(provider: string) {
  return fetch(`${ORCH}/chaos/restore-provider`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider }),
  });
}

export function sseUrl(incidentId: string) {
  return `${ORCH}/incident/${incidentId}/stream`;
}
