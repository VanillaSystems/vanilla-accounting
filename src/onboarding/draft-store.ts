/**
 * The setup draft on disk (src/onboarding/draft.ts): DRAFT_FILE in the folder's vanilla-accounting/,
 * written whole and atomically after each answer, checked as createWorkspace checks it. Turned into
 * books by `createFromDraft`, which hands the draft's request to createWorkspace, the form's own
 * path, and removes the draft before the first commit, so the books never hold it.
 */
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { writeAtomic } from '../invoices/store.js';
import { SetupError, checkBank, checkPreset, createWorkspace, type Bank, type Created } from '../workspace/create.js';
import { PRESETS, QUESTIONS, VAT_QUESTIONS, optionOf, salesKinds, type QuestionKey } from '../workspace/setup.js';
import { parseNetRates } from '../workspace/vat-setup.js';
import { parseUid } from '../workspace/uid.js';
import { APP_FOLDER, APP_ROOT, appFolderIn, appLanguages, workspaceAt } from '../workspace/workspace.js';
import { loadJurisdiction } from '../core/modules/load.js';
import { DRAFT_FILE, assumedOf as assumedOfDraft, isStepMark, newDraft, requestOf, withPatch, type DraftPatch, type Firm, type SetupDraft, type SetupDraftView } from './draft.js';
import { seedCreated } from './store.js';
import { assumedOf as assumedFrom } from './model.js';

export const draftFile = (root: string): string => join(resolve(root), APP_FOLDER, DRAFT_FILE);

const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

function checkFirm(raw: unknown): Firm {
  const r = isMap(raw) ? raw : {};
  const name = text(r.name);
  const owner = text(r.owner);
  if (!name) throw new SetupError('The company name is needed.', { reason: 'required', field: 'name' });
  const uid = parseUid(text(r.uid));
  if ('error' in uid) throw new SetupError(uid.error, { reason: 'uid', detail: text(r.uid) });
  if (!owner) throw new SetupError('The owner is needed.', { reason: 'required', field: 'owner' });
  return { name, uid: uid.uid, owner };
}

/** What was said of a firm not whole yet: each field as text, the UID only when it is one. */
export function saidFirm(raw: Record<string, unknown>): Partial<Firm> {
  const uid = text(raw.uid) ? parseUid(text(raw.uid)) : undefined;
  return {
    ...(text(raw.name) ? { name: text(raw.name) } : {}),
    ...(uid && !('error' in uid) ? { uid: uid.uid } : {}),
    ...(text(raw.owner) ? { owner: text(raw.owner) } : {}),
  };
}

function checkAnswer(key: QuestionKey, raw: unknown): string | string[] {
  const multi = (QUESTIONS[key] as { multi?: boolean }).multi;
  const values = multi && Array.isArray(raw) ? raw : !multi && typeof raw === 'string' ? [raw] : undefined;
  const options = values?.map((v) => (typeof v === 'string' ? optionOf(key, v) : undefined));
  if (!values || !options || options.some((o) => !o)) throw new SetupError(`${QUESTIONS[key].ask}: an answer is needed.`, { reason: 'missing', question: key });
  const stop = options.find((o) => o!.unsupported);
  if (stop) throw new SetupError(stop.unsupported!, { reason: 'unsupported', question: key, value: stop.value });
  return multi ? (key === 'sells' ? salesKinds(values as string[]) : (values as string[])) : (values[0] as string);
}

/** One answer as the start screen sent it, checked as createWorkspace will check it; a SetupError names what is wrong. */
export function checkPatch(raw: unknown): DraftPatch {
  const r = isMap(raw) ? raw : {};
  const value = r.value;
  switch (r.step) {
    case 'firm': return { step: 'firm', value: value === null ? null : checkFirm(value) };
    case 'preset': return { step: 'preset', value: value === null ? null : checkPreset(String(value)) };
    case 'question': {
      const key = r.key as QuestionKey;
      if (typeof key !== 'string' || !Object.hasOwn(QUESTIONS, key)) throw new SetupError(`No question ${String(r.key)}.`, { reason: 'preset', detail: String(r.key) });
      return { step: 'question', key, value: value === null ? null : checkAnswer(key, value) };
    }
    case 'netRates': return {
      step: 'netRates',
      value: value === null ? null : [...parseNetRates(value, (msg) => { throw new SetupError(msg, { reason: 'netRates', detail: msg }); })],
    };
    case 'banks': {
      if (value === null) return { step: 'banks', value: null };
      const list = Array.isArray(value) ? value.filter(isMap) : [];
      if (list.some((b) => !text(b.bank))) throw new SetupError('A bank needs its name.', { reason: 'bankName' });
      const banks = list.reduce<Bank[]>((before, b) => [...before, checkBank({ bank: text(b.bank), currency: text(b.currency), account: text(b.account), iban: text(b.iban) }, before)], []);
      if (!banks.length) throw new SetupError('At least one bank account is needed.', { reason: 'noBank' });
      return { step: 'banks', value: banks };
    }
    default: throw new SetupError(`No setup step ${String(r.step)}.`, { reason: 'preset', detail: String(r.step) });
  }
}

/**
 * The draft as read from disk: each answer checked again and left out when it no longer passes (an
 * answer of an older version), so a draft always opens; undefined when the folder holds none.
 */
export function readDraft(root: string): SetupDraft | undefined {
  const file = draftFile(root);
  if (!existsSync(file)) return undefined;
  let raw: Record<string, unknown>;
  try { raw = JSON.parse(readFileSync(file, 'utf8')); } catch { raw = {}; }
  if (!isMap(raw)) raw = {};
  const language = appLanguages().includes(text(raw.language)) ? text(raw.language) : 'de';
  let draft = newDraft(language, typeof raw.started === 'string' ? raw.started : new Date().toISOString());
  const replay = (patch: unknown) => { try { draft = withPatch(draft, checkPatch(patch)); } catch { /* left out */ } };
  if (raw.firm) replay({ step: 'firm', value: raw.firm });
  const said = !draft.firm && isMap(raw.said) ? saidFirm(raw.said) : {};
  if (Object.keys(said).length) draft = { ...draft, said };
  // The answers before the preset: a preset fills only what it has, so the person's answers are not lost.
  const answers = isMap(raw.answers) ? raw.answers : {};
  if (raw.preset) draft = { ...draft, preset: raw.preset as SetupDraft['preset'] };
  try { if (draft.preset) checkPreset(draft.preset); } catch { delete draft.preset; }
  for (const [key, value] of Object.entries(answers)) replay({ step: 'question', key, value });
  if (raw.netRates) replay({ step: 'netRates', value: raw.netRates });
  if (raw.banks) replay({ step: 'banks', value: raw.banks });
  if (typeof raw.refusedPeriod === 'string' && draft.answers.period === undefined) draft = { ...draft, refusedPeriod: raw.refusedPeriod };
  const marks = Array.isArray(raw.fromText) ? raw.fromText.filter(isStepMark) : [];
  if (marks.length) draft = { ...draft, fromText: marks };
  // What the kind of firm assumed (#364); a draft of an earlier version names none: its answers equal to the preset's, not from her words.
  const given: Partial<Record<string, unknown>> = draft.preset && draft.preset !== 'custom' ? PRESETS[draft.preset].answers : {};
  const assumed = (Array.isArray(raw.assumed) ? raw.assumed : Object.keys(given).filter((k) => !VAT_QUESTIONS.includes(k as never) && !marks.includes(k as never) && JSON.stringify(given[k]) === JSON.stringify(draft.answers[k as QuestionKey])))
    .filter((k): k is QuestionKey => typeof k === 'string' && Object.hasOwn(QUESTIONS, k) && draft.answers[k as QuestionKey] !== undefined);
  const by = typeof raw.assumedBy === 'string' && raw.assumedBy !== 'custom' && Object.hasOwn(PRESETS, raw.assumedBy) ? raw.assumedBy as SetupDraft['assumedBy']
    : !Array.isArray(raw.assumed) && draft.preset && draft.preset !== 'custom' ? draft.preset : undefined;
  return assumed.length ? { ...draft, assumed, ...(by ? { assumedBy: by } : {}) } : draft;
}

/** The draft with what the start screen proposes from the jurisdiction new books get (src/workspace/scaffold.ts). */
export const draftView = (root: string, draft: SetupDraft): SetupDraftView =>
  ({ root, draft, baseCurrency: loadJurisdiction(APP_ROOT, 'ch').jurisdiction.manifest.baseCurrency });

/** The draft written whole, atomically. */
export const writeDraft = (root: string, d: SetupDraft): SetupDraft => { writeAtomic(draftFile(root), JSON.stringify({ schema: 1, ...d }, null, 2) + '\n'); return d; };

/** «Weiter» after the folder and the language: the draft in that folder, the one there already when the setup was broken off. */
export function beginDraft(root: string, language: string, now: string): SetupDraft {
  if (!appLanguages().includes(language)) throw new SetupError(`The language must be one of ${appLanguages().join(', ')}.`, { reason: 'language', detail: language });
  return readDraft(root) ?? writeDraft(root, newDraft(language, now));
}

export function patchDraft(root: string, raw: unknown): SetupDraft {
  const draft = readDraft(root);
  if (!draft) throw new SetupError('No setup in this folder.', { reason: 'required', field: 'root' });
  return writeDraft(root, withPatch(draft, checkPatch(raw)));
}

/**
 * «Buchhaltung anlegen»: the books, written by createWorkspace from the draft's request, marked as
 * created by the conversation (seedCreated), which goes on in them with what the settings do not answer.
 * A refusal leaves the draft as it was.
 */
export async function createFromDraft(root: string, now: string): Promise<Created> {
  const draft = readDraft(root);
  const request = draft && requestOf(draft);
  if (!draft || !request) throw new SetupError('The setup is not complete yet.', { reason: 'required', field: 'root' });
  // Books that came into the folder meanwhile are opened as they are: neither the draft nor their setup is touched.
  if (appFolderIn(resolve(root))) return createWorkspace({ root, ...request });
  rmSync(draftFile(root));
  let created: Created;
  try {
    created = await createWorkspace({ root, ...request });
  } catch (e) {
    writeDraft(root, draft);
    throw e;
  }
  // What the kind of firm answered and she never touched stays marked in the books (#385).
  const assumed = assumedFrom(assumedOfDraft(draft), draft.answers, draft.assumedBy);
  seedCreated(workspaceAt(created.root), { started: draft.started, ...(assumed ? { assumed } : {}) }, now);
  return created;
}
