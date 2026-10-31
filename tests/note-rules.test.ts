/**
 * Rules from a sentence of a partner's notes (docs/0.4.0/knowledge.md "When the AI offers one", "The
 * sentence is marked"): code decides whether a sentence is offered as a rule, only as an ask rule,
 * or stays a note; a kept rule quotes its sentence (`note:`, `source: notes <date>`) and marks it on
 * the page; a changed sentence asks «Regel anpassen?» and changes nothing by itself; switching the
 * rule off or deleting it removes the mark, never the sentence.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, cpSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DEMO_ROOT } from './support/workspace.js';
import { parse } from 'yaml';
import { startApi, type ApiServer } from './support/api-server.js';
import { guessBooking, noteMarks, noteOffer, noteRuleProblems, openChoice, sentencesOf } from '../src/knowledge/note-rules.js';
import { notePath } from '../src/knowledge/notes.js';
import type { RuleRow } from '../src/booking/rule-book.js';
import type { RulePreview } from '../src/booking/rule-preview.js';
import type { DraftView, KeepResult, RulesView } from '../src/saving/rules.js';

const POST = 'knowledge/suppliers/swiss-post.yaml';
const COFFEE = 'knowledge/suppliers/gruenkaffee-muster.yaml';
const POST_SENTENCE = 'Wir buchen sie auf **6513 Porti und Versand** mit 8.1 % MWST, als «Post CH, Pakete Webshop» mit dem Monat.';
const SACKS = 'Jutesäcke und Verpackung, die sie manchmal mitliefert, gehören auf 4210 Verbrauchsmaterial Gastronomie, mit 8.1 %.';

const servers: ApiServer[] = [];
after(async () => { await Promise.all(servers.map((s) => s.stop())); });
/** The demo's books, chart, partner files and notes. */
async function start(): Promise<ApiServer> {
  const api = await startApi('demo');
  servers.push(api);
  cpSync(join(DEMO_ROOT, 'knowledge'), join(api.root, 'knowledge'), { recursive: true });
  mkdirSync(dirname(api.ws.paths.accounts), { recursive: true });
  copyFileSync(join(DEMO_ROOT, 'master-data/accounts.json'), api.ws.paths.accounts);
  return api;
}
const card = async (api: ApiServer, path: string) => (await api.send('GET', `/api/rules/draft?path=${encodeURIComponent(path)}`)).json as unknown as DraftView;
const keep = async (api: ApiServer, d: DraftView) => (await api.send('POST', '/api/rules/draft', { kind: 'keep', path: d.path, basis: d.basis, confirm: d.confirm })).json as unknown as KeepResult;
const rules = async (api: ApiServer) => ((await api.send('GET', '/api/rules')).json as unknown as RulesView).rules;

const row = (over: Omit<Partial<RuleRow>, 'note'> & { note?: string; then?: NonNullable<RuleRow['rule']>['then']; when?: NonNullable<RuleRow['rule']>['when'] } = {}): RuleRow => ({
  id: over.id ?? 'r', file: POST, step: 'booking.guide.yaml#classify', business: 'business' in over ? over.business : 'swiss-post', kind: 'rule', origin: 'notes', off: over.off ?? false,
  rule: { id: over.id ?? 'r', when: over.when ?? {}, then: over.then ?? { kind: 'book', booking: { account: '6513', vat: 'I81' } }, off: over.off ?? false, ...(over.note === undefined ? { note: 'Wir buchen sie auf 6513.' } : over.note ? { note: over.note } : {}) },
});
const clean: RulePreview = { key: 'k', year: '2026', matches: 3, examples: [], overlaps: [], loneWords: [], otherwise: 0 };

test('code offers a sentence as the rule, only as an ask rule, or keeps it a note', () => {
  assert.deepEqual(noteOffer(row(), clean, []), { offer: 'rule' }, 'one partner, nothing said yet, its payments booked as it would book them');
  assert.equal(noteOffer(row({ note: '' }), clean, []), undefined, 'a rule that quotes no sentence is not checked here');
  assert.deepEqual(noteOffer(row({ note: 'Meistens auf 6513, je nach Beleg.' }), clean, []), { offer: 'ask', why: [{ code: 'openChoice', words: ['Meistens', 'je nach Beleg'] }] });
  assert.deepEqual(noteOffer(row({ note: 'Meistens auf 6513.', then: { kind: 'ask', question: 'Porto?', booking: { account: '6513', vat: 'I81' } } }), clean, []), { offer: 'rule' }, 'an ask rule carries an open choice');
  assert.deepEqual(noteOffer(row(), { ...clean, otherwise: 2 }, []), { offer: 'note', why: [{ code: 'bookedOtherwise', n: 2 }] });
  assert.deepEqual(noteOffer(row(), { ...clean, otherwise: 2 }, [], true), { offer: 'rule', otherwise: 2 }, 'adjusted to a changed sentence: offered, keeping asks for confirmation');
  assert.deepEqual(noteOffer(row({ business: undefined, when: { text: 'Porto' } }), clean, []), { offer: 'note', why: [{ code: 'notOnePartner' }] });
  assert.deepEqual(noteOffer(row({ business: undefined, when: { payer: 'CH0000762011623852957' } }), clean, []), { offer: 'rule' }, 'a payer is one partner');
  const kept = row({ id: 'post-6513', note: '' });
  assert.deepEqual(noteOffer(row(), clean, [kept]), { offer: 'note', why: [{ code: 'alreadySaid', rule: 'post-6513' }] });
  assert.deepEqual(noteOffer(row(), clean, [{ ...kept, off: true }]), { offer: 'rule' }, 'a rule switched off says nothing');
  assert.deepEqual(noteOffer(row(), clean, [row({ id: 'narrow', note: '', when: { amount: { over: 500 } } })]), { offer: 'rule' }, 'a narrower rule does not say it for every payment');
  assert.deepEqual(openChoice('Treibstoff gehört auf 6200.'), []);
});

test('the lint knows a rule from the notes: a quoted sentence, executable, source notes <date>', () => {
  assert.deepEqual(noteRuleProblems({ then: { account: '6513', vat: 'I81' }, note: 'Wir buchen auf 6513.', source: 'notes 2026-10-21' }), []);
  assert.deepEqual(noteRuleProblems({ then: { account: '6513', vat: 'I81' }, source: 'wish 2026-10-21' }), []);
  assert.equal(noteRuleProblems({ then: { account: '6513', vat: 'I81' }, source: 'notes 2026-10-21' }).length, 1, 'source notes without the sentence');
  assert.equal(noteRuleProblems({ then: { account: '6513', vat: 'I81' }, note: 'Wir buchen auf 6513.', source: 'wish 2026-10-21' }).length, 1, 'a sentence with another source');
  assert.equal(noteRuleProblems({ then: 'auf 6513', note: 'Wir buchen auf 6513.', source: 'notes 2026-10-21' }).length, 1, 'a sentence on a rule in prose');
  assert.equal(noteRuleProblems({ then: { account: '6513', vat: 'I81' }, note: 42, source: 'notes 2026-10-21' }).length, 1, 'note is no sentence');
});

test('a sentence of the notes splits on its ends, and a first guess reads its account, rate and private share', () => {
  assert.deepEqual(sentencesOf('Den Kassenzettel fotografiert Anna. Ist er unleserlich, gilt trotzdem 8.1 % MWST.\n\n- Rohkaffee auf **4000 Rohkaffee**, mit 2.6 % MWST.'),
    ['Den Kassenzettel fotografiert Anna.', 'Ist er unleserlich, gilt trotzdem 8.1 % MWST.', 'Rohkaffee auf 4000 Rohkaffee, mit 2.6 % MWST.']);
  const accounts = { '6513': 'Porti', '6510': 'Telefon', '4000': 'Rohkaffee' };
  const codeFor = (rate: number, account: string) => (account.startsWith('4') ? `M${String(rate).replace('.', '')}` : `I${String(rate).replace('.', '')}`);
  assert.deepEqual(guessBooking(POST_SENTENCE, accounts, codeFor), { account: '6513', vat: 'I81' });
  assert.deepEqual(guessBooking('Rohkaffee auf 4000, mit 2.6 % MWST.', accounts, codeFor), { account: '4000', vat: 'M26' });
  assert.deepEqual(guessBooking('Das Natel auf 6510 mit 8.1 %, zur Hälfte privat.', accounts, codeFor), { account: '6510', vat: 'I81', private: 50 });
  assert.deepEqual(guessBooking('Das Natel auf 6510, 30 % privat.', accounts, codeFor), { account: '6510', private: 30 }, 'the private share is no rate');
  assert.deepEqual(guessBooking('Auf 9999 buchen.', accounts, codeFor), {}, 'no account of the chart');
});

test('«Als Regel vorschlagen»: a sentence whose payments are booked as it says is offered and kept with its sentence; the page marks it', async () => {
  const api = await start();
  const made = await api.send('POST', '/api/rules/note', { partner: 'swiss-post', sentence: POST_SENTENCE, then: { account: '6513', vat: 'I81' } });
  assert.deepEqual([made.status, made.json], [200, { path: POST }], JSON.stringify(made.json));
  const d = await card(api, POST);
  const added = d.added[0];
  assert.deepEqual([added.rule?.note, added.origin, d.offers[`${added.step}#${added.id}`], d.keepable], [POST_SENTENCE, 'notes', { offer: 'rule' }, true], JSON.stringify(d.offers));
  assert.ok(d.preview[0].matches > 0 && d.preview[0].otherwise === 0, 'the preview books the year\'s Post payments as they are booked today');
  assert.equal((await keep(api, d)).ok, true);

  const written = (parse(readFileSync(join(api.root, POST), 'utf8')).steps['booking.guide.yaml#classify'].rules as Array<Record<string, unknown>>).at(-1)!;
  assert.equal(written.note, POST_SENTENCE);
  assert.match(String(written.source), /^notes \d{4}-\d{2}-\d{2}$/);
  assert.match(readFileSync(join(api.root, POST), 'utf8'), /note: "Wir buchen sie auf/, 'the sentence is quoted in the file');

  const notes = readFileSync(join(api.root, notePath({ kind: 'partner', role: 'supplier', id: 'swiss-post' })), 'utf8');
  const listed = (await rules(api)).filter((r) => r.business === 'swiss-post');
  assert.deepEqual(noteMarks(notes, listed).marked.map((r) => r.id), [String(written.id)], 'the sentence carries the mark «führt die App aus»');

  const again = await api.send('POST', '/api/rules/note', { partner: 'swiss-post', sentence: POST_SENTENCE, then: { account: '6513', vat: 'I81' } });
  assert.equal(again.status, 200);
  const twice = await card(api, POST);
  assert.deepEqual([twice.offers[`${twice.added[0].step}#${twice.added[0].id}`], twice.keepable], [{ offer: 'note', why: [{ code: 'alreadySaid', rule: String(written.id) }] }, false], 'the same sentence again: a rule already says it');
  const refused = await keep(api, twice);
  assert.deepEqual([refused.ok, !refused.ok && refused.refusal], [false, 'note'], 'keeping refuses what code does not offer');
});

test('a sentence whose payments are booked otherwise stays a note, and one that leaves a choice open is offered only as an ask rule', async () => {
  const api = await start();
  await api.send('POST', '/api/rules/note', { partner: 'gruenkaffee-muster', sentence: SACKS, then: { account: '4210', vat: 'M81' } });
  const sacks = await card(api, COFFEE);
  const offer = sacks.offers[`${sacks.added[0].step}#${sacks.added[0].id}`];
  assert.ok(offer.offer === 'note' && offer.why.some((w) => w.code === 'bookedOtherwise' && w.n > 0) && offer.why.some((w) => w.code === 'openChoice'), JSON.stringify(offer));
  assert.equal(sacks.keepable, false);
  await api.send('POST', '/api/rules/draft', { kind: 'discard', path: COFFEE });

  const mostly = 'Die Post buchen wir meistens auf 6513 mit 8.1 %.';
  await api.send('POST', '/api/rules/note', { partner: 'swiss-post', sentence: mostly, then: { account: '6513', vat: 'I81' } });
  const d = await card(api, POST);
  const r = d.added[0];
  assert.deepEqual([d.offers[`${r.step}#${r.id}`], d.keepable], [{ offer: 'ask', why: [{ code: 'openChoice', words: ['meistens'] }] }, false]);
  const asked = await api.send('POST', '/api/rules/note', { partner: 'swiss-post', sentence: mostly, then: { account: '6513', vat: 'I81', ask: 'Stimmt «meistens auf 6513» für diese Zahlung?' }, replaces: r.id });
  assert.equal(asked.status, 200, JSON.stringify(asked.json));
  const ask = await card(api, POST);
  assert.deepEqual([ask.added.map((x) => [x.id, x.rule?.then.kind]), ask.offers[`${r.step}#${r.id}`], ask.keepable], [[[r.id, 'ask']], { offer: 'rule' }, true], 'as an ask rule it is offered');
});

test('a changed sentence asks «Regel anpassen?» and changes nothing by itself; switching the rule off removes the mark, never the sentence', async () => {
  const api = await start();
  await api.send('POST', '/api/rules/note', { partner: 'swiss-post', sentence: POST_SENTENCE, then: { account: '6513', vat: 'I81' } });
  assert.equal((await keep(api, await card(api, POST))).ok, true);
  const id = (await rules(api)).find((r) => r.rule?.note === POST_SENTENCE)!.id;
  const before = readFileSync(join(api.root, POST), 'utf8');

  const partner = (await api.send('GET', '/api/partners/swiss-post')).json as { note: { basis: string; text: string } };
  const edited = partner.note.text.replace('**6513 Porti und Versand**', '**6570 Versandsoftware**');
  const saved = await api.send('POST', '/api/notes', { kind: 'save', ref: { kind: 'partner', id: 'swiss-post' }, text: edited, basis: partner.note.basis });
  assert.equal(saved.status, 200, 'the notes save as before');
  assert.equal(readFileSync(join(api.root, POST), 'utf8'), before, 'the rule does not change by itself');

  const listed = (await rules(api)).filter((r) => r.business === 'swiss-post');
  const state = noteMarks(edited, listed);
  assert.deepEqual([state.marked, state.changed.map((c) => [c.row.id, c.now])], [[], [[id, 'Wir buchen sie auf 6570 Versandsoftware mit 8.1 % MWST, als «Post CH, Pakete Webshop» mit dem Monat.']]], 'the card asks with the new sentence');

  const adjust = await api.send('POST', '/api/rules/note', { partner: 'swiss-post', sentence: state.changed[0].now, then: { account: '6570', vat: 'I81' }, replaces: id });
  assert.equal(adjust.status, 200, JSON.stringify(adjust.json));
  const d = await card(api, POST);
  assert.deepEqual([d.added, d.changed.map((r) => [r.id, r.rule?.then, r.rule?.note]), d.before.map((r) => r.rule?.then)],
    [[], [[id, { kind: 'book', booking: { account: '6570', vat: 'I81' } }, state.changed[0].now]], [{ kind: 'book', booking: { account: '6513', vat: 'I81' } }]], 'the card shows the rule as it is and as the new sentence makes it');
  const changedKey = `${d.changed[0].step}#${id}`;
  assert.deepEqual([d.offers[changedKey].offer, d.keepable, d.confirm], ['rule', true, true], 'the person\'s adjustment is offered, and asks «Trotzdem behalten» for the payments booked otherwise');
  const unconfirmed = (await api.send('POST', '/api/rules/draft', { kind: 'keep', path: POST, basis: d.basis })).json as unknown as KeepResult;
  assert.deepEqual([unconfirmed.ok, !unconfirmed.ok && unconfirmed.refusal], [false, 'wide']);
  assert.equal(readFileSync(join(api.root, POST), 'utf8'), before, 'nothing changes without the person');
  await api.send('POST', '/api/rules/draft', { kind: 'discard', path: POST });

  const notesFile = join(api.root, notePath({ kind: 'partner', role: 'supplier', id: 'swiss-post' }));
  const now = (await api.send('GET', '/api/partners/swiss-post')).json as { note: { basis: string } };
  await api.send('POST', '/api/notes', { kind: 'save', ref: { kind: 'partner', id: 'swiss-post' }, text: partner.note.text, basis: now.note.basis });
  const notes = readFileSync(notesFile, 'utf8');
  assert.equal(noteMarks(notes, (await rules(api)).filter((r) => r.business === 'swiss-post')).marked.length, 1, 'the sentence back as it was: marked again');

  const off = await api.send('POST', '/api/rules', { kind: 'off', file: POST, step: 'booking.guide.yaml#classify', id });
  assert.equal(off.json.ok, true);
  const afterOff = noteMarks(readFileSync(notesFile, 'utf8'), (await rules(api)).filter((r) => r.business === 'swiss-post'));
  assert.deepEqual([afterOff.marked, afterOff.changed], [[], []], 'switched off: no mark, no question');
  assert.equal(readFileSync(notesFile, 'utf8'), notes, 'the sentence stays');

  await api.send('POST', '/api/rules', { kind: 'delete', file: POST, step: 'booking.guide.yaml#classify', id });
  assert.equal(readFileSync(notesFile, 'utf8'), notes, 'deleted: the sentence stays');
  assert.equal((await rules(api)).some((r) => r.id === id), false);
});
