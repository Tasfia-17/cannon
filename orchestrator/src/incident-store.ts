import fs from "node:fs";
import path from "node:path";

const DATA_DIR = process.env.INCIDENTS_DIR ?? path.join(process.cwd(), "data/incidents");

export interface PersistedIncident {
  id: string;
  events: unknown[];
  done: boolean;
  startedAt: number;
  endedAt?: number;
  scenario?: string;
}

fs.mkdirSync(DATA_DIR, { recursive: true });

export async function saveIncident(p: PersistedIncident): Promise<void> {
  const file = path.join(DATA_DIR, `${p.id}.json`);
  await fs.promises.writeFile(file, JSON.stringify(p, null, 2));
}

export function loadAllIncidents(): PersistedIncident[] {
  try {
    return fs.readdirSync(DATA_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), "utf8")) as PersistedIncident);
  } catch { return []; }
}
