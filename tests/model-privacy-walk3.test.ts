/**
 * Privacy by content, not by kind (docs/specs/payroll.md §22 decision 108, second review of walk 3): whatever a receipt was
 * taken for, no prompt carries the name of a person of payroll.json, a social security number, a birth date or, once the
 * text names a person, a wage beside its word (src/llm/mask.ts, applied in src/llm/ask.ts to every prompt and system text,
 * and by the sidebar). A model's answer names her again. Invented people only.
 */
import './support/demo-workspace.js';
import './support/jurisdiction.js';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadBooks, PERSON, saveBooks, update } from '../src/books/store.js';
import type { Ask } from '../src/intake/pipeline.js';
import { cleanUp, drop, firm, pay, run } from './support/payslip-firm.js';
import { textPdf } from './support/text-pdf.js';
import { savePayroll } from '../src/payroll/store.js';
import { firm as payrollFirm, owner } from './support/payroll.js';
import { maskForModel, setMaskPeople, unmaskFromModel } from '../src/llm/mask.js';
import { assistantArgs } from '../src/assistant/claude.js';

after(cleanUp);

const SSN = ['756', '1234', '5678', '97'].join('.');
const cert = (head: string, more: string[] = []) => ['Vorsorgestiftung Beispiel', head, 'Vertragsnummer: V-77', 'Versicherte Person: Mila Beispiel', `AHV-Nr. ${SSN}`, 'Geburtsdatum 12.05.1980', "Versicherter Lohn CHF 92'000.00", 'Beitrag Arbeitnehmer pro Monat 300.00', ...more];
const leaks = (p: string) => ['Mila Beispiel', 'Beispiel Mila', SSN, '12.05.1980', "92'000"].filter((w) => p.includes(w));

test('decision 108: the mask itself: names given back in the answer, labels, birth dates, wages once a person is named; the prompt\'s own structure kept', () => {
  setMaskPeople(() => ['Mila Beispiel']);
  try {
    const text = ['Lohn Juli 2026 an Beispiel, Mila 4\'200.00', 'Versicherte Person: Corinne Wyss', 'Geburtsdatum 12.05.1980', "Versicherter Lohn CHF 92'000.00", 'Total CHF 1\'250.00'].join('\n');
    const masked = maskForModel(text);
    assert.deepEqual(leaks(masked), []);
    assert.ok(!masked.includes('Corinne'), 'the name after a person\'s label');
    assert.ok(masked.includes("Total CHF 1'250.00"), 'a total is no wage');
    assert.equal(unmaskFromModel('Gebucht für [Person 1].'), 'Gebucht für Mila Beispiel.');
    // In a JSON prompt: the lines of a receipt's text (written as \n) are masked, the prompt's own keys and amounts are not.
    const json = JSON.stringify({ amount: 92000, text: "Versicherter Lohn CHF 92'000.00\nVersicherte Person: Corinne Wyss" });
    const m = maskForModel(json);
    assert.ok(m.includes('"amount":92000') && !m.includes("92'000.00") && !m.includes('Corinne'));
    // Without a person, a label or a number, a wage word leaves the amount: a fiduciary's «Lohnbuchhaltung 450.00» is read.
    assert.equal(maskForModel('Lohnbuchhaltung Q3 450.00'), 'Lohnbuchhaltung Q3 450.00');
  } finally { setMaskPeople(() => []); }
});

test('decision 108 by content: a linked, an unlinked bill-like, a closed-period and a person-kinded certificate never reach a prompt with her name, number, birth date or wage', async () => {
  const prompts: string[] = [];
  // What a provider gets: src/llm/ask.ts sends every prompt and system text through maskForModel (askOne).
  const ask: Ask = async (prompt, opts) => { prompts.push(maskForModel(prompt), maskForModel(opts.system ?? '')); return '{}'; };
  const ws = firm('Teegarten Wyss GmbH', [pay('P1', '2026-07-23', 600, 'Vorsorgestiftung Beispiel', 'Beitrag Juli'), pay('P2', '2026-08-23', 600, 'Vorsorgestiftung Beispiel', 'Beitrag August')]);
  savePayroll(ws, payrollFirm([owner()]));
  await drop(ws, [
    ['linked.pdf', textPdf(cert('Vorsorgeausweis per 1.7.2026'))],
    ['billlike.pdf', textPdf(cert('Vorsorgeausweis per 1.7.2026', ['Zu bezahlender Betrag CHF 600.00 bis 31.08.2026']))],
    ['closed.pdf', textPdf(cert('Vorsorgeausweis per 1.5.2026'))],
    ['human.pdf', textPdf(cert('Vorsorgeausweis per 1.7.2026', ['Kopie']))],
  ]);
  await run(ws, ask);
  // As before this change: kinds taken off, one linked by her, one kinded by her as an invoice.
  const books = loadBooks(ws);
  update(books, PERSON, (b) => {
    for (const r of b.receipts) { delete r.kind; delete r.kindBy; delete r.kindRule; }
    const by = (n: string) => b.receipts.find((r) => r.originalFilename === n || r.filename.includes(n.replace('.pdf', '')))!;
    b.mappings.push({ transactionRef: 'P1', receiptId: by('linked.pdf').id, rule: 'manual' } as never);
    Object.assign(by('human.pdf'), { kind: 'invoice', kindBy: 'human' });
  });
  saveBooks(ws, books);
  await run(ws, ask);
  assert.ok(prompts.length > 0, 'the model was asked');
  const leaked = prompts.flatMap(leaks);
  assert.deepEqual([...new Set(leaked)], [], 'nothing of her reached a prompt');
});

test('decision 108: the sidebar is denied the files of a fund\'s documents', () => {
  const args = assistantArgs({ language: 'de' }, undefined, '/repo', '2850', '', undefined, ['**/transactional-data/*/receipts/20260701-vorsorgeausweis.pdf']);
  assert.ok(args.includes('Read(**/transactional-data/*/receipts/20260701-vorsorgeausweis.pdf)'));
});
