/**
 * The AI sidebar (src/assistant/): its file tools write only into the draft's copy of the
 * customizing (never the books, never in place, never the approvals), no settings are loaded that
 * could allow more, the stream parser keeps text and tools apart, and the route end to end with
 * the claude stub: a conversation is stored, continued by its session, and its context read; the
 * changes to the books an answer asks for are applied, each undone on its own, and refused whole
 * when one touches a filed quarter, leaves a payment's bookings not adding up to it, or dates a
 * payment's booking off the payment (cash basis); a split payment comes back out whole.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assistantArgs, assistantSystem, draftPatterns, streamParser } from '../src/assistant/claude.js';
import { ownerAccount } from '../src/accounting/bank-accounts.js';
import { loadBooks } from '../src/books/store.js';
import { workspaceAt } from '../src/workspace/workspace.js';
import type { AssistantEvent, MadeChange } from '../src/types/assistant.js';
import type { Index } from '../src/types/index.js';
import { DEMO_ROOT } from './support/workspace.js';
import { startApi } from './support/api-server.js';

const REPO = process.cwd();
const listAfter = (args: string[], flag: string) => {
  const at = args.indexOf(flag);
  const end = args.findIndex((a, i) => i > at && a.startsWith('--'));
  return args.slice(at + 1, end < 0 ? undefined : end);
};

test('its file tools write only into the draft, and only the customizing: never the books, no Bash, no settings', () => {
  const args = assistantArgs({ language: 'de' }, 's1', '/repo', '2451 Kontokorrent');
  const allowed = listAfter(args, '--allowedTools');
  const writes = allowed.filter((t) => /^(Edit|Write)\(/.test(t));
  assert.deepEqual(allowed.filter((t) => !writes.includes(t)), ['Read', 'Glob', 'Grep']);
  assert.ok(writes.length > 0);
  assert.ok(writes.every((t) => /^(Edit|Write)\(data\/draft\/[^)]+\)$/.test(t)), writes.join(' '));
  assert.ok(writes.some((t) => t === 'Edit(data/draft/knowledge/**)'));
  assert.ok(writes.some((t) => t === 'Write(data/draft/workflows/**)'));
  for (const p of draftPatterns()) assert.ok(!/transactional-data|ledger\.json|invoices\.json|data\/draft\/data/.test(p), p);
  assert.ok(listAfter(args, '--disallowedTools').includes('Bash'));
  assert.deepEqual(listAfter(args, '--setting-sources'), ['']);
  assert.deepEqual(listAfter(args, '--resume'), ['s1']);
  assert.equal(assistantArgs({ language: 'de' }, undefined, '/repo', '2451 Kontokorrent').includes('--resume'), false);
});

test('the prompt names the owner\'s private account: the manifest\'s own, else the legal form\'s', () => {
  const ws = workspaceAt(DEMO_ROOT);
  assert.equal(ownerAccount(ws), '2451 Kontokorrent Anna Muster');
  assert.match(assistantSystem('de', ownerAccount(ws)), /private account in these books is 2451 Kontokorrent Anna Muster\. .*no VAT code/);
  const none = { bankAccounts: ws.bankAccounts.filter((a) => a.bank !== 'manual') };
  assert.equal(ownerAccount({ ...none, company: { ...ws.company, legalForm: 'Einzelfirma' } }), '2850 Privat');
  assert.equal(ownerAccount({ ...none, company: { ...ws.company, legalForm: 'GmbH' } }), '2451 Kontokorrent');
});

test('the stream parser gives the text in pieces, tools with their file, and refusals', () => {
  const parse = streamParser(['/ws']);
  const lines = [
    { type: 'system', subtype: 'init', session_id: 's1' },
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Ich lese ' } } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Write', input: { file_path: '/ws/ledger.json' } }] } },
    { type: 'system', subtype: 'permission_denied', tool_name: 'Write', tool_use_id: 't1' },
    { type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'text' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Fertig.' } } },
    { type: 'result', subtype: 'success', is_error: false, session_id: 's2' },
  ];
  const events = lines.flatMap((l) => parse(JSON.stringify(l)));
  assert.deepEqual(events, [
    { type: 'session', session: 's1' },
    { type: 'text', text: 'Ich lese ' },
    { type: 'tool', name: 'Write', detail: 'ledger.json' },
    { type: 'tool', name: 'Write', detail: 'ledger.json', denied: true },
    { type: 'text', text: '\n\n' },
    { type: 'text', text: 'Fertig.' },
    { type: 'done', isError: false, session: 's2' },
  ] satisfies AssistantEvent[]);
});

test('a message streams its answer, is stored, reads its context, and the next one continues the session', async () => {
  const log = mkdtempSync(join(tmpdir(), 'assistant-stub-'));
  const api = await startApi('demo/vanilla-accounting', {
    PATH: `${join(REPO, 'tests/support/stub-bin')}:${process.env.PATH}`,
    CLAUDE_STUB_PROMPTS: join(log, 'prompts.txt'), CLAUDE_STUB_ARGS: join(log, 'args.txt'),
  });
  try {
    const post = async (body: unknown) => {
      const res = await fetch(`http://127.0.0.1:${api.port}/api/assistant`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return (await res.text()).trim().split('\n').map((l) => JSON.parse(l) as AssistantEvent);
    };
    const first = await post({ text: 'Warum so gebucht?', language: 'de', context: [{ kind: 'workflow', id: 'booking', label: 'Buchen' }] });
    const id = (first[0] as Extract<AssistantEvent, { type: 'conversation' }>).id;
    assert.equal(first.at(-1)?.type, 'done');
    assert.match(first.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text).join(''), /Stub-Antwort auf «Warum so gebucht\?»\. Ein neues Gespräch\./);
    assert.match(readFileSync(join(log, 'prompts.txt'), 'utf8'), /Workflow booking \(Buchen\)/, 'the context is read into the message');
    const second = await post({ conversation: id, text: 'Und jetzt?', language: 'de', context: [] });
    assert.equal((second[0] as { id: string }).id, id);
    const args = readFileSync(join(log, 'args.txt'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as string[]);
    assert.ok(args[1].includes('--resume'), 'the second message continues the first one\'s session');
    const { json } = await api.send('GET', `/api/assistant/${id}`);
    const turns = json.turns as Array<{ role: string; text: string; done?: boolean }>;
    assert.deepEqual(turns.map((t) => t.role), ['me', 'ai', 'me', 'ai']);
    assert.ok(turns[3].done && /geht weiter/.test(turns[3].text));
    const list = await api.send('GET', '/api/assistant');
    assert.deepEqual((list.json as unknown as Array<{ id: string; title: string; context: string[] }>).map((c) => [c.id, c.title, c.context]), [[id, 'Warum so gebucht?', ['Buchen']]]);
    assert.equal((await api.send('POST', '/api/assistant', { text: ' ', context: [] })).status, 400);
  } finally {
    api.stop();
  }
});

test('the changes an answer asks for are made at once, each undone on its own; one on a filed quarter refuses them all', async () => {
  const demo = loadBooks(workspaceAt(DEMO_ROOT));
  const closedThrough = demo.config.closedThrough!;
  const dateOf = (ref: string) => demo.transactions.find((x) => x.ref === ref)?.date ?? '';
  const linkedTo = (id: string) => demo.mappings.filter((m) => m.receiptId === id).map((m) => dateOf(m.transactionRef));
  const open = demo.receipts.find((r) => { const d = linkedTo(r.id); return d.length > 0 && d.every((x) => x > closedThrough); })!;
  const filed = demo.receipts.find((r) => { const d = linkedTo(r.id); return d.length > 0 && d.every((x) => x <= closedThrough); })!;
  assert.ok(open && filed, 'the demo has a receipt of the open quarter and one of a filed quarter');

  const log = mkdtempSync(join(tmpdir(), 'assistant-changes-'));
  const changes = join(log, 'changes.json');
  const api = await startApi('demo/vanilla-accounting', { PATH: `${join(REPO, 'tests/support/stub-bin')}:${process.env.PATH}`, CLAUDE_STUB_CHANGES: changes });
  try {
    const books = async () => (await (await fetch(`http://127.0.0.1:${api.port}/books.json`)).json()) as Index;
    const post = async (body: unknown) => {
      const res = await fetch(`http://127.0.0.1:${api.port}/api/assistant`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return (await res.text()).trim().split('\n').map((l) => JSON.parse(l) as AssistantEvent);
    };
    const vat = { hasSwissVat: true, vatId: 'CHE-123.456.789', vatSummary: [{ ratePercent: 8.1, net: 100, vat: 8.1, gross: 108.1 }] };
    writeFileSync(changes, JSON.stringify([{ kind: 'receipt', id: open.id, set: { date: '2026-06-28', amount: 108.1, currency: 'CHF', vat } }]));
    const events = await post({ text: 'Bitte richtig eintragen', language: 'de', context: [{ kind: 'receipt', id: open.id, label: 'Beleg' }] });
    assert.deepEqual(events.slice(-2).map((e) => e.type), ['changes', 'done'], 'the changes come before done');
    const made = (events.at(-2) as Extract<AssistantEvent, { type: 'changes' }>).changes;
    assert.equal(made.length, 1);
    const after = (await books()).receipts.find((r) => r.id === open.id)!;
    assert.deepEqual([after.date, after.amount, after.currency, after.hasSwissVat, after.vatSummary, after.vatId], ['2026-06-28', 108.1, 'CHF', true, vat.vatSummary, vat.vatId]);
    assert.equal(after.vatBy, 'human', 'she asked for them: the VAT step never reads them over');
    const id = (events[0] as { id: string }).id;
    const stored = (await api.send('GET', `/api/assistant/${id}`)).json.turns as Array<{ role: string; text: string; changes?: MadeChange[] }>;
    assert.doesNotMatch(stored[1].text, /vanilla-changes/, 'the person never sees the block');

    const undo = await api.send('POST', `/api/assistant/${id}/changes/${made[0].id}/undo`);
    assert.equal(undo.status, 200);
    const back = (await books()).receipts.find((r) => r.id === open.id)!;
    for (const k of ['date', 'amount', 'currency', 'hasSwissVat', 'vatSummary', 'vatId', 'lineItems', 'vatBy'] as const) assert.deepEqual(back[k], open[k], k);

    writeFileSync(changes, JSON.stringify([{ kind: 'receipt', id: open.id, set: { description: 'neu' } }, { kind: 'receipt', id: filed.id, set: { amount: 1, currency: 'CHF' } }]));
    const refused = await post({ text: 'Beides ändern', language: 'de', context: [] });
    assert.ok(refused.some((e) => e.type === 'refused' && /geschlossen/.test(e.message)), 'the filed quarter refuses');
    const untouched = await books();
    assert.equal(untouched.receipts.find((r) => r.id === open.id)!.description, open.description, 'nothing of a refused answer is written');
    assert.equal(untouched.receipts.find((r) => r.id === filed.id)!.amount, filed.amount);
  } finally {
    api.stop();
    rmSync(log, { recursive: true, force: true });
  }
});

test('the block is cut from what the person reads, also half-streamed; a block that is not a list of known changes is refused', async () => {
  const { changesIn, withoutChanges } = await import('../src/assistant/changes.js');
  assert.equal(withoutChanges('Erledigt.\n\n```vanilla-changes\n[{"kind":"link"'), 'Erledigt.');
  assert.deepEqual(changesIn('Nichts zu tun.'), []);
  assert.deepEqual(changesIn('ok\n```vanilla-changes\n[{"kind":"link","receipt":"r1","payment":"p1"}]\n```'), [{ kind: 'link', receipt: 'r1', payment: 'p1' }]);
  assert.deepEqual(changesIn('```vanilla-changes\n[{"kind":"newEntry","entry":{"transactionRef":"p1","date":"2026-07-15","accountDebit":"2451","accountCredit":"1020","amount":44.5,"description":"privat","vatCode":""}},{"kind":"deleteEntry","id":"e1"}]\n```'), [
    { kind: 'newEntry', entry: { transactionRef: 'p1', date: '2026-07-15', accountDebit: '2451', accountCredit: '1020', amount: 44.5, description: 'privat', origin: 'manual' } },
    { kind: 'deleteEntry', id: 'e1' },
  ]);
  for (const bad of ['{"kind":"link"}', '[{"kind":"delete","id":"r1"}]', '[{"kind":"deleteEntry"}]',
    '[{"kind":"newEntry","entry":{"date":"2026-07-15","amount":5,"description":"x"}}]', '[{"kind":"newEntry","entry":{"date":"2026-07-15","accountDebit":"6500","amount":0,"description":"x"}}]', '[{"kind":"receipt","id":"r1","set":{"date":"28.06.2026"}}]', '[{"kind":"receipt","id":"r1","set":{}}]', '[{"kind":"receipt","id":"r1","set":{"vat":{"hasSwissVat":true}}}]']) {
    assert.throws(() => changesIn('```vanilla-changes\n' + bad + '\n```'), bad);
  }
});

test('a booking split by the AI keeps its payment whole: half alone is refused, both halves go in and come back out together; delete and re-add replace a booking', async () => {
  const demo = loadBooks(workspaceAt(DEMO_ROOT));
  const tx = demo.transactions.find((t) => t.date > demo.config.closedThrough! && t.bank === 'Raiffeisen' && t.direction === 'DBIT' && demo.journalEntries.filter((e) => e.transactionRef === t.ref).length === 1)!;
  const entry = demo.journalEntries.find((e) => e.transactionRef === tx.ref)!;
  assert.equal(entry.accountCredit, '1021', 'the demo books the payment off its bank account');
  const half = Math.round(entry.amount * 50) / 100;

  const log = mkdtempSync(join(tmpdir(), 'assistant-split-'));
  const changes = join(log, 'changes.json');
  const api = await startApi('demo/vanilla-accounting', { PATH: `${join(REPO, 'tests/support/stub-bin')}:${process.env.PATH}`, CLAUDE_STUB_CHANGES: changes });
  try {
    const entriesOf = async () => ((await (await fetch(`http://127.0.0.1:${api.port}/books.json`)).json()) as Index).journalEntries!.filter((e) => e.transactionRef === tx.ref);
    const answer = async (asked: unknown) => {
      writeFileSync(changes, JSON.stringify(asked));
      const res = await fetch(`http://127.0.0.1:${api.port}/api/assistant`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Die Hälfte ist privat', language: 'de', context: [] }) });
      const events = (await res.text()).trim().split('\n').map((l) => JSON.parse(l) as AssistantEvent);
      return { id: (events[0] as { id: string }).id, events };
    };
    const refusal = (events: AssistantEvent[]) => (events.find((e) => e.type === 'refused') as Extract<AssistantEvent, { type: 'refused' }> | undefined)?.refusal;

    const alone = await answer([{ kind: 'entry', id: entry.id, set: { amount: half } }]);
    assert.deepEqual(refusal(alone.events), { code: 'paymentBalance', params: { date: tx.date, currency: 'CHF', paid: tx.amount, booked: half } });
    assert.deepEqual(await entriesOf(), [entry], 'a half change leaves the books as they were');
    const stored = (await api.send('GET', `/api/assistant/${alone.id}`)).json.turns as Array<{ refusal?: { code: string } }>;
    assert.equal(stored[1].refusal?.code, 'paymentBalance', 'the turn keeps the code, so the sidebar says it in the person\'s language');

    const split = await answer([
      { kind: 'entry', id: entry.id, set: { amount: entry.amount - half } },
      { kind: 'newEntry', entry: { transactionRef: tx.ref, date: tx.date, accountDebit: '2451', accountCredit: '1021', amount: half, description: 'Privatanteil' } },
    ]);
    const made = (split.events.find((e) => e.type === 'changes') as Extract<AssistantEvent, { type: 'changes' }>).changes;
    assert.equal(made.length, 2);
    const both = await entriesOf();
    assert.deepEqual(both.map((e) => [e.accountDebit, e.accountCredit, e.amount, e.vatCode, e.date, e.origin]).sort(), [
      [entry.accountDebit, '1021', entry.amount - half, entry.vatCode, tx.date, 'manual'],
      ['2451', '1021', half, undefined, tx.date, 'manual'],
    ].sort());

    const undo = await api.send('POST', `/api/assistant/${split.id}/changes/${made[1].id}/undo`);
    assert.equal(undo.status, 200);
    assert.deepEqual((undo.json as unknown as MadeChange[]).map((c) => c.id).sort(), made.map((c) => c.id).sort(), 'undoing one half undoes the other');
    assert.deepEqual(await entriesOf(), [entry], 'the payment is booked as before');

    const gone = await answer([{ kind: 'deleteEntry', id: entry.id }]);
    assert.equal(refusal(gone.events)?.code, 'paymentBalance', 'deleting a payment\'s only booking is refused');
    const replaced = await answer([
      { kind: 'deleteEntry', id: entry.id },
      { kind: 'newEntry', entry: { transactionRef: tx.ref, date: tx.date, accountDebit: '6500', accountCredit: '1021', amount: entry.amount, description: 'neu gebucht' } },
    ]);
    const swap = (replaced.events.find((e) => e.type === 'changes') as Extract<AssistantEvent, { type: 'changes' }>).changes;
    assert.deepEqual((await entriesOf()).map((e) => [e.accountDebit, e.description]), [['6500', 'neu gebucht']]);
    assert.equal((await api.send('POST', `/api/assistant/${replaced.id}/changes/${swap[0].id}/undo`)).status, 200);
    assert.deepEqual(await entriesOf(), [entry], 'the deleted booking comes back as it was, id and origin too');
  } finally {
    api.stop();
    rmSync(log, { recursive: true, force: true });
  }
});

test('cash basis: the AI never dates a payment\'s booking off the payment\'s date, except on the payout clearing account', async () => {
  const demo = loadBooks(workspaceAt(DEMO_ROOT));
  const tx = demo.transactions.find((t) => t.date > '2026-07-01' && t.bank === 'Raiffeisen' && t.direction === 'DBIT' && demo.journalEntries.filter((e) => e.transactionRef === t.ref).length === 1)!;
  const entry = demo.journalEntries.find((e) => e.transactionRef === tx.ref)!;
  const before = '2026-06-28';

  const log = mkdtempSync(join(tmpdir(), 'assistant-date-'));
  const changes = join(log, 'changes.json');
  const api = await startApi('demo/vanilla-accounting', { PATH: `${join(REPO, 'tests/support/stub-bin')}:${process.env.PATH}`, CLAUDE_STUB_CHANGES: changes });
  try {
    const entriesOf = async () => ((await (await fetch(`http://127.0.0.1:${api.port}/books.json`)).json()) as Index).journalEntries!.filter((e) => e.transactionRef === tx.ref);
    const answer = async (asked: unknown) => {
      writeFileSync(changes, JSON.stringify(asked));
      const res = await fetch(`http://127.0.0.1:${api.port}/api/assistant`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Die Rechnung ist vom Juni, bitte im Juni buchen', language: 'de', context: [] }) });
      return (await res.text()).trim().split('\n').map((l) => JSON.parse(l) as AssistantEvent);
    };
    const refused = (events: AssistantEvent[]) => events.find((e) => e.type === 'refused') as Extract<AssistantEvent, { type: 'refused' }> | undefined;

    const moved = refused(await answer([{ kind: 'entry', id: entry.id, set: { date: before } }]));
    assert.deepEqual(moved?.refusal, { code: 'paymentDate', params: { date: tx.date } });
    assert.match(moved!.message, /Datum der Zahlung/);
    assert.deepEqual(await entriesOf(), [entry]);

    const splitOff = refused(await answer([
      { kind: 'entry', id: entry.id, set: { amount: entry.amount - 1 } },
      { kind: 'newEntry', entry: { transactionRef: tx.ref, date: before, accountDebit: '2451', accountCredit: '1021', amount: 1, description: 'privat' } },
    ]));
    assert.equal(splitOff?.refusal?.code, 'paymentDate', 'a new booking of a payment takes its date too');

    const clearing = await answer([
      { kind: 'entry', id: entry.id, set: { accountCredit: '1093', date: before } },
      { kind: 'newEntry', entry: { transactionRef: tx.ref, date: tx.date, accountDebit: '1093', accountCredit: '1021', amount: entry.amount, description: 'Auszahlung' } },
    ]);
    assert.ok(clearing.some((e) => e.type === 'changes'), JSON.stringify(refused(clearing)));
    assert.deepEqual((await entriesOf()).map((e) => [e.accountCredit, e.date]).sort(), [['1021', tx.date], ['1093', before]]);
  } finally {
    api.stop();
    rmSync(log, { recursive: true, force: true });
  }
});
