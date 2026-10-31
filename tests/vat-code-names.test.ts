/**
 * VAT codes in plain words (issue #224): every code the engine knows has a name in every language,
 * made from the catalogue (vatCodeName), and the code picker groups the firm's codes by what the
 * person is doing and finds them by name or code.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import './support/jurisdiction.js';
import { loadJurisdiction } from '../src/core/modules/load.js';
import { setJurisdiction, vat } from '../src/engines/index.js';
import { APP_ROOT } from '../src/workspace/workspace.js';
import type { VatSetup } from '../src/workspace/vat-setup.js';
import { VAT_CODE_GROUPS, vatCodeName, vatCodes, type VatCodeText } from '../src/accounting/vat-codes.js';
import { pickGroups } from '../src/app/areas/codes/model.js';
import type { Locale } from '../src/app/i18n/types.js';
import de from '../src/app/i18n/locales/de.js';

const { jurisdiction } = loadJurisdiction(APP_ROOT, 'ch');
const LOCALES = 'src/app/i18n/locales';
const locales = await Promise.all(readdirSync(LOCALES).filter((f) => f.endsWith('.ts')).map(async (f) =>
  ({ code: f.slice(0, -3), messages: ((await import(`../${LOCALES}/${f}`)) as { default: Locale }).default.messages as Record<string, unknown> })));

/** A language's dictionary as vatCodeName reads it; a missing key or an unfilled placeholder fails. */
const textIn = (lang: string, messages: Record<string, unknown>): VatCodeText => (key, vars) => {
  const raw = messages[key];
  assert.equal(typeof raw, 'string', `${lang}: ${key} is missing`);
  return (raw as string).replace(/\{(\w+)\}/g, (_, n: string) => {
    assert.ok(vars[n] !== undefined && vars[n] !== '', `${lang}: ${key} needs {${n}}`);
    return String(vars[n]);
  });
};
const german = textIn('de', de.messages as Record<string, unknown>);
const name = (code: string) => vatCodeName(code, german)!;

test('every code the engine knows, and its minus form, has a plain name in de, fr, it and en', () => {
  const codes = [...new Set([...vatCodes().map((c) => c.code), ...vat().codes.named])];
  assert.ok(codes.length > 60, `${codes.length} codes`);
  assert.deepEqual(locales.map((l) => l.code).sort(), ['de', 'en', 'fr', 'it']);
  for (const { code: lang, messages } of locales) {
    for (const code of codes.flatMap((c) => [c, `-${c}`])) {
      const words = vatCodeName(code, textIn(lang, messages));
      assert.ok(words && words.trim() && !words.includes('{'), `${lang} ${code}: «${words}»`);
    }
  }
});

test('the names say what the issue asks: the kind with its rate, the amount where a rate comes in several, the minus as a refund', () => {
  assert.equal(name('M81'), 'Material 8.1 % (MWST inbegriffen)');
  assert.equal(name('M81-2'), 'Material 8.1 %, nur die Steuer');
  assert.equal(name('-V81'), 'Rückerstattung Verkauf 8.1 %');
  assert.equal(name('B81-1'), 'Bezugsteuer Dienstleistung Ausland 8.1 % (Betrag ohne MWST)');
  assert.equal(name('I77'), 'Betriebsaufwand 7.7 % (MWST inbegriffen), Satz bis 2023');
  assert.equal(name('V0-E'), 'Dienstleistung ins Ausland, ohne MWST');
  assert.equal(name('F2'), 'Verkauf zum 2. Saldosteuersatz');
  assert.equal(name('FS1'), 'Skonto zum 1. Saldosteuersatz');
  assert.equal(name('F1055'), 'Steueranrechnung Formular 1055');
  assert.equal(vatCodeName('X99', german), undefined, 'a code the catalogue does not know has no name');
});

test('the codes a firm picks among on the current rates read apart, so no person needs the code to tell them', () => {
  const current = vatCodes().filter((c) => !c.superseded && !/^FS?[34]$/.test(c.code)).map((c) => c.code);
  const byName = new Map<string, string[]>();
  for (const code of current) byName.set(name(code), [...(byName.get(name(code)) ?? []), code]);
  assert.deepEqual([...byName].filter(([, cs]) => cs.length > 1), []);
});

test('the picker groups the firm\'s codes by what the person is doing, in the issue\'s order, current rates first', () => {
  const groups = pickGroups('', name);
  assert.deepEqual(groups.map((g) => g.group), [...VAT_CODE_GROUPS]);
  const of = (group: string) => groups.find((g) => g.group === group)!.options.map((o) => o.code);
  assert.deepEqual(of('material').slice(0, 3), ['M0', 'M81', 'M81-1']);
  assert.ok(of('material').indexOf('M77') > of('material').indexOf('M38'), 'a rate that ended after the current ones');
  assert.ok(of('import').includes('M81-2') && of('import').includes('I81-2') && !of('material').includes('M81-2'), 'the tax alone is how import VAT is booked');
  assert.ok(of('abroad').includes('V0-E') && of('abroad').includes('B81-1'));
  assert.ok(of('sale').includes('V81') && of('expense').includes('I81') && of('correction').includes('K81-B'));
  assert.equal(groups.flatMap((g) => g.options).length, vatCodes().length, 'every code once on the effective method');
  assert.equal(groups[0].options[1].name, 'Material 8.1 % (MWST inbegriffen)');
});

test('the picker finds a code by words of its name, by its code, and lists the minus codes when the query starts with «-»', () => {
  const codes = (q: string) => pickGroups(q, name).flatMap((g) => g.options.map((o) => o.code));
  assert.deepEqual(codes('einfuhr'), [], 'the group\'s name is no search word: a name holds it or not');
  assert.ok(codes('nur die steuer').every((c) => /-2$/.test(c)) && codes('nur die steuer').includes('M81-2'));
  assert.deepEqual(codes('betriebsaufwand 8.1'), ['I81', 'I81-1', 'I81-2']);
  assert.deepEqual(codes('v0-e'), ['V0-E']);
  assert.ok(codes('i81').includes('I81') && !codes('i81').includes('M81'));
  const refunds = codes('-verkauf 8.1');
  assert.ok(refunds.includes('-V81') && refunds.every((c) => c.startsWith('-')), refunds.join(' '));
  assert.equal(pickGroups('-v81', name).find((g) => g.options.some((o) => o.code === '-V81'))!.options[0].name, 'Rückerstattung Verkauf 8.1 %');
  assert.deepEqual(codes('kein solcher code'), []);
});

test('the picker offers only the codes the firm\'s form takes: none when not registered, no input tax on the net tax rate method', () => {
  const NET_RATE: VatSetup = { registered: true, method: 'net-rate', reporting: 'received', period: 'half-yearly', rates: [{ rate: 4.5, label: 'Schreinerei' }] };
  try {
    setJurisdiction(jurisdiction, NET_RATE);
    const codes = pickGroups('', name).flatMap((g) => g.options.map((o) => o.code));
    assert.ok(codes.includes('F1') && codes.includes('V0') && codes.includes('B81-1'), codes.join(' '));
    assert.ok(!codes.some((c) => /^[MIK]/.test(c)), codes.join(' '));
    setJurisdiction(jurisdiction, { registered: false });
    assert.deepEqual(pickGroups('', name), []);
  } finally {
    setJurisdiction(jurisdiction);
  }
});
