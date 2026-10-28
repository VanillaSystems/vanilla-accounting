/**
 * Geschäftspartner and Wissen over HTTP (docs/0.4.0/knowledge.md, src/knowledge/partners.ts,
 * src/knowledge/notes.ts, src/knowledge/wissen.ts):
 *
 *   GET  /api/partners                the partners and what the open year's books hold for each
 *   GET  /api/partners/:id            one partner's page: its notes, how it is recognised, its files, its open questions
 *   GET  /api/knowledge               the topics of Arbeitsweise
 *   GET  /api/knowledge/topics/:slug  one topic's notes
 *   GET  /api/knowledge/gaps          Lücken: who decided the open year's bookings, payments of no partner, open questions
 *   GET  /api/knowledge/app           Von der App: the public layer, read only
 *   POST /api/notes                   { kind: save, ref, text, basis, title? } | { kind: restore, ref, text, now } → a NoteWrite
 *   POST /api/partners/:id/learned-names/remove  { name } → the learned merchant name out of the partner's company file, for good (#190)
 *
 * Notes are the company's customizing, not its books: no period lock, but the read-only mode refuses
 * the write (src/server/api.ts). A save is the person's own and is saved at once, as a kept rule is.
 */
import { Router } from 'express';
import { RequestError, WS, readBooks } from '../books.js';
import { loadKnowledge } from '../../knowledge/layers.js';
import { knowledgeGaps } from '../../knowledge/gaps.js';
import { lastChange, listTopics, partnerNoteFiles, readNote, restoreNote, saveNote, isPartnerId, isTopicSlug, topicSlugOf, topicTaken, type NoteRef, type NoteWrite } from '../../knowledge/notes.js';
import { partnerDetailOf, partnersOf, refsOf, type PartnerDetail, type PartnersView } from '../../knowledge/partners.js';
import { appLayerOf, decidedShares, openByPartner, type AppLayerView, type GapsView } from '../../knowledge/wissen.js';
import { companyRules } from '../../booking/rule-book.js';
import { commit, ruleFactsOf } from '../../saving/rules.js';
import { loadInvoices } from '../../invoices/store.js';
import { readQuestions } from '../../questions/store.js';
import { booksOpenPeriod, localToday } from '../../accounting/periods.js';
import { filing } from '../../engines/index.js';
import { APP_ROOT } from '../../workspace/workspace.js';
import { askRuns } from '../../workflows/held.js';
import { engine } from './automation.js';
import { keepingSwitchedOn } from './rules.js';
import { removeLearnedName } from '../../knowledge/learned-names.js';

export const router = Router();

const openYear = () => booksOpenPeriod(readBooks(), localToday(), filing().length).from.slice(0, 4);

/** The partners as Geschäftspartner lists them; the setup's partner card sorts them too (src/server/routes/onboarding.ts). */
export function partnersNow() {
  const knowledge = loadKnowledge(APP_ROOT, WS.paths.root);
  const books = readBooks();
  const questions = readQuestions(WS);
  const view = partnersOf({
    year: openYear(),
    counterparties: knowledge.counterparties,
    noted: new Map(partnerNoteFiles(WS).map((f) => [f.id, f.role])),
    books,
    invoices: loadInvoices(WS),
    questions,
    rules: companyRules(WS, ruleFactsOf(WS)),
  });
  return { view, knowledge, questions, books };
}

router.get('/api/partners', (_req, res) => { res.json(partnersNow().view satisfies PartnersView); });

router.get('/api/partners/:id', async (req, res) => {
  const { view, knowledge, questions } = partnersNow();
  const row = view.partners.find((p) => p.id === req.params.id);
  if (!row) throw new RequestError(404, `Den Geschäftspartner ${req.params.id} gibt es nicht.`, { code: 'partnerGone' });
  const cp = knowledge.counterparties.find((c) => c.id === row.id);
  const note = readNote(WS, { kind: 'partner', role: row.role, id: row.id });
  const last = note ? await lastChange(WS, note.path) : undefined;
  res.json({
    year: view.year,
    ...partnerDetailOf(row, cp, knowledge.counterpartyFiles, questions, refsOf(row)),
    ...(note ? { note: { ...note, ...(last ? { last } : {}) } } : {}),
  } satisfies PartnerDetail);
});

/** A person takes a learned merchant name out of the partner's company file: saved at once, as notes are; the file keeps it in `learnedTx`, so it is not learned again. */
router.post('/api/partners/:id/learned-names/remove', async (req, res) => {
  const name = (req.body as { name?: unknown } | undefined)?.name;
  if (typeof name !== 'string' || !name.trim()) throw new RequestError(400, 'name erwartet.');
  const cp = loadKnowledge(APP_ROOT, WS.paths.root).counterparties.find((c) => c.id === req.params.id);
  if (!cp) throw new RequestError(404, `Den Geschäftspartner ${req.params.id} gibt es nicht.`, { code: 'partnerGone' });
  const out = await keepingSwitchedOn(async () => {
    const path = removeLearnedName(WS, cp, name);
    return path && { path, committed: await commit(WS, `Gelernter Name entfernt: ${cp.id}`, path) };
  });
  if (!out) throw new RequestError(409, 'Diesen gelernten Namen hält die Datei nicht mehr.', { code: 'learnedNameGone' });
  res.json(out);
});

router.get('/api/knowledge', (_req, res) => { res.json({ topics: listTopics(WS) }); });

router.get('/api/knowledge/topics/:slug', async (req, res) => {
  const slug = req.params.slug;
  const note = isTopicSlug(slug) ? readNote(WS, { kind: 'topic', slug }) : undefined;
  if (!note) throw new RequestError(404, `Die Seite ${slug} gibt es nicht.`, { code: 'topicGone' });
  const last = await lastChange(WS, note.path);
  res.json({ slug, note: { ...note, ...(last ? { last } : {}) } });
});

router.get('/api/knowledge/gaps', (_req, res) => {
  const { view, knowledge, books, questions } = partnersNow();
  const txs = books.transactions.filter((tx) => tx.date.startsWith(view.year));
  const unrouted = knowledgeGaps(txs, books, knowledge.counterparties);
  const dateOf = new Map(txs.map((tx) => [tx.ref, tx.date]));
  const asked = new Set(askRuns(engine()).filter((r) => r.state.status === 'waiting').map((r) => r.item.id)).size;
  res.json({
    year: view.year,
    ...decidedShares(books, view.year),
    unrouted: unrouted.slice(0, 12).map((g) => ({ ...g, date: dateOf.get(g.example) ?? '' })),
    unroutedTotal: unrouted.reduce((n, g) => n + g.count, 0),
    open: openByPartner(view.partners, questions.filter((q) => q.status === 'open').length),
    asked,
  } satisfies GapsView);
});

router.get('/api/knowledge/app', (_req, res) => {
  const { view, knowledge } = partnersNow();
  res.json(appLayerOf(knowledge, new Set(view.partners.map((p) => p.id))) satisfies AppLayerView);
});

/** The file a notes command names, checked at the boundary: a partner the workspace knows (in the folder of its role), or a topic. */
function refOf(raw: unknown): NoteRef {
  const r = (raw ?? {}) as { kind?: unknown; id?: unknown; slug?: unknown };
  if (r.kind === 'topic' && isTopicSlug(r.slug)) return { kind: 'topic', slug: r.slug };
  if (r.kind !== 'partner' || !isPartnerId(r.id)) throw new RequestError(400, 'ref: { kind: partner, id } oder { kind: topic, slug } erwartet.');
  const row = partnersNow().view.partners.find((p) => p.id === r.id);
  if (!row) throw new RequestError(404, `Den Geschäftspartner ${r.id} gibt es nicht.`, { code: 'partnerGone' });
  return { kind: 'partner', role: row.role, id: row.id };
}

const nullableText = (v: unknown): v is string | null => v === null || typeof v === 'string';
const words = (ref: NoteRef, w: NoteWrite) => `${w.after === null ? 'Notizen entfernt' : w.before === null ? 'Neue Notizen' : 'Notizen geändert'}: ${ref.kind === 'partner' ? ref.id : ref.slug}`;

router.post('/api/notes', async (req, res) => {
  const b = (req.body ?? {}) as { kind?: unknown; ref?: unknown; text?: unknown; basis?: unknown; title?: unknown; now?: unknown; new?: unknown };
  const raw = b.ref as { kind?: unknown; slug?: unknown; title?: unknown } | undefined;
  // «Neue Seite»: the slug comes from the title, never one taken.
  const ref = b.kind === 'save' && raw?.kind === 'topic' && raw.slug === undefined && typeof b.title === 'string' && b.title.trim()
    ? { kind: 'topic' as const, slug: topicSlugOf(b.title, topicTaken(WS)) }
    : refOf(b.ref);
  if (b.kind === 'save') {
    if (typeof b.text !== 'string' || typeof b.basis !== 'string' || (b.title !== undefined && typeof b.title !== 'string')) throw new RequestError(400, 'text und basis erwartet.');
    const out = await keepingSwitchedOn(async () => {
      const s = saveNote(WS, ref, b.text as string, b.basis as string, b.title as string | undefined);
      return s.ok ? { ...s, committed: await commit(WS, words(ref, s.write), s.write.path) } : s;
    });
    if (!out.ok) throw out.refusal === 'changed'
      ? new RequestError(409, 'Die Notizen wurden seither geändert. Lade die Seite neu.', { code: 'notesChanged' })
      : new RequestError(400, 'Eine Seite braucht einen Titel.', { code: 'notesTitle' });
    res.json({ ...out.write, ref, committed: out.committed });
    return;
  }
  if (b.kind === 'restore' && nullableText(b.text) && nullableText(b.now)) {
    const out = await keepingSwitchedOn(async () => {
      const w = restoreNote(WS, ref, b.text as string | null, b.now as string | null);
      return w && { ...w, committed: await commit(WS, `Notizen zurückgenommen: ${ref.kind === 'partner' ? ref.id : ref.slug}`, w.path) };
    });
    if (!out) throw new RequestError(409, 'Die Notizen wurden seither geändert: nichts zurückgenommen.', { code: 'notesChanged' });
    res.json({ ...out, ref });
    return;
  }
  throw new RequestError(400, 'Unbekannter Befehl.');
});
