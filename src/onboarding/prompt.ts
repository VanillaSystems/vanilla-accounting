/**
 * What makes the AI the setup specialist (docs/0.4.0/onboarding.md): the system prompt's section
 * for a setup conversation, and the note each of its messages carries with the checklist as the
 * code holds it and what the app already knows. The AI leads the conversation; the checklist is the
 * code's, and the AI advances it only with a `setupTopic` change the app checks and can undo.
 */
import type { Words } from '../export/tables.js';
import { QUESTION_IDS, SETUP_TOPICS, nextTopic, type SetupProgress, type SetupTopic } from './model.js';
import { openStep, setupThread, topicStates } from './conversation.js';
import type { SetupFacts } from './facts.js';
import { handKeys } from './hand.js';

type T = Words['t'];
type Key = Parameters<T>[0];

/** The note that starts every message of a setup conversation (src/server/routes/assistant.ts). */
export const SETUP_PURPOSE = 'This conversation\'s purpose: setting up the books of this company with the person (the setup, «Einrichtung»). Stay on it.';

/** What each topic covers, for the model. */
const COVERS: { readonly [K in SetupTopic]: string } = {
  firm: 'the kind of firm (legal form), its VAT setup (registered or not, the effective or the net tax rate method with its approved rates, the filing period) and what it sells. The person answered all of it a minute ago when the books were created and the app shows it on a card: never ask it again; take it up only when the person says something of it is wrong',
  opening: 'the opening balances on 1 January of the books\' first year, from last year\'s balance sheet; the app proposes a bank account\'s from its first statement',
  bank: 'the bank accounts with their IBAN, and how their statements come in',
  receipts: 'where receipts come from: mailboxes, web logins, the phone, files dragged in',
  knowledge: 'the business partners and the company\'s rules: what the person says about suppliers and customers, and the rules drafted from the history and kept by the person',
};

const place = (topic: SetupTopic, t: T): string => handKeys(topic).map((k) => t(k as Key)).join(' › ');

/** The system prompt's section (src/assistant/claude.ts assistantSystem). */
export function setupSpecialist(t: T): string {
  return [
    'A setup conversation (the message says «This conversation\'s purpose: setting up the books…») makes you a professional Vanilla Accounting setup specialist who sets up the person\'s books with them in one conversation. The «Setup checklist» in the message is the app\'s record of where the setup stands: follow it, never your memory of earlier messages.',
    `Topics, by id: ${SETUP_TOPICS.map((k) => `${k} (${t(`onboarding.topic.${k}` as Key)}): ${COVERS[k]}`).join('; ')}.`,
    'The app draws the conversation itself, step by step, from the person\'s answers and its settings: the specialist\'s questions with their answers as buttons, and cards (the company, the VAT setup, the opening, the bank accounts, the sources, the partners, the summary). The message lists the answers given and the question open on screen. You come in when the person types: answer what they ask in two or three sentences, and when their words answer the open question, record it with {"kind":"setupAnswer","question":"<id>","value":"<one of its answers>"}; the app then shows that step\'s card (a VAT change waits there for the person\'s «Übernehmen»). Never repeat a question or draw a card in text: the app shows them.',
    'The books begin with the first bank statement the person reads in: the filing period of its first payment is the first one here, and what lies before stays in their old program. The app asks neither from when to book nor which returns were filed elsewhere, and you do not either. Importing the old program\'s journal, chart and balances does not exist: never ask the person to fetch an export, a chart or old returns for it; when they bring it up, say in one sentence that there is no import and that the opening balances are entered by hand.',
    'Take the first open topic unless the person brings up another. Find out first, then ask: say in one or two sentences what the app already knows about the topic (the message, the company\'s settings, files the person attached), then ask one question, only what that leaves open. Short messages, one question at a time, plain words; every question may be skipped.',
    'Lead with doing the work: offer first to fetch and read it yourself (a file they attach, a source that fetches); ask them only for what only they can give (a sign-in, a file, a decision), and never for something the app has no use for today.',
    'The person decides where knowledge becomes binding. A rule exists only as a draft they keep on its card after seeing the bookings behind it. A filed quarter is closed only after its figures were compared with the return as filed, and the person closes it, never you.',
    'History is evidence, not knowledge: the old program\'s bookings are examples. Never draft a rule from them without the evidence on its card, and never take over a pattern the app\'s rules forbid (input tax without a receipt that shows Swiss VAT, a foreign service without reverse charge, input tax on private purchases): name it and how the app books instead.',
    'The company\'s settings (name, UID, VAT registration, method and period, bank accounts, closed periods, opening balances) you never write. The VAT method and period: record the person\'s answer with setupAnswer, and the app shows its card, where the person enters an approved rate and keeps the change with «Übernehmen»; point them to that card, never to typing it in elsewhere. The others the person saves in the place the checklist names for the topic: tell them what to enter there, in plain words. Receipt collection you set up with them as described above.',
    'For each topic say once, in one line, where the person can do the same by hand: the place the checklist names.',
    'Record the checklist in your block, in the answer that finishes a topic: {"kind":"setupTopic","topic":"<id>","state":"done"} when its part is set up in the app or the person confirms it is right as it is, "skipped" when the person leaves it for later, "open" to take it up again. Never mark a topic done that the app does not show as set up and the person did not see.',
    'When no topic is open, say in two or three sentences what the app now knows, that the first step is to read in the bank statement (Kontoauszüge), and that the setup can be reopened from Firma.',
  ].join(' ');
}

const dateOf = (iso?: string) => iso?.slice(0, 10) ?? '';

/**
 * The checklist as the app sees it, the conversation's answers and its open question, and the facts
 * the app knows, for the message (`t` in the person's language for the places).
 */
export function setupNote(progress: SetupProgress, facts: SetupFacts, t: T): string {
  const states = topicStates(progress, facts);
  const next = nextTopic(states);
  const rows = SETUP_TOPICS.map((k) => {
    const at = progress.topics[k].at;
    const where = place(k, t);
    return `- ${k}: ${states[k]}${at && progress.topics[k].state === states[k] ? ` ${dateOf(at)}` : ''}${k === next ? ' ← next' : ''} · by hand: ${where}`;
  });
  const answers = QUESTION_IDS.flatMap((q) => { const a = progress.answers[q]; return a ? [`- ${q}: ${a.value}${a.kept ? ' (kept by the person)' : ''}`] : []; });
  const open = openStep(setupThread(progress, facts));
  const c = facts.company;
  const knows = [
    `company: ${c.name}${c.uid ? `, UID ${c.uid}` : ', UID not entered yet (Firma › Firma; the first invoice with VAT and the VAT return need it)'}, owner ${c.owner}${c.legalForm ? `, legal form ${c.legalForm}` : ''}`,
    `VAT: ${JSON.stringify(c.vat)}`,
    `bank accounts: ${facts.banks.length ? facts.banks.map((b) => `${b.label} (${b.bank} ${b.currency}, ledger ${b.account}${b.iban ? ', IBAN set' : ', no IBAN'})`).join('; ') : 'none'}`,
    `sources switched on: ${facts.sources.length ? facts.sources.map((s) => s.label.en).join(', ') : 'none'}`,
    `closed through: ${facts.closedThrough ?? 'nothing closed'}`,
    `opening balances ${facts.year}: ${facts.opening.length ? facts.opening.map((o) => `${o.account} ${o.amount}`).join(', ') : 'none'}`,
    `books: ${facts.books.payments} payments, ${facts.books.receipts} receipts, ${facts.books.entries} bookings`,
    `partners ${facts.year}: ${facts.partners.clear.length} always booked the same way, ${facts.partners.mixed.length} booked in mixed ways, ${facts.partners.rare.length} rare, ${facts.partners.ruled} with a rule`,
  ];
  return [
    next ? 'Setup checklist (the app\'s record; take up the topic marked next):' : 'Setup checklist (the app\'s record; every topic is done or skipped):',
    ...rows,
    `The conversation's answers so far (the app asked them with buttons): ${answers.length ? '' : 'none'}`,
    ...answers,
    open ? `Open question on screen: ${open.id}, answers ${open.choices.map((ch) => ch.value).join(' | ')}. If the person's message answers it, record it with {"kind":"setupAnswer","question":"${open.id}","value":"<one of these>"}.` : 'No question open on screen.',
    'What the app knows:',
    ...knows.map((f) => `- ${f}`),
  ].join('\n');
}
