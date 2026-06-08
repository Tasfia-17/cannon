import type { AgentStep, DivergenceScore } from "./types.js";

const W_ACTION = 0.30;
const W_RATIONALE = 0.70;
const FLAG_THRESHOLD = 0.35;

const STOPWORDS = new Set(["the","and","for","with","that","this","from","are","was","will","have","has"]);

export function compareSteps(step: number, primary: AgentStep, shadow: AgentStep): DivergenceScore {
  const actionMatch = primary.action === shadow.action;
  const rationaleCosine = jaccardCosine(primary.rationale, shadow.rationale);
  const agreement = W_ACTION * (actionMatch ? 1 : 0) + W_RATIONALE * rationaleCosine;
  return {
    step, cosine: rationaleCosine, actionMismatch: !actionMatch, agreement,
    flagged: agreement < FLAG_THRESHOLD,
    summary: !actionMatch
      ? `shadow chose ${shadow.action} vs primary ${primary.action}`
      : rationaleCosine < 0.4 ? `divergent rationale (cosine=${rationaleCosine.toFixed(2)})` : "agreement",
  };
}

function jaccardCosine(a: string, b: string): number {
  const ta = new Set(tokens(a)), tb = new Set(tokens(b));
  if (ta.size === 0 && tb.size === 0) return 1;
  const inter = [...ta].filter((t) => tb.has(t)).length;
  const denom = Math.sqrt(ta.size * tb.size);
  return denom === 0 ? 0 : inter / denom;
}

function tokens(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !STOPWORDS.has(w));
}
