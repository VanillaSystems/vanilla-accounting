/**
 * The short title a receipt list shows (the mockup's rows: «Coop Pronto Benzin»): the vendor as
 * people say it and what it is in 1–3 words. A receipt the inbox reads gets it with its other
 * facts (match.ts); this step gives it to receipts read before, 100 to one model call. A title is
 * shown, never booked, so a receipt of a filed quarter gets one too.
 */
import { parseTitle, TITLE_RULES } from '../llm/prompts.js';
import type { Receipt } from '../types/index.js';
import type { IntakeNote, StepRun } from './pipeline.js';

const BATCH = 100;

/** What the model sees of a receipt: enough to name it, little enough for 100 in one call. */
const item = (r: Receipt) => ({ id: r.id, file: r.filename, ...(r.description ? { description: r.description.slice(0, 200) } : {}), ...(r.amount !== undefined ? { amount: `${r.currency ?? ''} ${r.amount}`.trim() } : {}), ...(!r.description ? { text: r.extractedText.slice(0, 300) } : {}) });

export function titlesPrompt(receipts: Receipt[]): string {
  return `You name receipts for a minimalist Swiss bookkeeping UI. For each item return a short title in ${TITLE_RULES}
Return ONLY a JSON object {"<id>": {"v": "...", "w": "..."}, ...} covering every id, nothing else.
Items:
${JSON.stringify(receipts.map(item))}`;
}

export function titlesStep({ force = false } = {}): StepRun {
  return async ({ books, ask, progress, log }) => {
    const todo = books.read().receipts.filter((r) => force || !r.title);
    if (!todo.length) { log('Every receipt has its title.'); return { notes: [] }; }
    if (!ask) return { notes: [{ code: 'noModel', waiting: todo.length }] };
    const notes: IntakeNote[] = [];
    let done = 0, failed = 0, firstError = '';
    for (let i = 0; i < todo.length; i += BATCH) {
      const batch = todo.slice(i, i + BATCH);
      try {
        const raw = await ask(titlesPrompt(batch), { step: 'receipt-intake.guide.yaml#titles', model: 'haiku', timeoutMs: 180_000 });
        const json = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)) as Record<string, unknown>;
        const titles = new Map(batch.flatMap((r) => { const t = parseTitle(json[r.id]); return t ? [[r.id, t] as const] : []; }));
        books.update((b) => { for (const r of b.receipts) { const t = titles.get(r.id); if (t) r.title = t; } });
        failed += batch.length - titles.size;
      } catch (e) {
        failed += batch.length;
        firstError ||= String(e instanceof Error ? e.message : e);
      }
      done += batch.length;
      progress(done, todo.length);
      log(`  ${done}/${todo.length}`);
    }
    if (failed) notes.push({ code: 'failed', count: failed, detail: firstError.slice(0, 300) || 'no title in the answer' });
    return { notes };
  };
}
