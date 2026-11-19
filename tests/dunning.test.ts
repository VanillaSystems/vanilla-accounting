/**
 * Mahnwesen (docs/specs/invoicing.md 4.4.7, phase 3 P3.4, P3.5): the Mahnlauf over many overdue
 * Rechnungen with one confirmation, each at its next Mahnstufe, the contact with «keine Mahnungen»
 * and a fresh comment named as left out, every PDF in the sent log, and a second run sending
 * nothing again; the automatic Zahlungserinnerung 5 days after due, sent without a click on the
 * device that holds the books and not on a Durchsicht copy, its failure a task once; a draft
 * Mahnung deleted takes its level back; default interest; a paid fee and interest booked on both bases.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { loadJurisdiction } from '../src/core/modules/load.js';
import { setJurisdiction } from '../src/engines/index.js';
import { APP_ROOT, workspaceAt, type Workspace } from '../src/workspace/workspace.js';
import { EFFECTIVE_QUARTERLY, type VatSetup } from '../src/workspace/vat-setup.js';
import { patchManifest } from '../src/workspace/manifest-write.js';
import { INVOICES_SCHEMA } from '../src/workspace/schema.js';
import type { Contact, DunningSettings, InvoiceBook, Issued, Reminder } from '../src/invoices/model.js';
import { loadInvoices, saveInvoices } from '../src/invoices/store.js';
import {
  autoReminders, createReminderDraft, deleteReminderDraft, planDunningRun, runDunning, sendReminder, updateReminderDraft, type MailReminder, type Printer,
} from '../src/invoices/service.js';
import { DEFAULT_DUNNING, MAX_RUN, draftReminder, dunningRun, interestOf, reminderTitle } from '../src/invoices/dunning.js';
import { allocate, openFees, withPayment } from '../src/invoices/rules.js';
import { bookPayment, type PaymentContext } from '../src/invoices/payments.js';
import { DURCHSICHT_MARKER } from '../src/handover/content.js';
import { remindOutcome } from '../src/workflows/dunning.js';
import { eventRef } from '../src/books/refs.js';
import type { Books } from '../src/books/store.js';
import type { BankTransaction } from '../src/types/index.js';
import { issued as fixture } from './support/invoice-fixtures.js';
import { tempWorkspace } from './support/workspace.js';

const ch = loadJurisdiction(APP_ROOT, 'ch').jurisdiction;
setJurisdiction(ch);

let printed = 0;
const printer: Printer = { pdf: async (d) => ({ html: '', pages: 1, pdf: Buffer.from(`%PDF-1.4 ${d.reminderTitle ?? ''} ${d.number ?? ''} ${++printed}`) }), html: async () => ({ html: '', pages: 1 }) };

/** A mail server that takes every message, or refuses `refuse`; what it took, by recipient. */
function mailbox(refuse?: string) {
  const sent: Array<{ to: string; number: string; title: string; filename: string }> = [];
  const mail: MailReminder = (to, inv, r) => async ({ filename }) => {
    if (to === refuse) throw new Error('550 Mailbox unavailable');
    sent.push({ to, number: inv.number, title: reminderTitle(r, inv.language), filename });
    return { to, messageId: `<${inv.number}.${r.level}@mail>` };
  };
  return { sent, mail };
}

const contact = (id: string, over: Partial<Contact> = {}): Contact => ({
  id, createdAt: '2026-01-01T08:00:00Z', origin: 'manual', deleted: false, type: 'firm', name: `Kunde ${id}`, persons: [], addresses: [], language: 'de', emails: [`ap@${id}.example`], ...over,
});

/** A sent Mahnung of `level` on `date`, as the sent log keeps it. */
const sentReminder = (level: number, date: string, title: string, fee?: number): Reminder => ({ level, title, date, dueDate: shift(date, 10), ...(fee ? { fee } : {}), intro: '', closing: '', documentId: `sd_${level}_${date}` });
const shift = (iso: string, days: number) => new Date(Date.parse(`${iso}T12:00:00Z`) + days * 864e5).toISOString().slice(0, 10);

/** The workspace with `book` as its invoices.json and `dunning` as its Mahnwesen; the firm's mail set up unless `mail` is false. */
function workspace(book: Omit<InvoiceBook, 'schema'>, dunning: DunningSettings = DEFAULT_DUNNING, mail = true): Workspace {
  const ws = tempWorkspace('dunning-');
  patchManifest(ws.paths.manifest, { invoicing: { dunning } });
  const opened = workspaceAt(ws.paths.root);
  saveInvoices(opened, { schema: INVOICES_SCHEMA, ...book });
  return mail ? { ...opened, outgoingMail: { host: 'smtp.example', port: 587, security: 'starttls', fromAddress: 'rechnung@firma.example' } } : opened;
}

const reminded = (ws: Workspace, number: string) => (loadInvoices(ws).invoices.find((i) => i.number === number) as Issued).reminders;

test('P3.4: 14 overdue Rechnungen of 9 contacts, one Mahnlauf, one confirmation: the right level each, «keine Mahnungen» and a fresh comment named as left out, every PDF in the sent log, nothing sent twice', async () => {
  const contacts = ['k1', 'k2', 'k3', 'k4', 'k5', 'k6', 'k7', 'k8', 'k9'].map((id) => contact(id, {
    ...(id === 'k8' ? { emails: [] } : {}), ...(id === 'k9' ? { noReminders: true } : {}),
  }));
  const L = DEFAULT_DUNNING.levels.map((l) => l.name);
  let n = 0;
  const inv = (customerId: string, dueDate: string, over: Partial<Issued> = {}): Issued => {
    n++;
    const number = `RE-2026-${String(n).padStart(5, '0')}`;
    return fixture(`in_${n}`, number, { customerId, date: shift(dueDate, -30), dueDate, customer: { ...fixture('x', 'x').customer, name: `Kunde ${customerId}`, email: customerId === 'k8' ? undefined : `ap@${customerId}.example` }, ...over });
  };
  const invoices: Issued[] = [
    inv('k1', '2026-10-01'),
    inv('k1', '2026-09-01', { reminders: [sentReminder(1, '2026-10-01', L[0]!)] }),
    inv('k1', '2026-08-01', { reminders: [sentReminder(1, '2026-09-01', L[0]!), sentReminder(2, '2026-10-01', L[1]!)] }),
    inv('k2', '2026-10-15'),
    inv('k2', '2026-10-10', { comments: [{ id: 'co_1', createdAt: '2026-11-17T10:00:00Z', origin: 'manual', deleted: false, author: 'Anna', text: 'Zahlt am Freitag.' }] }),
    inv('k3', '2026-10-20'),
    inv('k4', '2026-10-25'),
    inv('k5', '2026-11-01'),
    inv('k6', '2026-11-05'),
    inv('k7', '2026-11-10'),
    inv('k8', '2026-10-05'),
    inv('k8', '2026-10-06'),
    inv('k9', '2026-10-01'),
    inv('k9', '2026-10-02'),
  ];
  assert.equal(invoices.length, 14);
  // Not overdue on the day: never listed, never named.
  const notDue = inv('k3', '2026-11-30');
  const ws = workspace({ contacts, invoices: [...invoices, notDue], sent: [] });
  const date = '2026-11-19';

  const plan = planDunningRun(ws, date);
  assert.equal(plan.items.length, 11, '14 less the two of «keine Mahnungen» and the one commented on');
  assert.deepEqual(plan.leftOut.map((x) => [x.number, x.reason]).sort(), [['RE-2026-00005', 'comment'], ['RE-2026-00013', 'noReminders'], ['RE-2026-00014', 'noReminders']]);
  assert.equal(plan.leftOut.find((x) => x.reason === 'comment')!.date, '2026-11-17');
  const level = (number: string) => plan.items.find((i) => i.number === number)!;
  assert.deepEqual([level('RE-2026-00001').title, level('RE-2026-00002').title, level('RE-2026-00003').title], L, 'each at the level after its last sent');
  assert.equal(level('RE-2026-00011').to, undefined, 'no address: downloaded');
  assert.equal(level('RE-2026-00004').to, 'ap@k2.example');
  assert.ok(!plan.items.some((i) => i.number === notDue.number));

  // One confirmation: the dialog's «Senden» posts the ticked ones at once.
  const box = mailbox();
  const out = await runDunning(ws, { date, ids: plan.items.map((i) => i.invoiceId) }, { printer, mail: box.mail });
  assert.equal(out.failed.length, 0);
  assert.equal(out.sent.length, 11);
  assert.equal(box.sent.length, 9, 'nine by e-mail');
  assert.deepEqual(out.sent.filter((s) => s.channel === 'download').map((s) => s.number), ['RE-2026-00011', 'RE-2026-00012']);
  assert.deepEqual(box.sent.find((m) => m.number === 'RE-2026-00003'), { to: 'ap@k1.example', number: 'RE-2026-00003', title: '2. Mahnung', filename: '2. Mahnung · Rechnung RE-2026-00003.pdf' });

  const book = loadInvoices(ws);
  for (const s of out.sent) {
    const r = reminded(ws, s.number).at(-1)!;
    assert.equal(r.by, 'run');
    const doc = book.sent.find((d) => d.id === r.documentId)!;
    assert.ok(doc, `${s.number}: its Mahnung is in the sent log`);
    assert.equal(doc.kind, 'reminder');
    const bytes = readFileSync(join(ws.paths.root, doc.file));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), doc.sha256, 'the PDF as it went out');
  }
  assert.deepEqual(reminded(ws, 'RE-2026-00003').map((r) => r.level), [1, 2, 3]);
  assert.deepEqual(reminded(ws, 'RE-2026-00013'), [], '«keine Mahnungen»: nothing');

  // The next run on the same day sends no level again: each is due anew in its level's days.
  const again = planDunningRun(ws, date);
  assert.deepEqual(again.items, []);
});

test('the Mahnlauf names its limit: 40 Mahnungen, the rest counted; the ticked rows only, a ticked one not overdue named', () => {
  const invoices = Array.from({ length: MAX_RUN + 12 }, (_, k) => fixture(`in_${k}`, `RE-${k}`, { dueDate: '2026-10-01', customerId: 'k1' }));
  const book: InvoiceBook = { schema: INVOICES_SCHEMA, contacts: [contact('k1')], invoices, sent: [] };
  const plan = dunningRun(book, invoices, DEFAULT_DUNNING, '2026-11-19', { canMail: true });
  assert.deepEqual([plan.items.length, plan.more, plan.limit], [40, 12, 40]);
  const paid = withPayment(fixture('in_p', 'RE-P', { dueDate: '2026-10-01' }), { transactionRef: 'T', date: '2026-10-20', amount: 1000, by: 'reference' });
  const ticked = dunningRun({ ...book, invoices: [...invoices, paid] }, [...invoices, paid], DEFAULT_DUNNING, '2026-11-19', { canMail: true, only: ['in_1', 'in_p'] });
  assert.deepEqual(ticked.items.map((i) => i.number), ['RE-1']);
  assert.deepEqual(ticked.leftOut.map((x) => [x.number, x.reason]), [['RE-P', 'notOverdue']]);
});

test('P3.5: the automatic Zahlungserinnerung 5 days after due goes without a click on the device that holds the books, not on a copy; the next Mahnlauf does not send it again', async () => {
  const dunning: DunningSettings = { levels: [{ ...DEFAULT_DUNNING.levels[0]!, auto: { afterDays: 5 } }, ...DEFAULT_DUNNING.levels.slice(1)] };
  const due = fixture('in_a', 'RE-2026-00001', { customerId: 'k1', dueDate: '2026-11-01' });
  const ws = workspace({ contacts: [contact('k1')], invoices: [due], sent: [] }, dunning);
  const box = mailbox();

  // Before its day, the Mahnlauf leaves it to the automatic reminder, named with the day it goes.
  const before = planDunningRun(ws, '2026-11-04');
  assert.deepEqual(before.leftOut.map((x) => [x.number, x.reason, x.date]), [['RE-2026-00001', 'auto', '2026-11-06']]);
  assert.deepEqual((await autoReminders(ws, { today: '2026-11-05', printer, mail: box.mail })).sent, [], 'four days after due: not yet');

  // A Durchsicht copy of the books never sends.
  const marker = join(ws.paths.root, DURCHSICHT_MARKER);
  mkdirSync(dirname(marker), { recursive: true });
  writeFileSync(marker, '{}');
  assert.deepEqual(await autoReminders(ws, { today: '2026-11-06', printer, mail: box.mail }), { sent: [], failed: [], skipped: 'copy' });
  assert.equal(box.sent.length, 0);
  assert.deepEqual(reminded(ws, 'RE-2026-00001'), []);

  // The device that holds them: on the fifth day after due, by e-mail, without a click.
  rmSync(marker);
  const sent = await autoReminders(ws, { today: '2026-11-06', now: '2026-11-06T07:05:00Z', printer, mail: box.mail });
  assert.deepEqual(sent.sent.map((s) => [s.number, s.title, s.channel, s.to]), [['RE-2026-00001', 'Zahlungserinnerung', 'email', 'ap@k1.example']]);
  assert.deepEqual(box.sent.map((m) => m.title), ['Zahlungserinnerung']);
  const r = reminded(ws, 'RE-2026-00001');
  assert.deepEqual(r.map((x) => [x.level, x.by, x.date]), [[1, 'auto', '2026-11-06']]);
  assert.ok(loadInvoices(ws).sent.some((d) => d.id === r[0]!.documentId && d.channel === 'email'), 'in the sent log');

  // The next round and the next Mahnlauf: nothing goes twice.
  assert.deepEqual((await autoReminders(ws, { today: '2026-11-07', printer, mail: box.mail })).sent, []);
  assert.deepEqual(planDunningRun(ws, '2026-11-07').items, [], 'the Zahlungserinnerung is not sent again');
  // Once its own days are over, the run proposes the next level, the 1. Mahnung by hand.
  assert.deepEqual(planDunningRun(ws, '2026-11-17').items.map((i) => i.title), ['1. Mahnung']);
});

test('an automatic reminder that cannot go is a task with words, once; the next round sends it when the address is there', async () => {
  const dunning: DunningSettings = { levels: [{ ...DEFAULT_DUNNING.levels[0]!, auto: { afterDays: 5 } }, ...DEFAULT_DUNNING.levels.slice(1)] };
  const ws = workspace({ contacts: [contact('k1', { emails: [] }), contact('k2', { emails: ['abgelehnt@k2.example'] })], invoices: [
    fixture('in_a', 'RE-1', { customerId: 'k1', dueDate: '2026-11-01', customer: { ...fixture('x', 'x').customer, email: undefined } }),
    fixture('in_b', 'RE-2', { customerId: 'k2', dueDate: '2026-11-01', customer: { ...fixture('x', 'x').customer, email: 'abgelehnt@k2.example' } }),
  ], sent: [] }, dunning);
  const box = mailbox('abgelehnt@k2.example');
  const round = await autoReminders(ws, { today: '2026-11-10', printer, mail: box.mail });
  assert.deepEqual(round.failed.map((f) => [f.number, f.reason]), [['RE-1', 'noAddress'], ['RE-2', 'refused']]);
  assert.match(round.failed[1]!.detail!, /550/);
  assert.equal(loadInvoices(ws).sent.length, 0, 'a refused e-mail records nothing');
  const task = remindOutcome(ws, round);
  assert.deepEqual(task, { outcome: 'failed', output: { invoices: 'RE-1, RE-2', noaddress: 'RE-1', refused: 'RE-2 (550 Mailbox unavailable)' } });
  assert.equal(remindOutcome(ws, await autoReminders(ws, { today: '2026-11-10', printer, mail: box.mail })).outcome, 'none', 'the same failure is one task, not one per hour');
  // The address is added: the next round sends it, the failure is gone.
  const book = loadInvoices(ws);
  book.contacts[0] = { ...book.contacts[0]!, emails: ['neu@k1.example'] };
  saveInvoices(ws, book);
  const next = await autoReminders(ws, { today: '2026-11-11', printer, mail: box.mail });
  assert.deepEqual(next.sent.map((s) => [s.number, s.to]), [['RE-1', 'neu@k1.example']]);
});

test('«Mahnen» writes the next level as a draft in the invoice\'s language; it is edited, sent and kept as sent; an unsent one deleted takes its level back', async () => {
  const fr = fixture('in_f', 'RE-9', { customerId: 'k1', language: 'fr', date: '2026-09-01', dueDate: '2026-10-01', customer: { ...fixture('x', 'x').customer, language: 'fr' } });
  const ws = workspace({ contacts: [contact('k1', { language: 'fr' })], invoices: [fr], sent: [] });
  const d = createReminderDraft(ws, 'in_f', { date: '2026-11-19' });
  assert.deepEqual([d.level, d.title, d.dueDate, d.documentId], [1, 'Rappel de paiement', '2026-11-29', undefined]);
  assert.match(d.intro, /^Notre facture RE-9 du 01\.09\.2026 était payable le 01\.10\.2026\./);
  assert.equal(createReminderDraft(ws, 'in_f', { date: '2026-11-20' }).date, '2026-11-19', 'one draft: a second «Mahnen» returns it');
  assert.equal(planDunningRun(ws, '2026-11-19').items[0]!.draft, true, 'the run sends the draft as written');
  // Deleted: the level goes back, and a new one starts at the same level.
  deleteReminderDraft(ws, 'in_f');
  assert.deepEqual(reminded(ws, 'RE-9'), []);
  createReminderDraft(ws, 'in_f', { date: '2026-11-19' });
  const edited = updateReminderDraft(ws, 'in_f', { intro: 'Cher client, …', fee: 15, date: '2026-11-20' });
  assert.deepEqual([edited.intro, edited.fee, edited.dueDate], ['Cher client, …', 15, '2026-11-30']);
  const box = mailbox();
  const out = await sendReminder(ws, 'in_f', {}, { printer, now: '2026-11-20T09:00:00Z', deliver: box.mail('ap@k1.example', fr, edited) });
  assert.equal(out.reminder.documentId, out.sent.id);
  assert.deepEqual(reminded(ws, 'RE-9').map((r) => [r.level, r.intro, r.fee]), [[1, 'Cher client, …', 15]]);
  assert.equal(openFees(loadInvoices(ws).invoices[0] as Issued), 15, 'a sent Mahnung charges its fee');
  // Sent: kept as sent, neither changed nor deleted.
  assert.throws(() => deleteReminderDraft(ws, 'in_f'), (e: Error & { code?: string }) => e.code === 'noReminderDraft');
  assert.throws(() => updateReminderDraft(ws, 'in_f', { fee: 0 }), (e: Error & { code?: string }) => e.code === 'noReminderDraft');
});

test('default interest: off by default; on, it runs from the due date at the rate set and prints as its own line, replacing what an earlier Mahnung charged', () => {
  const inv = fixture('in_i', 'RE-I', { dueDate: '2026-10-01', lines: [{ text: 'Beratung', quantity: 1, price: 7300, vatRate: 0 }] });
  assert.equal(draftReminder(inv, [inv], '2026-11-19', DEFAULT_DUNNING).interest, undefined);
  const on: DunningSettings = { ...DEFAULT_DUNNING, interest: { rate: 5 } };
  // 7300 × 5 % × 49 / 365 = 49.00
  assert.deepEqual(interestOf(inv, [inv], '2026-11-19', on), { rate: 5, from: '2026-10-01', to: '2026-11-19', days: 49, amount: 49 });
  const first = { ...draftReminder(inv, [inv], '2026-11-19', on), documentId: 'sd_1' };
  const second = { ...draftReminder({ ...inv, reminders: [first] }, [inv], '2026-12-09', on), documentId: 'sd_2' };
  assert.equal(second.interest!.amount, 69, '69 days from the due date');
  const both: Issued = { ...inv, reminders: [first, second] };
  assert.equal(openFees(both), 69, 'the later replaces the earlier');
  assert.deepEqual(allocate(both, [both], 7369), { amount: 7300, fee: 0, interest: 69, surplus: 0 });
});

// ─── booking a paid fee and interest ───────────────────────────────────────────

const AGREED: VatSetup = { registered: true, method: 'effective', reporting: 'agreed', period: 'quarterly' };
const ctx: PaymentContext = {
  bankAccounts: [{ bank: 'Raiffeisen', currency: 'CHF', account: '1021', label: 'Bank', role: 'bank' }],
  revenueAccount: '3200', feeAccount: '3800', interestAccount: '6950', openItems: { receivable: '1100', payable: '2000', fxDifference: '6960' }, fx: { daily: () => undefined },
  pdfOf: () => Buffer.from('%PDF'), receiptId: () => 'r_1', indexedAt: (t) => `${t.date}T18:00:00Z`, held: () => new Set(),
};
const books = (): Books => ({ receipts: [], transactions: [], mappings: [], bankStatements: [], journalEntries: [], config: { closedThrough: '2026-06-30' } });

for (const [basis, setup] of [['cash', EFFECTIVE_QUARTERLY], ['agreed', AGREED]] as const) {
  test(`a payment with a Mahnung's fee and interest books them without a VAT code, the fee on its account, the interest on the financial income (${basis} basis)`, () => {
    setJurisdiction(ch, setup);
    try {
      const inv: Issued = { ...fixture('in_m', 'RE-M', { dueDate: '2026-09-01', lines: [{ text: 'Beratung', quantity: 1, price: 1000, vatRate: 8.1 }] }), reminders: [
        { level: 1, title: 'Zahlungserinnerung', date: '2026-10-01', dueDate: '2026-10-11', fee: 20, interest: { rate: 5, from: '2026-09-01', to: '2026-10-01', days: 30, amount: 4.45 }, intro: '', closing: '', documentId: 'sd_1' },
      ] };
      const split = allocate(inv, [inv], 1105.45);
      assert.deepEqual(split, { amount: 1081, fee: 20, interest: 4.45, surplus: 0 });
      const tx: BankTransaction = { ref: 'P1', bank: 'Raiffeisen', date: '2026-10-20', amount: 1105.45, currency: 'CHF', direction: 'CRDT', description: 'RE-M', reference: inv.reference };
      const b = books();
      if (basis === 'agreed') b.journalEntries.push({ id: 'ev', transactionRef: eventRef(inv, 'issue'), date: '2026-08-01', accountDebit: '1100', accountCredit: '3200', amount: 1081, vatCode: 'V81', description: 'Rechnung RE-M', origin: 'invoice' });
      const entries = bookPayment(b, tx, inv, { transactionRef: 'P1', date: tx.date, amount: split.amount, fee: split.fee, interest: split.interest, by: 'reference' }, ctx, { files: [] }, [inv]);
      const lines = entries.map((e) => [e.accountDebit, e.accountCredit, e.amount, e.vatCode ?? '']);
      assert.deepEqual(lines.slice(-2), [['1021', '3800', 20, ''], ['1021', '6950', 4.45, '']], 'never with a sale code: no consideration for a supply');
      assert.deepEqual(lines[0], basis === 'cash' ? ['1021', '3200', 1081, 'V81'] : ['1021', '1100', 1081, '']);
      assert.equal(Math.round(entries.reduce((s, e) => s + e.amount, 0) * 100) / 100, 1105.45);
    } finally {
      setJurisdiction(ch);
    }
  });
}

test('a draft Mahnung charges nothing yet: a payment of the invoice alone pays it', () => {
  const inv: Issued = { ...fixture('in_d', 'RE-D', { dueDate: '2026-09-01' }), reminders: [{ level: 1, date: '2026-10-01', dueDate: '2026-10-11', fee: 20, intro: '', closing: '' }] };
  assert.equal(openFees(inv), 0);
  assert.deepEqual(allocate(inv, [inv], 1020), { amount: 1000, fee: 0, interest: 0, surplus: 20 });
});
