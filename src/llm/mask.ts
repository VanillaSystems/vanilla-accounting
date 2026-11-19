/**
 * What never reaches a model (docs/specs/payroll.md §11, #508): a social security number, found by the
 * jurisdiction's pattern (payroll.yaml `socialSecurityNumber`), is replaced before every prompt, system
 * text and judged state leaves the app. Without a jurisdiction loaded nothing is known to mask.
 */
import { payroll } from '../engines/index.js';

let cached: { source: string; re: RegExp; masked: string } | undefined;

function rule(): { re: RegExp; masked: string } | undefined {
  let p;
  try { p = payroll()?.socialSecurityNumber; } catch { return undefined; }
  if (!p?.pattern) return undefined;
  if (cached?.source !== p.pattern) cached = { source: p.pattern, re: new RegExp(p.pattern, 'g'), masked: p.masked };
  return cached;
}

/** `text` with every social security number masked. */
export function maskForModel(text: string): string {
  const r = rule();
  return r ? text.replace(r.re, r.masked) : text;
}

/** A judged state (text or a plain object) with every number masked in its strings. */
export function maskState<T extends string | Record<string, unknown>>(state: T): T {
  if (typeof state === 'string') return maskForModel(state) as T;
  return JSON.parse(JSON.stringify(state), (_k, v) => (typeof v === 'string' ? maskForModel(v) : v)) as T;
}
