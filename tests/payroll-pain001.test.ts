/**
 * The payment file of a month's Lohnzahlungen (docs/specs/payroll.md §6.3, §15.3 checkpoint 7): pain.001.001.09
 * in the shape of the Swiss Payment Standards 2022, checked element by element against the schema's sequences
 * (the order the XSD requires, the counts and sums it checks, the lengths of its text types), and which payouts
 * the file pays: those not paid yet with an IBAN; the others named. The XSD itself is not in the repository.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { XMLParser } from 'fast-xml-parser';
import { pain001, PainError, iidOf } from '../src/providers/pain001/xml.js';
import { paymentFilePlan, paymentFileOf } from '../src/payroll/payment-file.js';
import type { PaymentRow } from '../src/payroll/payments.js';
import type { PayslipClose } from '../src/payroll/model.js';

const IBAN = (s: string) => s.replace(/\s/g, '');
const FIRM_IBAN = IBAN('CH93 0076 2011 6238 5295 7');
const A = IBAN('CH56 0483 5012 3456 7800 9');
const B = IBAN('CH44 3199 9123 0008 8901 2');

type Node = Record<string, unknown>;
const ordered = new XMLParser({ preserveOrder: true, ignoreAttributes: false });
const plain = new XMLParser({ ignoreAttributes: false, parseTagValue: false, isArray: (name) => name === 'CdtTrfTxInf' });
/** The child elements of the first element named `path` (a / path), in document order. */
function children(xml: string, path: string[]): string[] {
  let level = ordered.parse(xml) as Node[];
  for (const name of path) {
    const hit = level.find((n) => name in n);
    assert.ok(hit, `${name} present`);
    level = hit[name] as Node[];
  }
  return level.flatMap((n) => Object.keys(n).filter((k) => k !== ':@' && k !== '#text'));
}

const order = (payments = [
  { id: '2026-09-p1', name: 'Nora Beispiel', iban: A, amount: 4210.35, purpose: 'Lohn 09/2026', address: { street: 'Weg', number: '3', postcode: '9000', town: 'St. Gallen', country: 'CH' } },
  { id: '2026-09-p2', name: 'Jon & Söhne <Test>', iban: B, amount: 1676.2, purpose: 'Lohn 09/2026' },
]) => ({ messageId: 'L202609-20260924101500', created: '2026-09-24T10:15:00.000Z', executionDate: '2026-09-25', currency: 'CHF', debtor: { name: 'Beispiel Schreinerei GmbH', iban: FIRM_IBAN, address: { street: 'Werkstrasse', number: '5', postcode: '9000', town: 'St. Gallen', country: 'CH' } }, payments });

test('the document is pain.001.001.09 and its sequences follow the schema', () => {
  const xml = pain001(order());
  assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.09"'));
  assert.deepEqual(children(xml, ['Document', 'CstmrCdtTrfInitn']), ['GrpHdr', 'PmtInf']);
  assert.deepEqual(children(xml, ['Document', 'CstmrCdtTrfInitn', 'GrpHdr']), ['MsgId', 'CreDtTm', 'NbOfTxs', 'CtrlSum', 'InitgPty']);
  assert.deepEqual(children(xml, ['Document', 'CstmrCdtTrfInitn', 'PmtInf']), ['PmtInfId', 'PmtMtd', 'BtchBookg', 'NbOfTxs', 'CtrlSum', 'PmtTpInf', 'ReqdExctnDt', 'Dbtr', 'DbtrAcct', 'DbtrAgt', 'CdtTrfTxInf', 'CdtTrfTxInf']);
  assert.deepEqual(children(xml, ['Document', 'CstmrCdtTrfInitn', 'PmtInf', 'CdtTrfTxInf']), ['PmtId', 'Amt', 'Cdtr', 'CdtrAcct', 'RmtInf']);
  assert.deepEqual(children(xml, ['Document', 'CstmrCdtTrfInitn', 'PmtInf', 'CdtTrfTxInf', 'Cdtr', 'PstlAdr']), ['StrtNm', 'BldgNb', 'PstCd', 'TwnNm', 'Ctry'], 'a structured address in the schema\'s order');
  assert.deepEqual(children(xml, ['Document', 'CstmrCdtTrfInitn', 'PmtInf', 'ReqdExctnDt']), ['Dt'], 'v09 takes the date in Dt');
});

test('the counts, sums, category and agent are what a bank checks', () => {
  const doc = plain.parse(pain001(order())).Document.CstmrCdtTrfInitn;
  assert.equal(doc.GrpHdr.NbOfTxs, '2');
  assert.equal(doc.GrpHdr.CtrlSum, '5886.55', '4,210.35 + 1,676.20, two decimals');
  assert.equal(doc.PmtInf.CtrlSum, doc.GrpHdr.CtrlSum);
  assert.equal(doc.GrpHdr.CreDtTm, '2026-09-24T10:15:00');
  assert.equal(doc.PmtInf.PmtTpInf.CtgyPurp.Cd, 'SALA', 'salaries: the bank shows one debit without the single payments');
  assert.equal(doc.PmtInf.DbtrAcct.Id.IBAN, FIRM_IBAN);
  assert.deepEqual(doc.PmtInf.DbtrAgt.FinInstnId.ClrSysMmbId, { ClrSysId: { Cd: 'CHBCC' }, MmbId: '00762' }, 'the IID inside the IBAN');
  const tx = doc.PmtInf.CdtTrfTxInf;
  assert.deepEqual(tx.map((t: Node) => [(t.Amt as Node).InstdAmt, ((t.Amt as Node).InstdAmt as Node)['@_Ccy'], ((t.CdtrAcct as Node).Id as Node).IBAN]), [[{ '#text': '4210.35', '@_Ccy': 'CHF' }, 'CHF', A], [{ '#text': '1676.20', '@_Ccy': 'CHF' }, 'CHF', B]]);
  assert.equal(tx[1].Cdtr.Nm, 'Jon & Söhne <Test>', 'escaped, and read back as written');
  assert.equal(tx[1].Cdtr.PstlAdr, undefined, 'no address: none, rather than an unstructured one');
  assert.equal(tx[0].PmtId.EndToEndId, '2026-09-p1');
  for (const t of tx) assert.ok(t.PmtId.InstrId.length <= 35 && t.PmtId.EndToEndId.length <= 35);
});

test('a payment without a valid IBAN or with no amount is refused; the IID only from a Swiss or Liechtenstein IBAN', () => {
  assert.throws(() => pain001(order([{ id: 'x', name: 'X', iban: 'CH00 1234', amount: 10, purpose: 'Lohn' }])), PainError);
  assert.throws(() => pain001(order([{ id: 'x', name: 'X', iban: A, amount: 0, purpose: 'Lohn' }])), PainError);
  assert.throws(() => pain001(order([])), PainError);
  assert.equal(iidOf('DE89370400440532013000'), undefined);
});

test('the month\'s file pays the payouts not paid yet with an IBAN, names the others, and asks for today when the payday is past', () => {
  const row = (id: string, more: Partial<PaymentRow>): PaymentRow => ({ id, employee: id.slice(8), name: `P ${id}`, payout: 1000, purpose: 'Lohn 09/2026', valueDate: '2026-09-25', iban: A, ...more });
  const rows = [row('2026-09-a', {}), row('2026-09-b', { iban: undefined }), row('2026-09-c', { paid: { ref: 'T1', date: '2026-09-25', amount: 1000, currency: 'CHF', forThis: 1000, together: false } }), row('2026-09-d', { payout: 0 })];
  const accounts = [{ bank: 'raiffeisen', currency: 'CHF', account: '1020', label: 'Bank', role: 'bank' as const, iban: FIRM_IBAN }, { bank: 'manual', currency: 'CHF', account: '2451', label: 'Inhaber', role: 'owner' as const }];
  const plan = paymentFilePlan(rows, accounts as never, 'CHF', '2026-09-20');
  assert.deepEqual(plan.included.map((p) => p.id), ['2026-09-a']);
  assert.deepEqual(plan.left, [{ id: '2026-09-b', name: 'P 2026-09-b', why: 'noIban' }, { id: '2026-09-c', name: 'P 2026-09-c', why: 'paid' }]);
  assert.deepEqual(plan.accounts.map((a) => a.account), ['1020'], 'only a bank account in the books\' currency with an IBAN');
  assert.equal(plan.executionDate, '2026-09-25');
  assert.equal(paymentFilePlan(rows, accounts as never, 'CHF', '2026-10-02').executionDate, '2026-10-02');
  const xml = paymentFileOf(plan, rows, [] as PayslipClose[], { name: 'Firma' }, '1020', 'CHF', '2026-09-20T08:00:00.000Z');
  assert.match(xml, /<NbOfTxs>1<\/NbOfTxs>/);
  assert.match(xml, /<MsgId>L202609-20260920080000<\/MsgId>/);
});
