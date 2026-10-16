/**
 * The AI sidebar's messages to the `claude` CLI (docs/0.4.0/views.md, "The AI, as a sidebar"):
 * an agent in the workspace with Claude Code's own tools, its session continued by every message
 * of a conversation (--resume), its answer streamed (stream-json). Unlike src/llm/ask.ts (one lean
 * call from an empty folder) it runs in the workspace.
 *
 * It does what the person asks, and knows the app it works in: the map of its places the route
 * gives (src/server/app-map.ts). A change
 * to the books, the chart, the invoicing settings or an invoice draft, and an export or a booking
 * run, it names in a ```vanilla-changes block at the end of its answer, which the app checks and
 * applies with an undo for each change (src/assistant/changes.ts, src/server/edits.ts,
 * src/server/workspace-edits.ts): its file tools never write them. What it
 * may write is set by its permissions, not by the prompt: no settings of the workspace or the
 * person are loaded (they could allow more), and Edit and Write reach only data/draft/ for the
 * customizing folders, which a person saves in Änderungen (docs/0.4.0/saving.md).
 */
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { APP_ROOT, type Workspace } from '../workspace/workspace.js';
import { claudeCommand, NoClaudeError, record, type Model } from '../llm/ask.js';
import { customizingNames } from '../saving/changes.js';
import { ownerAccount } from '../accounting/bank-accounts.js';
import { SHOPIFY_ACCOUNT } from '../accounting/payment-entries.js';
import type { AssistantEvent, AssistantSend } from '../types/assistant.js';

/** The packaged app's files Claude reads (AGENTS.md, workflows/) lie beside its archive, unpacked (electron-builder asarUnpack). */
const APP_FILES = APP_ROOT.replace(/app\.asar(?=$|\/)/, 'app.asar.unpacked');

const LANGUAGES: Record<string, string> = { de: 'German', fr: 'French', it: 'Italian', en: 'English' };

/** Where Ändern may write: the draft's copy of each customizing folder or file. */
export function draftPatterns(): string[] {
  return customizingNames().map((n) => (/\.[a-z]+$/i.test(n) ? `data/draft/${n}` : `data/draft/${n}/**`));
}

/** `owner`: the owner's private account, number and name (src/accounting/bank-accounts.ts ownerAccount); `map`: the app's places in the person's language. */
export function assistantSystem(language: string, owner: string, map: string): string {
  return [
    'You work on the books of one company in Vanilla Accounting, a Swiss bookkeeping app, for the person who keeps them. They are not an accountant and not technical. Do what they ask.',
    'The current directory is the company\'s app folder: ledger.json (config.closedThrough: the last day of the filed quarters), master-data/accounts.json (the chart), transactional-data/<year>/books/*.jsonl (receipts, transactions = payments, mappings = links, journalEntries = bookings), invoices.json (customers, invoices and drafts), knowledge/ (rules, counterparties), workflows/, belege.workspace.yaml (the company, its bank accounts, invoicing: payment term, layout, texts).',
    `The app's own rules: ${join(APP_FILES, 'AGENTS.md')}. Its workflows: ${join(APP_FILES, 'workflows')}/<id>/workflow.yaml and <step>/step.yaml. The tax codes and the chart of the books' country: ${join(APP_FILES, 'modules')}/<country>/tax-codes.yaml and chart.yaml. The company's notes: ../docs/company/AGENTS.md when it exists.`,
    map,
    'To change the books, the chart, the invoicing settings or invoices, never edit their files. End your answer with exactly one block that lists the changes, and the app applies them at once, all or none, each with an undo for the person:',
    '```vanilla-changes',
    '[{"kind":"receipt","id":"<receipt id>","set":{"date":"2026-06-28","amount":1243.55,"currency":"<ISO code>","description":"Farbmix AG, Farben","vat":{"hasSwissVat":true,"vatId":"<the VAT number on the receipt>","vatSummary":[{"ratePercent":8.1,"net":1150.35,"vat":93.2,"gross":1243.55}]}}},',
    ' {"kind":"link","receipt":"<receipt id>","payment":"<transaction ref>"}, {"kind":"unlink","receipt":"<receipt id>","payment":"<transaction ref>"},',
    ' {"kind":"receiptKind","id":"<receipt id>","as":"duplicate"},',
    ' {"kind":"entry","id":"<journal entry id>","set":{"accountDebit":"4000","accountCredit":"1020","vatCode":"<VAT code>","amount":1243.55,"date":"2026-07-03","description":"…"}},',
    ' {"kind":"newEntry","entry":{"transactionRef":"<transaction ref>","date":"<the payment\'s date>","accountDebit":"…","accountCredit":"<the payment\'s bank account>","amount":44.5,"description":"…"}},',
    ' {"kind":"deleteEntry","id":"<journal entry id>"},',
    ' {"kind":"account","number":"4000","name":"Materialaufwand"},',
    ' {"kind":"invoicing","set":{"paymentTermsDays":10,"texts":{"de":{"intro":"Grüezi …","closing":"… zahlbar innert {days} Tagen …"}}}},',
    ' {"kind":"invoiceDraft","customer":"<customer id>","draft":{"subject":"Malerarbeiten Küche","lines":[{"text":"Malerarbeiten","quantity":12,"unit":"h","price":95,"vatRate":8.1}]}},',
    ' {"kind":"export","preset":"treuhand","period":"2026-Q3"}, {"kind":"bookAgain"}]',
    '```',
    'Only the fields that change go into "set"; "vatCode":"" removes the code. "vat" with "hasSwissVat":false means the receipt shows no Swiss VAT. Take ids from what the person refers to or from the books. Check the receipt itself (Read its PDF) before you set facts from it.',
    'A receipt\'s facts say what the paper shows, nothing else: never change them to steer a booking. How much input tax is claimed is the booking\'s VAT code.',
    'A receipt that is a second copy of another is "as":"duplicate"; a file that is no receipt at all (an ad, a delivery note without amount) is "as":"noise"; "as":null makes it an ordinary receipt again. Either takes it off the to-do list and its links go; the app books its payments again.',
    'A booking goes only on an account of the chart: when it needs a new one, add it with "account" in the same block. The VAT code\'s letter follows the account the booking lands on (material and goods: M; operating costs and investments: I); the app sets it and says so.',
    `The owner's private account in these books is ${owner}. A private expense, or the private share of one, is booked to it and has no VAT code at all (leave "vatCode" out or empty; not a zero-rate code): no input tax is claimed on it. Never use another account for private.`,
    `The VAT is reported on payments received (cash basis): a booking of a payment carries the payment's date, also when the invoice is older, and its VAT belongs to the quarter of the payment. Never move such a booking to another date, and never offer to; the app refuses it. Only bookings on the payout clearing account ${SHOPIFY_ACCOUNT} take the order's date.`,
    'The bookings of a payment add up to what the bank paid. To split one (e.g. half private), change the first and add the other part with "newEntry" on the same payment and date, in the same block; the app refuses a block that leaves a payment\'s bookings not adding up.',
    'A filed quarter (dated on or before config.closedThrough) never changes: say so, and that a correction is booked in the open quarter.',
    'Invoices: "invoiceDraft" writes a draft for a customer of invoices.json ("customer": its id), or for a new one ("newCustomer": {"name","address":{"street","number","postcode","town","country"},"language"} instead of "customer"); unit is one of h, day, pcs, flat, km; prices are net. The person issues and sends it in Rechnungen; you never do. "invoicing" changes the settings of every invoice: "paymentTermsDays" (also for each customer who had the old term) and per language the texts "intro", "closing", "mailSubject", "mailBody" (null: the app\'s own text again; {days} is the customer\'s payment term).',
    '"export" packs a preset of the export dialog for a period (a quarter 2026-Q3, a year 2026; left out: the preset\'s own) and the person downloads it from the card; sending it to anyone the app cannot do.',
    'To book again what is open («buch alles neu»), use "bookAgain": the inbox run books every open payment without a booking, the same way it does on its own. Never relink or rebook by hand to do that.',
    'When a wish is vague (e.g. "make everything right"), change nothing yet: ask back in one short question and say what you would do and on what (this receipt, this payment, the quarter). Say what you looked at.',
    'Never take back or redo a change made earlier in this conversation, nor a person\'s own correction in the books (a booking of origin "manual", a receipt kind set by a person, a link a person removed), without naming it plainly and asking first; the app refuses a block that takes back an earlier change of the conversation (its card has «Rückgängig» for that).',
    'Never send the person to a button, menu or screen that is not in the map above. Do the work in the block, or say plainly that you cannot do it and where in the app the person does it.',
    'How the app works (rules, workflows, knowledge) you change in the draft, never in place: to change a file X of this folder, write data/draft/X (Read X first, then Write its whole new content). Tell the person it takes effect when they press «Speichern» under Änderungen. The chart, the invoicing settings and invoices are never drafted: they go into the block.',
    'Before the block, say in one or two plain sentences what you changed. Never mention files, JSON, ids, git or commits to the person.',
    `Answer in ${LANGUAGES[language] ?? 'German'}, short and plain, addressing the person informally as the app does (du, tu).`,
  ].join('\n');
}

/** What the block changes at once with an undo is never drafted: the chart (an account of it is a change of the books' answer). */
export const NEVER_DRAFTED = ['data/draft/master-data/accounts.json'];

export function assistantArgs(send: Pick<AssistantSend, 'language'>, session: string | undefined, repository: string, owner: string, map = ''): string[] {
  const writes = draftPatterns().flatMap((p) => [`Edit(${p})`, `Write(${p})`]);
  const never = NEVER_DRAFTED.flatMap((p) => [`Edit(${p})`, `Write(${p})`]);
  return [
    '-p',
    '--model', 'sonnet',
    '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--append-system-prompt', assistantSystem(send.language, owner, map),
    '--setting-sources', '',
    '--strict-mcp-config',
    '--permission-mode', 'default',
    '--add-dir', APP_FILES, repository,
    '--allowedTools', 'Read', 'Glob', 'Grep', ...writes,
    '--disallowedTools', 'Bash', 'NotebookEdit', 'WebFetch', 'WebSearch', ...never,
    ...(session ? ['--resume', session] : []),
  ];
}

/** The message: what the person refers to, as the server read it now, then their words. */
export function assistantPrompt(text: string, context: string[]): string {
  return [
    context.length ? ['The person refers to:', ...context.map((c) => `- ${c}`)].join('\n') : '',
    text.trim(),
  ].filter(Boolean).join('\n\n');
}

type Block = { type: string; text?: string; name?: string; id?: string; input?: Record<string, unknown> };
type Line = {
  type?: string; subtype?: string; session_id?: string; is_error?: boolean; result?: string;
  tool_name?: string; tool_use_id?: string;
  event?: { type?: string; content_block?: Block; delta?: { type?: string; text?: string } };
  message?: { content?: Block[] };
  usage?: { input_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number; output_tokens?: number };
  num_turns?: number; modelUsage?: Record<string, unknown>;
};

/**
 * Turns stream-json lines into events. The answer's text comes from the partial messages' text
 * deltas; a message that came without them (an older CLI) gives its text whole. Text blocks apart
 * (before and after a tool) are kept apart by a blank line. `roots` are the workspace's paths, cut
 * from a tool's file so it reads as the person knows it.
 */
export function streamParser(roots: string[]): (line: string) => AssistantEvent[] {
  let texted = false;
  let streamed = false;
  const details = new Map<string, string>();
  const relative = (p: string) => {
    const root = roots.find((r) => p.startsWith(r + '/'));
    return root ? p.slice(root.length + 1) : p;
  };
  const text = (s: string): AssistantEvent[] => {
    const out: AssistantEvent[] = [{ type: 'text', text: (texted ? '\n\n' : '') + s }];
    texted = true;
    return out;
  };
  return (raw) => {
    let m: Line;
    try { m = JSON.parse(raw) as Line; } catch { return []; }
    if (m.type === 'system' && m.subtype === 'init' && m.session_id) return [{ type: 'session', session: m.session_id }];
    if (m.type === 'system' && m.subtype === 'permission_denied' && m.tool_name) {
      return [{ type: 'tool', name: m.tool_name, detail: details.get(m.tool_use_id ?? '') ?? '', denied: true }];
    }
    if (m.type === 'stream_event') {
      const e = m.event;
      if (e?.type === 'message_start') streamed = false;
      if (e?.type === 'content_block_start' && e.content_block?.type === 'text' && texted) { streamed = true; return [{ type: 'text', text: '\n\n' }]; }
      if (e?.type === 'content_block_delta' && e.delta?.type === 'text_delta' && e.delta.text) {
        streamed = true;
        texted = true;
        return [{ type: 'text', text: e.delta.text }];
      }
      return [];
    }
    if (m.type === 'assistant') {
      return (m.message?.content ?? []).flatMap((b): AssistantEvent[] => {
        if (b.type === 'tool_use' && b.name) {
          const i = b.input ?? {};
          const what = [i.file_path, i.path, i.command, i.pattern, i.url, i.description].find((v) => typeof v === 'string') as string | undefined;
          const detail = relative(what ?? '').slice(0, 160);
          if (b.id) details.set(b.id, detail);
          return [{ type: 'tool', name: b.name, detail }];
        }
        if (b.type === 'text' && b.text && !streamed) return text(b.text);
        return [];
      });
    }
    if (m.type === 'result') {
      const isError = !!m.is_error || m.subtype !== 'success';
      return [
        ...(isError ? [{ type: 'error', message: (m.result || m.subtype || 'claude').slice(0, 500) } as AssistantEvent] : []),
        { type: 'done', isError, ...(m.session_id ? { session: m.session_id } : {}) },
      ];
    }
    return [];
  };
}

/** The ledger's model name of a model id such as claude-opus-4-x; sonnet when it names none of the three. */
function modelOf(usage: Record<string, unknown> | undefined): Model {
  const id = Object.keys(usage ?? {})[0] ?? '';
  return (['opus', 'haiku', 'sonnet'] as const).find((m) => id.includes(m)) ?? 'sonnet';
}

export interface AssistantCall {
  ws: Pick<Workspace, 'paths' | 'bankAccounts' | 'company'>;
  send: AssistantSend;
  /** The app's places, for the prompt (src/server/app-map.ts). */
  map: string;
  session: string | undefined;
  prompt: string;
  onEvent(e: AssistantEvent): void;
  signal: AbortSignal;
}

/** Sends one message and streams the answer to `onEvent`, ending with `done` or `error`. Resolves when the CLI exits. */
export function callClaude(call: AssistantCall): Promise<void> {
  const started = Date.now();
  const root = call.ws.paths.root;
  return new Promise((resolve) => {
    const { bin, env } = claudeCommand();
    const child = spawn(bin, assistantArgs(call.send, call.session, call.ws.paths.repository, ownerAccount(call.ws), call.map), { cwd: root, env: { ...env, VANILLA_WORKSPACE: root } });
    let real = root;
    try { real = realpathSync(root); } catch { /* the path as given */ }
    const parse = streamParser([...new Set([root, real])]);
    let ended = false;
    let pending = '';
    let err = '';
    const emit = (e: AssistantEvent) => {
      if (e.type === 'done' || e.type === 'error') ended = true;
      call.onEvent(e);
    };
    const kill = () => child.kill('SIGTERM');
    call.signal.addEventListener('abort', kill, { once: true });
    child.stdout.on('data', (d: Buffer) => {
      pending += d.toString('utf8');
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        if (line.includes('"type":"result"')) ledger(line);
        parse(line).forEach(emit);
      }
    });
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e: NodeJS.ErrnoException) => {
      if (!ended) emit({ type: 'error', message: e.code === 'ENOENT' ? new NoClaudeError().message : e.message });
    });
    child.on('close', (code) => {
      call.signal.removeEventListener('abort', kill);
      if (pending) parse(pending).forEach(emit);
      if (!ended && !call.signal.aborted) emit({ type: 'error', message: `claude exited ${code}: ${err.trim().slice(0, 300)}` });
      resolve();
    });
    child.stdin.on('error', () => { /* 'error' or 'close' says why */ });
    child.stdin.end(call.prompt);
  });

  function ledger(line: string): void {
    let m: Line;
    try { m = JSON.parse(line) as Line; } catch { return; }
    const u = m.usage ?? {};
    record({
      at: new Date().toISOString(), step: 'assistant', model: modelOf(m.modelUsage), ok: !m.is_error, ms: Date.now() - started,
      input: u.input_tokens ?? 0, cacheCreate: u.cache_creation_input_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0,
      output: u.output_tokens ?? 0, turns: m.num_turns ?? 0,
    });
  }
}
