/**
 * Payslips by mail (src/payroll/service.ts sendPayslip, src/payroll/pdf-encrypt.ts; docs/specs/payroll.md
 * §6.2 step 8, §11, §15.1 checkpoint 11): to the person's own address, as a PDF locked with her password
 * (AES-128) that never is the AHV number, the copy to the sender, each mail logged.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { encryptPdf } from '../src/payroll/pdf-encrypt.js';
import { closePayslip, passwordCheck, payslipsSent, sendPayslip, setMailPassword, type BooksWriter } from '../src/payroll/service.js';
import { savePayroll, loadPayroll } from '../src/payroll/store.js';
import { PERSON, updateSaved, type Books } from '../src/books/store.js';
import { textPdf } from './support/text-pdf.js';
import { dated, firm, owner } from './support/payroll.js';
import { tempWorkspace, writeIndex } from './support/workspace.js';

const SSN = ['756', '1234', '5678', '97'].join('.');
const pdftotext = (file: string, password?: string) => execFileSync('pdftotext', [...(password ? ['-upw', password] : []), file, '-'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

test('the locked PDF opens with its password only', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'payroll-enc-'));
  const file = join(dir, 'p.pdf');
  writeFileSync(file, await encryptPdf(await textPdf(['Lohnabrechnung September 2026', 'Auszahlung 8910.00']), 'Sonne-und-Mond'));
  assert.match(pdftotext(file, 'Sonne-und-Mond'), /Auszahlung 8910\.00/);
  assert.throws(() => pdftotext(file), /password|Command Line Error|status/i);
  assert.throws(() => pdftotext(file, 'falsch'), /password|Command Line Error|status/i);
  await assert.rejects(PDFDocument.load(await encryptPdf(await textPdf(['x']), 'Sonne-und-Mond')), /encrypted/i, 'pdf-lib sees it locked too');
});

test('a password is never the AHV number; the date of birth warns first; a generated one is shown once', () => {
  const e = owner({ socialSecurityNumber: SSN, birthDate: '1980-05-12' });
  assert.equal(passwordCheck(e, '7561234567897').refused, 'socialSecurityNumber');
  assert.equal(passwordCheck(e, 'x1234567897x').refused, 'socialSecurityNumber');
  assert.equal(passwordCheck(e, 'kurz').refused, 'short');
  assert.equal(passwordCheck(e, 'geb12051980').warn, 'birthDate');
  const ws = tempWorkspace('payroll-mail-');
  savePayroll(ws, firm([e]));
  assert.deepEqual(setMailPassword(ws, 'e1', 'geb12051980'), { warn: 'birthDate' });
  assert.equal(loadPayroll(ws).employees[0].mailPassword, undefined, 'nothing set before the warning is confirmed');
  const generated = setMailPassword(ws, 'e1', undefined);
  assert.equal(generated.password?.length, 12);
  assert.equal(loadPayroll(ws).employees[0].mailPassword, generated.password);
});

test('the mail goes to the person\'s own address with the copy to the sender, the PDF locked, and is logged', async () => {
  const ws = tempWorkspace('payroll-mail-');
  writeIndex(ws, { journalEntries: [], config: {} });
  const store = firm([owner({ socialSecurityNumber: SSN, email: [dated('2026-01-01', 'mila@beispiel.example')], mailPassword: 'Sonne-und-Mond' })]);
  store.company.sender = { copyTo: 'lohn@firma.example' };
  savePayroll(ws, store);
  const write: BooksWriter = <T>(fn: (b: Books) => T) => updateSaved(ws, PERSON, fn);
  await closePayslip(ws, write, 'e1', '2026-09', { confirm: true });
  const outbox: Array<{ to: string; bcc?: string; subject: string; content: Buffer }> = [];
  const sent = await sendPayslip(ws, '2026-09-e1', async (m, pdf) => { outbox.push({ to: m.to, bcc: m.bcc, subject: m.subject, content: pdf.content }); return { to: m.to, messageId: '<1@x>' }; });
  assert.deepEqual([outbox[0].to, outbox[0].bcc, outbox[0].subject], ['mila@beispiel.example', 'lohn@firma.example', 'Lohnabrechnung September 2026']);
  const file = join(mkdtempSync(join(tmpdir(), 'payroll-sent-')), 'x.pdf');
  writeFileSync(file, outbox[0].content);
  assert.match(pdftotext(file, 'Sonne-und-Mond'), /Lohnabrechnung/);
  assert.throws(() => pdftotext(file));
  assert.deepEqual(payslipsSent(ws, '2026').map((s) => [s.payslip, s.to, s.copyTo]), [[sent.payslip, 'mila@beispiel.example', 'lohn@firma.example']]);
});

test('a password outside printable ASCII or longer than 32 is refused; part of the AHV number too; a short birth date warns', () => {
  const e = owner({ socialSecurityNumber: SSN, birthDate: '1980-05-02' });
  assert.equal(passwordCheck(e, 'Grüezi-Zürich').refused, 'characters');
  assert.equal(passwordCheck(e, 'x'.repeat(33)).refused, 'long');
  assert.equal(passwordCheck(e, 'ab-12345678-cd').refused, undefined);
  assert.equal(passwordCheck(e, `ab${['3456', '7897'].join('')}cd`).refused, 'socialSecurityNumber');
  assert.equal(passwordCheck(e, 'geb2.5.1980x').warn, 'birthDate');
});

test('without a sender set, the copy goes to the mailbox the firm sends from', async () => {
  const ws = tempWorkspace('payroll-mail-');
  writeIndex(ws, { journalEntries: [], config: {} });
  savePayroll(ws, firm([owner({ email: [dated('2026-01-01', 'mila@beispiel.example')], mailPassword: 'Sonne-und-Mond' })]));
  const write: BooksWriter = <T>(fn: (b: Books) => T) => updateSaved(ws, PERSON, fn);
  await closePayslip(ws, write, 'e1', '2026-09', { confirm: true });
  const sending = { ...ws, outgoingMail: { host: 'smtp.example', port: 587, security: 'starttls' as const, fromAddress: 'lohn@firma.example' } } as typeof ws;
  let bcc: string | undefined;
  await sendPayslip(sending, '2026-09-e1', async (m) => { bcc = m.bcc; return { to: m.to, messageId: '<2@x>' }; });
  assert.equal(bcc, 'lohn@firma.example');
});
