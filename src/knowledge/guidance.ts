/**
 * What the model reads of the knowledge when it books a payment (AGENTS.md: "read only the step's
 * section in both layers and its own business's section"). The app layer's step sections are
 * the classify prompt's own instructions already; the company's layer (knowledge/rules/booking.guide.yaml)
 * and the payment's business file add decisions only a person made: precedents («anything for
 * the old van is private») and rules in words. They name an item, so they reach the model with
 * the linked receipt that names it, whatever the bank text says.
 *
 * A rule with a `then` map is carried out by code (src/booking/rules.ts), never shown here.
 */
import { basename } from 'node:path';
import type { Counterparty } from './counterparties.js';
import type { Knowledge, Section } from './layers.js';

/** The booking guide's steps whose decisions the model makes in one answer: the accounts, the VAT, a private share. */
export const CLASSIFY_STEPS = ['classify', 'split', 'side', 'purchase_vat', 'sale_vat', 'private', 'eigenverbrauch'] as const;
const GUIDE = 'booking.guide.yaml';

/** One decision as the prompt shows it: the step it belongs to, its id, and its words. */
export interface Guidance { step: string; id?: string; text: string }

const words = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** Pure. A section's precedents and its rules in words, in file order. */
export function guidanceOf(step: string, section: Section | undefined): Guidance[] {
  if (!section) return [];
  const out: Guidance[] = [];
  for (const r of section.rules ?? []) {
    const then = words(r.then);
    if (!then || (r as { off?: unknown }).off === true) continue;
    out.push({ step, ...(r.id ? { id: r.id } : {}), text: words(r.when) ? `when ${words(r.when)}: ${then}` : then });
  }
  for (const p of section.precedents ?? []) {
    if (typeof p === 'string' && p.trim()) { out.push({ step, text: p.trim() }); continue; }
    const o = (p ?? {}) as Record<string, unknown>;
    const [item, decision] = [words(o.item) ?? words(o.when), words(o.decision) ?? words(o.then)];
    if (decision) out.push({ step, ...(words(o.id) ? { id: words(o.id) } : {}), text: item ? `${item}: ${decision}` : decision });
  }
  return out;
}

/** The company's decisions of the booking steps (knowledge/rules/booking.guide.yaml). */
export function companyGuidance(k: Pick<Knowledge, 'guides'>): Guidance[] {
  const file = k.guides.find((g) => g.layer === 'workspace' && basename(g.path) === GUIDE);
  return CLASSIFY_STEPS.flatMap((step) => guidanceOf(step, file?.body.steps?.[step]));
}

/** One business's decisions of the booking steps, both layers (its file's `steps: booking.guide.yaml#<step>`). */
export function businessGuidance(cp: Pick<Counterparty, 'steps'>): Guidance[] {
  return CLASSIFY_STEPS.flatMap((step) => guidanceOf(step, cp.steps[`${GUIDE}#${step}`] as Section | undefined));
}

export const formatGuidance = (g: Guidance): string => `- [${g.step}${g.id ? ` ${g.id}` : ''}] ${g.text}`;
