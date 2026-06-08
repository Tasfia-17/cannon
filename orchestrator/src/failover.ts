import type { IncidentState, ProviderName } from "./types.js";
import type { ProviderRegistry } from "./providers.js";

export function promoteShadow(s: IncidentState): void {
  if (s.shadow === null) return;
  s.primary = s.shadow;
  s.shadow = null;
}

export function pickNewShadow(s: IncidentState, reg: ProviderRegistry): ProviderName | null {
  for (const candidate of reg.healthy()) {
    if (candidate !== s.primary) return candidate;
  }
  return null;
}
