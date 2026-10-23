/**
 * The setup over HTTP (src/onboarding/, docs/0.4.0/onboarding.md): the checklist, the person's
 * answers to the conversation's questions, and what the app knows that its cards show. The AI marks
 * topics and answers questions through its block (`setupTopic`, `setupAnswer`); these routes are
 * the person's: a click on an answer, «Übernehmen» of a VAT change once the Firma page's own
 * PATCH /api/workspace saved it.
 *
 *   GET  /api/onboarding                     the checklist, the facts, and whether this is an empty workspace's first start
 *   POST /api/onboarding/start               the setup opened (the first start does not open it again)
 *   PUT  /api/onboarding/topics/:topic       { state: open | done | skipped }
 *   PUT  /api/onboarding/answers/:question   { value: <one of its answers> | null, kept?: <the VAT setup before> | null }
 */
import { Router } from 'express';
import { RequestError, WS, patchBody, readBooks } from '../books.js';
import { QUESTIONS, SETUP_TOPICS, TOPIC_STATES, isAnswerOf, isQuestion, isSetupTopic, isTopicState, type Answer } from '../../onboarding/model.js';
import { answerQuestion, markTopic, readProgress, setupView, startSetup } from '../../onboarding/store.js';
import { partnerBins, type SetupFacts, type SetupView } from '../../onboarding/facts.js';
import { topicStates } from '../../onboarding/conversation.js';
import { parseVatSetup, type VatSetup } from '../../workspace/vat-setup.js';
import { booksOpenPeriod, localToday } from '../../accounting/periods.js';
import { filing, setup } from '../../engines/index.js';
import { accountsOf } from '../../workspace/reads.js';
import { sources } from '../../platform/sources/index.js';
import { APP_ROOT } from '../../workspace/workspace.js';
import { partnersNow } from './knowledge.js';

export const router = Router();

/** What the app knows that the setup conversation's cards show: read fresh, so a bank account saved by hand shows at once. */
export function setupFacts(): SetupFacts {
  const books = readBooks();
  const today = localToday();
  const year = booksOpenPeriod(books, today, filing().length).from.slice(0, 4);
  const chart = new Map((accountsOf(WS) as Array<{ number?: unknown; name?: unknown }>).map((a) => [String(a.number), String(a.name ?? '')]));
  const banks = WS.bankAccounts.filter((b) => b.role !== 'owner');
  const { view, books: partnerBooks } = partnersNow();
  const c = WS.company;
  return {
    today, year,
    company: { name: c.name, uid: c.uid, owner: c.owner, vat: c.vat, ...(c.legalForm ? { legalForm: c.legalForm } : {}), ...(c.address ? { address: c.address } : {}) },
    banks: banks.map((b) => ({ label: b.label, bank: b.bank, currency: b.currency, account: b.account, ...(b.iban ? { iban: b.iban } : {}) })),
    sources: sources(WS, APP_ROOT).flatMap((v) => (v.kind === 'ready' ? [{ id: v.decl.id, label: v.decl.label }] : [])),
    opening: Object.entries(books.config.openingBalances?.[year] ?? {}).map(([account, amount]) => ({ account, name: chart.get(account) ?? '', amount })).sort((a, b) => a.account.localeCompare(b.account)),
    ...(books.config.closedThrough ? { closedThrough: books.config.closedThrough } : {}),
    books: { payments: books.transactions.length, receipts: books.receipts.length, entries: (books.journalEntries ?? []).length },
    partners: partnerBins({ partners: view.partners, entries: partnerBooks.journalEntries ?? [], bankAccounts: new Set(WS.bankAccounts.map((b) => b.account)), accountName: (n) => chart.get(n) ?? '' }),
    rules: view.partners.reduce((n, p) => n + p.rules, 0),
    ...(WS.profile ? { sells: { kinds: WS.profile.sells, accounts: setup().sells } } : {}),
  };
}

/** In read-only mode (an auditor's copy) the setup never opens by itself. */
function view(): SetupView {
  const v = setupView(WS, readBooks());
  const facts = setupFacts();
  return { ...v, facts, states: topicStates(v.progress, facts), ...(process.env.READONLY === '1' ? { firstStart: false } : {}) };
}

router.get('/api/onboarding', (_req, res) => {
  res.json(view());
});

router.post('/api/onboarding/start', (_req, res) => {
  startSetup(WS, new Date().toISOString());
  res.json(view());
});

router.put('/api/onboarding/topics/:topic', (req, res) => {
  const topic = req.params.topic;
  if (!isSetupTopic(topic)) throw new RequestError(404, `Diesen Punkt der Einrichtung gibt es nicht: eines von ${SETUP_TOPICS.join(', ')}.`);
  const { state } = patchBody(req.body, ['state']);
  if (!isTopicState(state)) throw new RequestError(400, `state: eines von ${TOPIC_STATES.join(', ')}.`);
  markTopic(WS, topic, state, new Date().toISOString());
  res.json(view());
});

/**
 * A click on an answer, or `null` to take it back. `kept` belongs to the VAT question only: the
 * setup before the person's «Übernehmen» (after PATCH /api/workspace saved the new one), for the
 * card's «Rückgängig»; `null` once taken back. A new answer drops what the old one kept.
 */
router.put('/api/onboarding/answers/:question', (req, res) => {
  const q = req.params.question;
  if (!isQuestion(q)) throw new RequestError(404, `Diese Frage stellt die Einrichtung nicht: eine von ${Object.keys(QUESTIONS).join(', ')}.`);
  const b = patchBody(req.body, ['value', 'kept']);
  const now = new Date().toISOString();
  if (b.value === null) { answerQuestion(WS, q, undefined, now); res.json(view()); return; }
  if (!isAnswerOf(q, b.value)) throw new RequestError(400, `value: eine von ${QUESTIONS[q].join(', ')}.`);
  if (b.kept !== undefined && q !== 'vat') throw new RequestError(400, 'kept gilt nur für die Frage nach der Steuer (vat).');
  const was = readProgress(WS).answers[q] as Answer | undefined;
  const kept = b.kept === undefined ? (was?.value === b.value ? was.kept : undefined)
    : b.kept === null ? undefined
      : { before: parseVatSetup(b.kept, (msg) => { throw new RequestError(400, `kept: ${msg}`); }) satisfies VatSetup, at: now };
  answerQuestion(WS, q, { value: b.value, at: was?.value === b.value ? was.at : now, ...(kept ? { kept } : {}) } as Answer<typeof q>, now);
  res.json(view());
});
