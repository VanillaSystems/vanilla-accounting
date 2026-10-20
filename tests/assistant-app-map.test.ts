/**
 * The AI sidebar knows the whole app (src/server/app-map.ts): every area folder of
 * src/app/areas is an area of the app (AREA_HOME, which src/app/areas/index.ts registers by the
 * same ids; that file imports CSS, so not here) and a line of the map, every Firma section and export preset
 * is named, each by the label the person sees in their language; and every change the block
 * takes is shown to the model, while the kinds only an undo uses are refused from an answer.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { AREA_PLACES, COMPANY_PLACES, appMap } from '../src/server/app-map.js';
import { assistantArgs, assistantSystem, NEVER_DRAFTED } from '../src/assistant/claude.js';
import { changesIn, ChangesError } from '../src/assistant/changes.js';
import { AREA_HOME as AREAS, COMPANY_SECTIONS } from '../src/app/shell/route.js';
import { PRESETS } from '../src/export/model.js';
import { wordsIn } from '../src/export/texts.js';
import { workspaceAt } from '../src/workspace/workspace.js';
import { DEMO_ROOT } from './support/workspace.js';

workspaceAt(DEMO_ROOT);
const AREA_DIR = join(process.cwd(), 'src/app/areas');
const folders = readdirSync(AREA_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
  .filter((d) => ['ts', 'tsx'].some((x) => existsSync(join(AREA_DIR, d, `${d}.${x}`))));

test('every area folder is a registered area and a line of the map, every Firma section and export preset too', () => {
  assert.ok(folders.length >= 11, folders.join(' '));
  assert.deepEqual(folders.filter((d) => !(d in AREAS)), [], 'an area folder that is not registered');
  assert.deepEqual(Object.keys(AREA_PLACES).sort(), Object.keys(AREAS).sort());
  assert.deepEqual(Object.keys(COMPANY_PLACES).sort(), [...COMPANY_SECTIONS].sort());
  for (const lang of ['de', 'fr', 'it', 'en']) {
    const { t } = wordsIn(lang);
    const map = appMap(lang);
    for (const id of Object.keys(AREAS)) assert.ok(map.includes(`- ${t(`area.${id}` as 'export.title')}: `), `${lang}: ${id}`);
    for (const s of COMPANY_SECTIONS) assert.ok(map.includes(`  - ${t('area.company')} › ${t(`company.${s}` as 'export.title')}: `), `${lang}: ${s}`);
    for (const p of PRESETS) assert.ok(map.includes(`«${t(`export.preset.${p.id}` as 'export.title')}» (preset "${p.id}"`), `${lang}: ${p.id}`);
    assert.doesNotMatch(map, /\{[\w.-]+\}/, `${lang}: every UI text in the map is filled in`);
  }
});

test('the places the sidebar denied in the wishes test are in its prompt, with what it can do there (w07, w13, w15, w16, w18)', () => {
  const prompt = assistantSystem('de', '2451 Kontokorrent', appMap('de'));
  assert.ok(prompt.includes(appMap('de')));
  assert.match(prompt, /- Rechnungen: .*N writes a new draft.* You: invoiceDraft\./);
  assert.match(prompt, /Firma › Rechnungslayout: .*payment term in days.*text above and below the table.* You: invoicing\./);
  assert.match(prompt, /Exportieren \(⇧E.*«Treuhänder-Paket» \(preset "treuhand".* You: export\./);
  assert.match(prompt, /Firma › Quellen: .*mailboxes/);
});

test('every change the block takes is in the prompt\'s example, and parses; an undo\'s own kinds are refused from an answer', () => {
  const prompt = assistantSystem('de', '2451 Kontokorrent', appMap('de'));
  const example = /```vanilla-changes\n([\s\S]*?)\n```/.exec(prompt)![1]
    .replace('<ISO code>', 'CHF').replace(/<[^>]+>/g, 'x').replace(/"date":"[^"]*"/g, '"date":"2026-07-03"').replace(/"amount":[\d.]+/g, '"amount":1').replace(/…/g, 'x');
  const kinds = changesIn('```vanilla-changes\n' + example + '\n```').map((c) => c.kind);
  const taken = ['receipt', 'link', 'unlink', 'receiptKind', 'entry', 'newEntry', 'deleteEntry', 'account', 'invoicing', 'invoiceDraft', 'export', 'bookAgain', 'question', 'mailbox', 'source'];
  assert.deepEqual([...new Set(kinds)].sort(), [...taken].sort());
  const placeKinds = new Set([...Object.values(AREA_PLACES), ...Object.values(COMPANY_PLACES)].flatMap((p) => p.kinds ?? []));
  assert.deepEqual(taken.filter((k) => !placeKinds.has(k as never) && k !== 'export'), [], 'every change is named at the place where a person does it');
  for (const bad of [
    '[{"kind":"dropInvoiceDraft","id":"in_1"}]', '[{"kind":"dropSource","id":"x"}]', '[{"kind":"account","number":"4000","name":null}]', '[{"kind":"account","number":"40","name":"x"}]',
    '[{"kind":"invoicing","set":{"paymentTermsDays":0}}]', '[{"kind":"invoicing","set":{"texts":{"es":{"intro":"x"}}}}]',
    '[{"kind":"invoiceDraft","draft":{"lines":[]}}]', '[{"kind":"invoiceDraft","customer":"cu_1","newCustomer":{"name":"x"},"draft":{"lines":[{}]}}]',
    '[{"kind":"receiptKind","id":"r1","as":"rubbish"}]', '[{"kind":"export","preset":"everything"}]',
    '[{"kind":"withdrawQuestion","id":"q-1"}]', '[{"kind":"dropMailbox","id":"m"}]', '[{"kind":"question","on":{"kind":"invoice","id":"x"},"text":"?"}]', '[{"kind":"question","on":{"kind":"payment","id":"P"},"text":"?","choices":["maybe"]}]',
  ]) assert.throws(() => changesIn('```vanilla-changes\n' + bad + '\n```'), ChangesError, bad);
});

test('the chart is never drafted: an account goes into the block (w12)', () => {
  const args = assistantArgs({ language: 'de' }, undefined, '/repo', '2451 Kontokorrent');
  const denied = args.slice(args.indexOf('--disallowedTools') + 1);
  for (const p of NEVER_DRAFTED) assert.ok(denied.includes(`Write(${p})`) && denied.includes(`Edit(${p})`), p);
  assert.deepEqual(NEVER_DRAFTED, ['data/draft/master-data/accounts.json']);
});

test('a drafted rule is kept with «Behalten» on its card, and the prompt never sends the person to «Speichern» for a rule; no web address, no closedThrough for the person (wishes3-8, wishes3-13)', () => {
  for (const lang of ['de', 'fr', 'it', 'en']) {
    const { t } = wordsIn(lang);
    const prompt = assistantSystem(lang, '2451 Kontokorrent', appMap(lang));
    const sentences = prompt.split(/(?<=[.;:])\s+|\n/);
    assert.ok(sentences.some((x) => /\brule\b/.test(x) && x.includes(`«${t('rules.draft.keep')}»`)), `${lang}: a rule is kept with its card's click`);
    assert.deepEqual(sentences.filter((x) => x.includes(`«${t('changes.save')}»`) && !/not a rule/.test(x)), [], `${lang}: «${t('changes.save')}» only for what is not a rule`);
    assert.doesNotMatch(appMap(lang), /\(\/[a-z]/, `${lang}: the map names no web address`);
    assert.match(appMap(lang), new RegExp(`«${t('period.filedShort')}»`), `${lang}: a filed quarter in the app's word`);
  }
});
