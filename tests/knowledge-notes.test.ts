/**
 * The notes of Geschäftspartner and Wissen (src/knowledge/notes.ts, POST /api/notes): a partner's
 * notes beside its file, a topic with its title and steps in front matter; a save answers the text
 * before and after and is saved in git at once, an undo puts the file back, and a save or undo over
 * a file that changed since is refused. A partner's empty notes remove the file, a new topic needs a
 * title and never takes a slug of Wissen's own pages. The lint knows whose each file is. Audit mode
 * writes nothing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APP_FOLDER, workspaceAt } from '../src/workspace/workspace.js';
import { initRepository } from '../src/workspace/git.js';
import { basisOf, joinNote, lastChange, listTopics, notesProblems, readNote, restoreNote, saveNote, splitNote, topicSlugOf } from '../src/knowledge/notes.js';
import { DEMO_ROOT } from './support/workspace.js';
import { startApi } from './support/api-server.js';

process.env.GIT_AUTHOR_NAME = 'Erika Beispiel';
process.env.GIT_AUTHOR_EMAIL = 'erika@example.com';
process.env.GIT_COMMITTER_NAME = 'Erika Beispiel';
process.env.GIT_COMMITTER_EMAIL = 'erika@example.com';

const PARTNER = { kind: 'partner', role: 'supplier', id: 'gruenkaffee-muster' } as const;

async function company() {
  const repo = mkdtempSync(join(tmpdir(), 'notes-'));
  cpSync(DEMO_ROOT, join(repo, APP_FOLDER), { recursive: true });
  await initRepository(repo, 'Workspace set up');
  return { ws: workspaceAt(join(repo, APP_FOLDER)), git: (...a: string[]) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' }).trim() };
}

test('a notes file splits into its front matter and its prose, and joins back to the same text', () => {
  const raw = '---\ntitle: Fahrzeug und Privatanteil\nsteps:\n  - booking#private\n---\n\nDer Lieferwagen ist ein Firmenwagen.\n\n- Treibstoff auf 6200\n';
  const n = splitNote(raw);
  assert.deepEqual([n.title, n.steps, n.text], ['Fahrzeug und Privatanteil', ['booking#private'], 'Der Lieferwagen ist ein Firmenwagen.\n\n- Treibstoff auf 6200']);
  assert.equal(joinNote(n.head, n.text), raw);
  assert.deepEqual(splitNote('Nur Prosa, kein Kopf.\n'), { steps: [], text: 'Nur Prosa, kein Kopf.', head: '' });
  assert.equal(splitNote('---\nkein: [yaml\n---\nText').text, '---\nkein: [yaml\n---\nText', 'a head that does not parse stays prose');
  assert.equal(joinNote('title: Leer', ''), '---\ntitle: Leer\n---\n');
});

test('a topic saved keeps its front matter as the author wrote it; a new title changes only the title (#63)', async () => {
  const { ws } = await company();
  const ref = { kind: 'topic', slug: 'fahrzeug' } as const;
  const file = join(ws.paths.root, 'knowledge/company/fahrzeug.md');
  const head = '---\ntitle: Fahrzeug und Privatanteil # wie im Fahrtenbuch\nsteps: [booking#eigenverbrauch, booking#private]\nseit:   2026\n---\n\n';
  writeFileSync(file, `${head}Alt.\n`);
  const saved = saveNote(ws, ref, 'Neu.', readNote(ws, ref)!.basis, 'Fahrzeug und Privatanteil');
  assert.ok(saved.ok);
  assert.equal(readFileSync(file, 'utf8'), `${head}Neu.\n`, 'flow list, comment and spacing stay byte for byte');
  const renamed = saveNote(ws, ref, 'Neu.', readNote(ws, ref)!.basis, 'Lieferwagen');
  assert.ok(renamed.ok);
  assert.equal(readFileSync(file, 'utf8'), '---\ntitle: Lieferwagen # wie im Fahrtenbuch\nsteps: [booking#eigenverbrauch, booking#private]\nseit: 2026\n---\n\nNeu.\n', 'a new title keeps the flow list and the comment');
});

test('a save writes the notes and answers before and after; an undo puts them back; a stale basis is refused', async () => {
  const { ws } = await company();
  const before = readNote(ws, PARTNER)!;
  assert.match(before.text, /^Grünkaffee Muster AG liefert/, 'the demo ships the partner\'s notes');
  const saved = saveNote(ws, PARTNER, 'Neu geschrieben.', before.basis);
  assert.ok(saved.ok);
  assert.equal(saved.write.after, 'Neu geschrieben.\n');
  assert.equal(readFileSync(join(ws.paths.root, 'knowledge/suppliers/gruenkaffee-muster.md'), 'utf8'), 'Neu geschrieben.\n');
  assert.deepEqual(saveNote(ws, PARTNER, 'Darüber', before.basis), { ok: false, refusal: 'changed' }, 'the page the person saw is gone: refused');
  assert.ok(restoreNote(ws, PARTNER, saved.write.before, saved.write.after), 'undone');
  assert.equal(readNote(ws, PARTNER)!.basis, before.basis);
  assert.equal(restoreNote(ws, PARTNER, null, 'anders'), undefined, 'an undo over a changed file takes nothing back');
});

test('a partner\'s empty notes remove the file; a topic keeps its title, a new one needs one', async () => {
  const { ws } = await company();
  const n = readNote(ws, PARTNER)!;
  const gone = saveNote(ws, PARTNER, '  \n', n.basis);
  assert.ok(gone.ok && gone.write.after === null);
  assert.equal(existsSync(join(ws.paths.root, 'knowledge/suppliers/gruenkaffee-muster.md')), false);
  assert.deepEqual(saveNote(ws, { kind: 'topic', slug: 'neu' }, 'Text', basisOf(null)), { ok: false, refusal: 'title' });
  const made = saveNote(ws, { kind: 'topic', slug: 'neu' }, '', basisOf(null), 'Neue Seite');
  assert.ok(made.ok);
  const topic = readNote(ws, { kind: 'topic', slug: 'fahrzeug' })!;
  const kept = saveNote(ws, { kind: 'topic', slug: 'fahrzeug' }, 'Anders.', topic.basis);
  assert.ok(kept.ok);
  assert.deepEqual([readNote(ws, { kind: 'topic', slug: 'fahrzeug' })!.title, readNote(ws, { kind: 'topic', slug: 'fahrzeug' })!.steps], ['Fahrzeug und Privatanteil', ['booking#eigenverbrauch', 'booking#private']], 'the front matter stays');
  assert.deepEqual(listTopics(ws).map((x) => x.slug), ['belege-sammeln', 'fahrzeug', 'mwst-abrechnung', 'neu']);
});

test('a new topic\'s slug comes from its title, never one taken and never one of Wissen\'s pages', () => {
  const taken = new Set(['fahrzeug']);
  assert.equal(topicSlugOf('Fahrzeug', (s) => taken.has(s)), 'fahrzeug-2');
  assert.equal(topicSlugOf('Privates, Spesen & Bargeld', () => false), 'privates-spesen-bargeld');
  assert.equal(topicSlugOf('Gaps', () => false), 'gaps-seite');
  assert.equal(topicSlugOf('App', () => false), 'app-seite');
});

test('the lint names notes of no partner, in the wrong folder, a topic without a title or with a step that does not exist', async () => {
  const { ws } = await company();
  const partners = new Map([['gruenkaffee-muster', 'supplier' as const], ['swiss-post', 'supplier' as const], ['coop-pronto', 'supplier' as const], ['cu_1', 'customer' as const]]);
  const steps = new Set(['booking#private', 'booking#eigenverbrauch', 'receipt-collection#triage']);
  assert.deepEqual(notesProblems(ws, partners, (s) => steps.has(s)), [], 'the demo\'s notes pass');
  mkdirSync(join(ws.paths.root, 'knowledge/customers'), { recursive: true });
  writeFileSync(join(ws.paths.root, 'knowledge/customers/niemand.md'), 'x');
  writeFileSync(join(ws.paths.root, 'knowledge/customers/swiss-post.md'), 'x');
  writeFileSync(join(ws.paths.root, 'knowledge/company/ohne-titel.md'), 'Nur Text');
  writeFileSync(join(ws.paths.root, 'knowledge/company/falsch.md'), '---\ntitle: Falsch\nsteps: [booking#gibts-nicht]\n---\nText');
  const problems = notesProblems(ws, partners, (s) => steps.has(s));
  assert.equal(problems.length, 4, problems.join('\n'));
  assert.match(problems.join('\n'), /niemand\.md: no partner/);
  assert.match(problems.join('\n'), /customers\/swiss-post\.md: swiss-post is filed under suppliers/);
  assert.match(problems.join('\n'), /ohne-titel\.md: needs a title/);
  assert.match(problems.join('\n'), /falsch\.md: steps: "booking#gibts-nicht"/);
});

test('POST /api/notes saves at once as the person\'s save, with who and when; undo, a stale page, an unknown partner and audit mode are refused or answered', async () => {
  const api = await startApi('demo/vanilla-accounting');
  cpSync(DEMO_ROOT, api.root, { recursive: true, filter: (src) => !src.endsWith('belege.workspace.yaml') });
  await initRepository(api.root, 'Workspace set up');
  try {
    const page = await api.send('GET', '/api/partners/gruenkaffee-muster');
    assert.equal(page.status, 200, JSON.stringify(page.json));
    const note = page.json.note as { basis: string; path: string; last?: { by: string } };
    assert.equal(note.path, 'knowledge/suppliers/gruenkaffee-muster.md');
    assert.equal(note.last?.by, 'Erika Beispiel', 'who changed the notes last, from git');
    const saved = await api.send('POST', '/api/notes', { kind: 'save', ref: { kind: 'partner', id: 'gruenkaffee-muster' }, text: 'Kurz.', basis: note.basis });
    assert.equal(saved.status, 200, JSON.stringify(saved.json));
    assert.deepEqual([saved.json.after, saved.json.committed, (saved.json.ref as { role: string }).role], ['Kurz.\n', true, 'supplier']);
    const subject = execFileSync('git', ['-C', api.root, 'log', '-1', '--format=%s%n%b'], { encoding: 'utf8' });
    assert.match(subject, /^Notizen geändert: gruenkaffee-muster\nVanilla-Kind: customizing/);
    const stale = await api.send('POST', '/api/notes', { kind: 'save', ref: { kind: 'partner', id: 'gruenkaffee-muster' }, text: 'Nochmals', basis: note.basis });
    assert.deepEqual([stale.status, stale.json.code], [409, 'notesChanged']);
    const undo = await api.send('POST', '/api/notes', { kind: 'restore', ref: { kind: 'partner', id: 'gruenkaffee-muster' }, text: saved.json.before, now: saved.json.after });
    assert.equal(undo.status, 200, JSON.stringify(undo.json));
    assert.match(readFileSync(join(api.root, note.path), 'utf8'), /^Grünkaffee Muster AG liefert/);
    const unknown = await api.send('POST', '/api/notes', { kind: 'save', ref: { kind: 'partner', id: 'gibts-nicht' }, text: 'x', basis: 'none' });
    assert.deepEqual([unknown.status, unknown.json.code], [404, 'partnerGone']);
    const wrongRef = await api.send('POST', '/api/notes', { kind: 'save', ref: { kind: 'partner', id: '../ledger' }, text: 'x', basis: 'none' });
    assert.equal(wrongRef.status, 400, 'a path is no partner id');
    const page2 = await api.send('POST', '/api/notes', { kind: 'save', ref: { kind: 'topic' }, text: '', basis: 'none', title: 'Privates und Bargeld' });
    assert.equal((page2.json.ref as { slug: string }).slug, 'privates-und-bargeld');
    assert.equal((await api.send('GET', '/api/knowledge/topics/privates-und-bargeld')).status, 200);
    assert.equal((await api.send('GET', '/api/knowledge/topics/gaps')).status, 404, 'a page of Wissen is no topic');
  } finally {
    await api.stop();
  }
  const audit = await startApi('demo/vanilla-accounting', { READONLY: '1' });
  try {
    const r = await audit.send('POST', '/api/notes', { kind: 'save', ref: { kind: 'topic' }, text: '', basis: 'none', title: 'X' });
    assert.deepEqual([r.status, r.json.code], [403, 'readonly'], 'audit mode writes no notes');
  } finally {
    await audit.stop();
  }
});

test('the last change of a notes file comes from git, none before its first save', async () => {
  const { ws, git } = await company();
  assert.equal((await lastChange(ws, 'knowledge/suppliers/gruenkaffee-muster.md'))?.commit, git('rev-parse', 'HEAD'));
  assert.equal(await lastChange(ws, 'knowledge/suppliers/gibts-nicht.md'), undefined);
});
