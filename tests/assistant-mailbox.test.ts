/**
 * The AI sidebar sets up receipt collection itself (processes/receipt-collection.guide.yaml#setup):
 * a "mailbox" in its block drafts the source exactly as Firma › Quellen does, without a password;
 * its undo takes folder, switch and password away; the message tells the AI what collects now; the
 * map names the places in the person's language. And the hourly check that finds nothing due is
 * no run anyone sees. Each test names the wrong behaviour it catches.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.VANILLA_RUNS_DIR = mkdtempSync(join(tmpdir(), 'mailbox-runs-'));
process.env.VANILLA_APPROVALS_DIR = mkdtempSync(join(tmpdir(), 'mailbox-approvals-'));
const SECRETS = join(mkdtempSync(join(tmpdir(), 'mailbox-secrets-')), 'secrets.json');
writeFileSync(SECRETS, '{}');
process.env.VANILLA_SECRETS_FILE = SECRETS;

const { changesIn, ChangesError } = await import('../src/assistant/changes.js');
const { applyWorkspaceChange, withMailHosts } = await import('../src/server/workspace-edits.js');
const { approveSource, sources } = await import('../src/platform/sources/index.js');
const { collectionNow } = await import('../src/server/collection-now.js');
const { collectChannels } = await import('../src/platform/sources/ways.js');
const { appMap } = await import('../src/server/app-map.js');
const { assistantSystem } = await import('../src/assistant/claude.js');
const { openEngine } = await import('../src/workflows/engine.js');
const { runsDir } = await import('../src/workflows/store.js');
const { mailSecret, secrets } = await import('../src/secrets/secrets.js');
const { APP_ROOT, workspaceAt } = await import('../src/workspace/workspace.js');
const { DEMO_ROOT } = await import('./support/workspace.js');

const block = (changes: unknown[]) => `Fertig.\n\`\`\`vanilla-changes\n${JSON.stringify(changes)}\n\`\`\``;
const fresh = () => { const dir = mkdtempSync(join(tmpdir(), 'mailbox-')); cpSync(DEMO_ROOT, dir, { recursive: true }); return workspaceAt(dir); };
const books = { journalEntries: [] } as never;

test('a mailbox in the block is read as one; a password in it, or no address, is refused with a code', () => {
  assert.deepEqual(changesIn(block([{ kind: 'mailbox', address: ' belege@malerei.example ' }])), [{ kind: 'mailbox', address: 'belege@malerei.example' }]);
  assert.throws(() => changesIn(block([{ kind: 'mailbox', address: 'belege@malerei.example', password: 'x' }])), (e: unknown) => e instanceof ChangesError && e.refusal?.code === 'mailboxPassword', 'a password must never pass through the chat');
  assert.throws(() => changesIn(block([{ kind: 'mailbox', address: 'belege' }])), (e: unknown) => e instanceof ChangesError && e.refusal?.code === 'mailSourceField');
});

test('the AI drafts a mailbox as Firma › Quellen does: waiting to be switched on, no password anywhere; its undo leaves nothing behind', async () => {
  const ws = fresh();
  const [change] = await withMailHosts([{ kind: 'mailbox', address: 'belege@malerei.example', host: 'imap.malerei.example' }]);
  assert.equal(change.kind === 'mailbox' && change.host, 'imap.malerei.example', 'a host the answer names is kept, no DNS asked');
  const made = applyWorkspaceChange(ws, books, change as never);
  assert.deepEqual(made, { undo: { kind: 'dropMailbox', id: 'belege-malerei-example' }, note: { mailbox: { id: 'belege-malerei-example' } } });
  const yaml = readFileSync(join(ws.paths.root, 'sources', 'belege-malerei-example', 'source.yaml'), 'utf8');
  assert.match(yaml, /code: app:imap/);
  assert.match(yaml, /host: imap\.malerei\.example/);
  assert.match(yaml, /every: daily/);
  const v = sources(ws, APP_ROOT).find((x) => x.kind !== 'invalid' && x.decl.id === 'belege-malerei-example');
  assert.equal(v?.kind, 'pending', 'the AI cannot switch a source on: the person does');

  assert.deepEqual(applyWorkspaceChange(ws, books, change as never), { note: { mailbox: { id: 'belege-malerei-example', existing: true } } }, 'the same mailbox again is not a second source');

  // The person switched it on and stored a password on the card; the undo takes all of it back.
  if (v?.kind === 'pending') approveSource(ws, v.decl);
  await secrets.set(mailSecret('belege-malerei-example'), 'app-pass');
  applyWorkspaceChange(ws, books, made.undo!);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(existsSync(join(ws.paths.root, 'sources', 'belege-malerei-example')), false);
  assert.equal(await secrets.get(mailSecret('belege-malerei-example')), undefined, 'its password goes with it');
  applyWorkspaceChange(ws, books, change as never);
  assert.equal(sources(ws, APP_ROOT).find((x) => x.kind !== 'invalid' && x.decl.id === 'belege-malerei-example')?.kind, 'pending', 'drafted again, it waits to be switched on anew: the old switch went with the undo');
});

test('a mailbox whose server nobody named or found is refused with its domain, so the AI asks for it', () => {
  assert.throws(() => applyWorkspaceChange(fresh(), books, { kind: 'mailbox', address: 'x@nowhere.example' }), (e: { refusal?: { code: string; params?: unknown } }) => e.refusal?.code === 'mailHostUnknown' && JSON.stringify(e.refusal.params) === '{"domain":"nowhere.example"}');
});

test('the message tells the AI what collects now: nothing, or each source with its switch, its password and its cadence, in the person\'s words', async () => {
  const ws = fresh();
  const none = await collectionNow(ws, 'de');
  assert.match(none, /no source is connected yet/);
  assert.match(none, /the phone: not switched on/);
  applyWorkspaceChange(ws, books, { kind: 'mailbox', address: 'belege@malerei.example', host: 'imap.malerei.example' });
  const one = await collectionNow(ws, 'de');
  assert.match(one, /mailbox belege@malerei\.example on imap\.malerei\.example/);
  assert.match(one, /a draft waiting for «Einschalten»/);
  assert.match(one, /password missing/);
  assert.match(one, /fetched daily/, 'a mailbox is fetched daily, checked hourly: the AI must not say otherwise');
  assert.match(await collectionNow(ws, 'en'), /waiting for «Switch on»/);
  const ways = one.slice(one.indexOf('The channels a source can reach'), one.indexOf('What the app can see'));
  assert.match(ways, /most preferred first/);
  assert.doesNotMatch(ways, /coming|not ready|doesn't work/i, 'the AI must never be told to call a way coming (owner, 2026-10-20)');
  const listed = collectChannels(APP_ROOT);
  listed.forEach((c, i) => {
    const line = ways.split('\n').find((l) => l.startsWith(`${i + 1}. ${c.id}:`));
    assert.ok(line, `${c.id} listed in its place of preference`);
    assert.ok(line.endsWith(c.available ? 'available here' : 'never offer or mention it; propose an available one that fits'), `${c.id}: offered only when the app serves it here`);
  });
  assert.match(one, /What the app can see about how the person handles mail/, 'the evidence goes with the state');
});

test('the channels come most preferred first (API, the mailbox\'s server, the mail program, the browser last); each is available only where this app serves it', () => {
  const all = { macMail: true, ownCode: true, chrome: true };
  assert.deepEqual(collectChannels(APP_ROOT, all).map((c) => c.id), ['api', 'mail', 'mac-mail', 'web'], 'the owner\'s order of preference (2026-10-20)');
  assert.ok(collectChannels(APP_ROOT, all).every((c) => c.available), 'everything served on a Mac with Chrome under npm start');
  const at = (here: Partial<typeof all>, id: string) => collectChannels(APP_ROOT, { ...all, ...here }).find((c) => c.id === id)!.available;
  assert.equal(at({ macMail: false }, 'mac-mail'), false, 'the Mail app\'s channel only where osascript can reach Mail');
  assert.equal(at({ chrome: false }, 'web'), false, 'a browser session only with a Chromium browser');
  assert.equal(at({ ownCode: false }, 'web'), false, 'a browser source is the workspace\'s own code, which the Mac app does not run yet');
  assert.equal(at({ ownCode: false }, 'api'), false);
  assert.equal(at({ ownCode: false }, 'mac-mail'), true, 'the app\'s own Mail code runs in the Mac app');
  assert.equal(collectChannels(APP_ROOT, all).find((c) => c.id === 'mac-mail')?.bind, 'mail-client', 'Apple Mail binds the app\'s code: the AI drafts it as a source');
  for (const c of collectChannels(APP_ROOT, all)) assert.ok(c.needs && c.fits, `${c.id} says what it needs and where it fits`);
});

test('the map names collection\'s places in the person\'s language and lets the AI connect a mailbox', () => {
  const de = appMap('de');
  assert.match(de, /Firma › Quellen/);
  assert.match(de, /Firma › Handy/);
  assert.match(de, /«Postfach verbinden»/);
  assert.match(de, /a mailbox is fetched daily: Automatisierung checks every hour/);
  assert.match(de, /You: mailbox, source\./);
  assert.doesNotMatch(de, /you cannot connect one/);
  const en = appMap('en');
  assert.match(en, /Company › Sources/);
  assert.doesNotMatch(en, /Firma|Automatisierung/, 'no German place name in an English map');
});

test('the AI is told to set collection up itself, by the guide, without a password in the chat', () => {
  const system = assistantSystem('de', '2850 Privat', appMap('de'));
  assert.match(system, /processes\/receipt-collection\.guide\.yaml/);
  assert.match(system, /\{"kind":"mailbox","address":"belege@firma\.ch"\}/);
  assert.match(system, /Never ask for, take or repeat a password, key or token in the chat, and never write one into a source's files/);
  assert.match(system, /not technical unless they show otherwise/);
  assert.match(system, /when the person has its access data \(server and password\), or can make them \(an app password at their provider\), the mailbox's server is preferred/);
  assert.match(system, /Hast du die Zugangsdaten zu deinem Postfach/);
  assert.match(system, /Never send the person to the settings for what you can draft/);
  assert.match(system, /by hand in Firma › Quellen/);
});

test('the AI finds out first: it opens with what it found and a question, never a recommendation, and recommends Apple Mail only with a sign', () => {
  const system = assistantSystem('de', '2850 Privat', appMap('de'));
  const steps = ['(1) Read «What the app can see about how the person handles mail»', '(2) Open with what you found', '(3) Ask only what the evidence leaves open, one question at a time', '(4) Only then propose the way that fits', '(5) Build what you proposed', '(6) Before it is switched on, the person sees what it would read'];
  let at = -1;
  for (const s of steps) { const i = system.indexOf(s); assert.ok(i > at, `step in its place: ${s}`); at = i; }
  assert.match(system, /Never open with a recommendation or a way/);
  assert.match(system, /the order of preference decides only among the channels that fit what you found/);
  assert.match(system, /Apple Mail only with a sign/);
  assert.match(system, /asked as a question \(«Liest du deine Mails in Apple Mail\?»\), never recommended/);
  assert.doesNotMatch(system, /in the order the message lists them|non-technical first|the first available one first/, 'the old fixed order is gone');
});

test('the AI never calls a way coming or not working: it proposes an available one and makes it work with the person (owner, 2026-10-20)', () => {
  const system = assistantSystem('de', '2850 Privat', appMap('de'));
  assert.match(system, /Never tell the person that a way does not work, is not ready or is coming/);
  assert.match(system, /make it work together with them/);
  assert.doesNotMatch(system, /named as coming|say it is coming|can't be set up yet|never offered as working/, 'the wording that made the AI say «coming» is gone');
});

test('a conversation with a purpose stays on it: the AI is told not to bring up unrelated open work, not even at the end', () => {
  const system = assistantSystem('de', '2850 Privat', appMap('de'));
  assert.match(system, /A conversation with a purpose[^.]*stays on that purpose: never bring up open tasks[^.]*unless the person asks, not even one short mention at the end/);
});

test('the hourly check that finds no source due is no run: not kept, not listed; one a person starts is', async () => {
  const ws = fresh();
  const engine = openEngine(() => ws, { appRoot: APP_ROOT });
  await engine.tick(new Date('2026-10-19T20:00:00'));
  await engine.idle();
  assert.deepEqual(engine.runs().filter((r) => r.workflow === 'collection').map((r) => r.id), [], '«Letzter Lauf» must not show an hourly check that fetched nothing');
  assert.equal(existsSync(runsDir(ws)) ? readdirSync(runsDir(ws)).length : 0, 0, 'nor its file, 24 a day');
  await engine.start('collection', { kind: 'company', id: 'company' }, { kind: 'manual' });
  await engine.idle();
  assert.equal(engine.runs().filter((r) => r.workflow === 'collection').length, 1);
});
