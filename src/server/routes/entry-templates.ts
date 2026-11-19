/**
 * Named entry templates (#567, src/workspace/entry-templates.ts): listed, kept, removed. They hold
 * no dated record and write no books: a template only starts the hand form, which books through the
 * write door like any other entry.
 */
import { Router } from 'express';
import { patchBody, stringField, tagsField, RequestError, WS } from '../books.js';
import { MAX_TEMPLATES, deleteTemplate, readTemplates, replacedBy, saveTemplate, type EntryTemplate, type TemplateLine } from '../../workspace/entry-templates.js';

export const router = Router();

const text = (b: Record<string, unknown>, k: string) => (b[k] === undefined ? '' : stringField(b, k).trim());
const amountOf = (b: Record<string, unknown>): number | undefined => {
  if (b.amount === undefined || b.amount === null) return undefined;
  if (typeof b.amount !== 'number' || !Number.isFinite(b.amount)) throw new RequestError(400, 'amount muss eine Zahl sein.');
  return b.amount || undefined;
};

function lineOf(raw: unknown): TemplateLine {
  const b = patchBody(raw, ['account', 'amount', 'vatCode', 'description']);
  const amount = amountOf(b);
  const vatCode = text(b, 'vatCode');
  const description = text(b, 'description');
  return { account: text(b, 'account'), ...(amount !== undefined && { amount }), ...(vatCode && { vatCode }), ...(description && { description }) };
}

function templateOf(raw: unknown): Omit<EntryTemplate, 'id'> & { id?: string } {
  const b = patchBody(raw, ['id', 'name', 'accountDebit', 'accountCredit', 'amount', 'vatCode', 'description', 'tags', 'split']);
  const amount = amountOf(b);
  const vatCode = text(b, 'vatCode');
  const description = text(b, 'description');
  const tags = tagsField(b.tags);
  const id = text(b, 'id');
  let split: EntryTemplate['split'];
  if (b.split !== undefined && b.split !== null) {
    const s = patchBody(b.split, ['side', 'lines']);
    if (s.side !== 'accountDebit' && s.side !== 'accountCredit') throw new RequestError(400, 'split.side: accountDebit oder accountCredit.');
    if (!Array.isArray(s.lines) || !s.lines.length) throw new RequestError(400, 'split.lines: eine Liste von Zeilen.');
    split = { side: s.side, lines: s.lines.map(lineOf) };
  }
  return {
    ...(id && { id }), name: text(b, 'name'), accountDebit: text(b, 'accountDebit'), accountCredit: text(b, 'accountCredit'),
    ...(amount !== undefined && { amount }), ...(vatCode && { vatCode }), ...(description && { description }), ...(tags && { tags }), ...(split && { split }),
  };
}

router.get('/api/entry-templates', (_req, res) => {
  res.json({ templates: readTemplates(WS), max: MAX_TEMPLATES });
});

/** Keeps a template; one of the same name is replaced (answered as `replaced`, for the undo). */
router.post('/api/entry-templates', (req, res) => {
  const t = templateOf(req.body);
  const replaced = replacedBy(readTemplates(WS), t);
  const kept = saveTemplate(WS, t);
  if (kept === 'noName') throw new RequestError(400, 'Die Vorlage braucht einen Namen.', { code: 'templateName' });
  if (kept === 'limit') throw new RequestError(400, `Höchstens ${MAX_TEMPLATES} Vorlagen: zuerst eine löschen.`, { code: 'templateLimit', params: { max: MAX_TEMPLATES } });
  res.json({ template: kept, ...(replaced && { replaced }) });
});

router.delete('/api/entry-templates/:id', (req, res) => {
  const gone = deleteTemplate(WS, req.params.id);
  if (!gone) throw new RequestError(404, 'Diese Vorlage gibt es nicht mehr.', { code: 'gone', params: { what: 'template' } });
  res.json({ template: gone });
});
