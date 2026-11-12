/**
 * npm run init and npm run doctor: a workspace made without a terminal opens, passes doctor, and a
 * rerun changes nothing; an answer the app does not support stops with its explanation; the UID
 * check digit and the chart's rules are checked.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { chartFor, ChartError, KMU_CHART, loadChart } from '../src/workspace/chart.js';
import { PRESETS, PRESET_NAMES, QUESTIONS, QUESTION_ORDER, isSupported, profileOf, type Answers } from '../src/workspace/setup.js';
import { parseUid } from '../src/workspace/uid.js';
import { APP_FOLDER, APP_ROOT, MANIFEST_FILE, WorkspaceError, workspaceAt, workspacePaths, yearPaths } from '../src/workspace/workspace.js';
import { loadBooks, saveBooks } from '../src/books/store.js';
import { testIban, withTestIbans } from './support/iban.js';

// A UID with a wrong check digit, written in parts so the leak guard does not take it for a real one.
const TYPO_UID = ['CHE-153', '004', '185'].join('.');
const tmp = () => mkdtempSync(join(tmpdir(), 'belege-init-'));

/** A PATH whose claude answers like a logged-in, installed tool, without a model call. */
function stubTools(): string {
  const bin = tmp();
  writeFileSync(join(bin, 'claude'), '#!/bin/sh\nif [ "$1" = auth ]; then echo \'{"loggedIn":true}\'; else echo "9.9.9 (Claude Code)"; fi\n');
  chmodSync(join(bin, 'claude'), 0o755);
  return bin;
}

const GIT_ID = { GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' };

function cli(script: string, args: string[], path?: string, env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, ['--import', 'tsx', join(APP_ROOT, 'src/cli', script), ...args], {
    cwd: APP_ROOT, input: '', encoding: 'utf8',
    env: { ...process.env, ...GIT_ID, VANILLA_WORKSPACE: '', ...(path ? { PATH: `${path}:${process.env.PATH}` } : {}), ...env },
  });
  return { code: r.status, out: r.stdout + r.stderr };
}

const consultant = (dir: string, envFile: string, ...more: string[]) => [
  '--preset', 'consultant', '--dir', dir, '--name', 'Beispiel Beratung GmbH', '--uid', 'CHE-153.004.184',
  '--owner', 'Erika Beispiel', '--language', 'fr', '--bank', 'UBS:CHF', '--bank', 'Wise:EUR', '--app-env', envFile, '--yes', ...more,
];

test('UID: canonical form from spacing and suffix; a wrong check digit or shape is refused', () => {
  assert.deepEqual(parseUid('CHE-153.004.184'), { uid: 'CHE-153.004.184' });
  assert.deepEqual(parseUid('che 153 004 184 MWST'), { uid: 'CHE-153.004.184' });
  assert.deepEqual(parseUid('CHE447613666'), { uid: 'CHE-447.613.666' });
  assert.match((parseUid(TYPO_UID) as { error: string }).error, /wrong check digit/);
  assert.match((parseUid('153.004.184') as { error: string }).error, /not a UID/);
});

test('chart: profile and legal form pick the accounts; a rule broken in the file fails at load', () => {
  const chart = loadChart();
  const numbers = (accounts: { number: string }[]) => new Set(accounts.map((a) => a.number));
  const services = numbers(chartFor(chart, 'services', 'GmbH'));
  const goods = numbers(chartFor(chart, 'goods', 'GmbH'));
  assert.ok(services.has('3400') && services.has('5000') && services.has('5720') && services.has('6570') && services.has('2451'));
  assert.ok(!services.has('3200') && !services.has('1200') && !services.has('2850'));
  assert.ok(goods.has('3200') && goods.has('1200') && goods.has('1093') && !goods.has('1280'));
  const einzelfirma = chartFor(chart, 'both', 'Einzelfirma');
  assert.equal(einzelfirma.find((a) => a.number === '2800')?.name, 'Eigenkapital');
  assert.ok(numbers(einzelfirma).has('2850') && !numbers(einzelfirma).has('2451') && !numbers(einzelfirma).has('8900'));
  assert.equal(chartFor(chart, 'services', 'AG').find((a) => a.number === '2800')?.name, 'Aktienkapital');
  for (const a of chartFor(chart, 'both', 'GmbH')) assert.ok(chart.lines[a.line], `${a.number} has a known line`);

  const dir = tmp();
  const bad = readFileSync(KMU_CHART, 'utf8').replace('{ number: "3400", name: Dienstleistungserlöse, type: revenue', '{ number: "3400", name: Dienstleistungserlöse, type: asset');
  writeFileSync(join(dir, 'chart.yaml'), bad);
  assert.throws(() => loadChart(join(dir, 'chart.yaml')), (e: Error) => e instanceof ChartError && /3400: a asset account must be in class 1/.test(e.message));
  rmSync(dir, { recursive: true, force: true });
});

test('preset trades: a small Swiss trades GmbH, fully supported, with the chart it needs', () => {
  assert.deepEqual(PRESETS.trades.answers, {
    legalForm: 'GmbH', vatRegistered: 'yes', vatMethod: 'effective', basis: 'received', period: 'quarterly',
    fiscalYear: 'calendar', start: 'new', sells: ['made', 'services'], foreignCustomers: 'no', imports: 'no',
    employees: 'staff', ownerPaysPrivately: 'yes', privateUse: ['car', 'phone'], payouts: 'no',
  });
  assert.ok(isSupported(PRESETS.trades.answers as unknown as Answers), 'every answer is one the engine runs on');
  assert.deepEqual(PRESET_NAMES, ['consultant', 'webshop', 'trades', 'freelancer', 'custom']);
  const numbers = new Set(chartFor(loadChart(), profileOf(PRESETS.trades.answers.sells), 'GmbH').map((a) => a.number));
  for (const n of ['3000', '3400', '4000', '4400', '5000', '2451']) assert.ok(numbers.has(n), `${n} is in the trades chart`);
});

test('init without a terminal: the workspace opens, doctor passes, a rerun changes nothing', () => {
  const base = tmp();
  const dir = join(base, 'books');
  const envFile = join(base, 'app.env');
  const bin = stubTools();

  // No program on the PATH: the workspace and its git repository are made by the app alone.
  const first = cli('init.ts', consultant(dir, envFile), undefined, { PATH: '/nonexistent' });
  assert.equal(first.code, 0, first.out);
  assert.match(first.out, /Committed the workspace to a new git repository/);

  const ws = workspaceAt(dir);
  assert.equal(ws.paths.root, join(dir, APP_FOLDER), 'the books lie in the repository\'s vanilla-accounting/');
  assert.equal(ws.company.uid, 'CHE-153.004.184');
  assert.equal(ws.company.legalForm, 'GmbH');
  assert.equal(ws.company.language, 'fr');
  assert.deepEqual(ws.profile?.sells, ['services']);
  assert.equal(parse(readFileSync(ws.paths.manifest, 'utf8')).profile.sells, 'services', 'the manifest keeps the answer as it always did');
  assert.equal(ws.profile?.ownerPaysPrivately, 'yes');
  assert.deepEqual(ws.bankAccounts.map((a) => `${a.bank} ${a.currency} ${a.account} ${a.statements ?? '-'}`), [
    'UBS CHF 1020 camt053', 'Wise EUR 1021 wise', 'manual CHF 2451 -',
  ]);
  const accounts = JSON.parse(readFileSync(ws.paths.accounts, 'utf8')) as { number: string; name: string; type: string }[];
  assert.deepEqual(accounts.filter((a) => ['1020', '1021', '1022', '2451'].includes(a.number)).map((a) => a.name), ['UBS CHF', 'Wise EUR', 'Bankguthaben USD', 'Kontokorrent Gesellschafter']);
  assert.deepEqual(loadBooks(ws).config, {}, 'no closedThrough');
  const year = yearPaths(ws.paths, new Date().toISOString().slice(0, 4));
  for (const d of [year.receipts, ws.paths.inbox, year.filings, join(year.statements, 'UBS'), join(year.statements, 'Wise'), ...['suppliers', 'customers', 'authorities', 'rules'].map((k) => join(ws.paths.root, 'knowledge', k))]) {
    assert.ok(existsSync(d), d);
  }
  assert.match(readFileSync(join(dir, 'AGENTS.md'), 'utf8'), /read `vanilla-accounting\/AGENTS\.md`/);
  assert.equal(readFileSync(envFile, 'utf8'), `VANILLA_WORKSPACE=${dir}\n`);
  const log = spawnSync('git', ['log', '--oneline'], { cwd: dir, encoding: 'utf8' }).stdout.trim().split('\n');
  assert.equal(log.length, 1, 'one first commit');

  const doctor = cli('doctor.ts', ['--workspace', dir], bin);
  assert.equal(doctor.code, 0, doctor.out);
  assert.match(doctor.out, /✓ claude is logged in/);
  assert.doesNotMatch(doctor.out, /✗/);

  const manifestBefore = statSync(ws.paths.manifest).mtimeMs;
  const again = cli('init.ts', consultant(dir, envFile));
  assert.equal(again.code, 0, again.out);
  assert.match(again.out, /already a workspace: nothing to change/);
  assert.match(again.out, /already points at this workspace/);
  assert.equal(statSync(ws.paths.manifest).mtimeMs, manifestBefore);
  assert.equal(spawnSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' }).stdout, '', 'nothing changed');

  rmSync(base, { recursive: true, force: true });
  rmSync(bin, { recursive: true, force: true });
});

test('init keeps a VANILLA_WORKSPACE that points elsewhere unless told to replace it', () => {
  const base = tmp();
  const envFile = join(base, 'app.env');
  writeFileSync(envFile, 'OTHER=1\nVANILLA_WORKSPACE=../older-books\n');
  const kept = cli('init.ts', consultant(join(base, 'a'), envFile));
  assert.equal(kept.code, 0, kept.out);
  assert.match(kept.out, /still points at \.\.\/older-books/);
  assert.equal(readFileSync(envFile, 'utf8'), 'OTHER=1\nVANILLA_WORKSPACE=../older-books\n');
  assert.equal(cli('init.ts', consultant(join(base, 'b'), envFile, '--set-env')).code, 0);
  assert.equal(readFileSync(envFile, 'utf8'), `OTHER=1\nVANILLA_WORKSPACE=${join(base, 'b')}\n`);
  rmSync(base, { recursive: true, force: true });
});

test('a freelancer not registered for VAT and a firm on the net tax rate method are set up; the net rate is asked for', () => {
  const base = tmp();
  const envFile = join(base, 'app.env');
  const salon = cli('init.ts', ['--preset', 'freelancer', '--dir', join(base, 'salon'), '--name', 'Salon Beispiel', '--uid', 'CHE-153.004.184', '--owner', 'Bella Beispiel', '--bank', 'UBS:CHF', '--app-env', envFile, '--yes']);
  assert.equal(salon.code, 0, salon.out);
  assert.match(salon.out, /booked gross, without VAT codes/);
  const salonWs = workspaceAt(join(base, 'salon'));
  assert.deepEqual(salonWs.company.vat, { registered: false });
  assert.equal(salonWs.filingLength, 'quarter');
  assert.match(readFileSync(salonWs.paths.manifest, 'utf8'), /vat:\n\s+registered: false\n/);

  const noRate = cli('init.ts', [...consultant(join(base, 'a'), envFile), '--vat-method', 'net-rate', '--period', 'half-yearly']);
  assert.equal(noRate.code, 1);
  assert.match(noRate.out, /--net-rate/);
  assert.ok(!existsSync(join(base, 'a')), 'nothing written without the rate');

  const schreinerei = cli('init.ts', [...consultant(join(base, 'b'), envFile), '--vat-method', 'net-rate', '--period', 'half-yearly', '--net-rate', '4.5:Schreinerei']);
  assert.equal(schreinerei.code, 0, schreinerei.out);
  const ws = workspaceAt(join(base, 'b'));
  assert.deepEqual(ws.company.vat, { registered: true, method: 'net-rate', reporting: 'received', period: 'half-yearly', rates: [{ rate: 4.5, label: 'Schreinerei' }] });
  assert.equal(ws.filingLength, 'half');

  // «we file no VAT returns» beside the method (#347): «no» to the registration, the basis and the period not asked.
  const noVat = cli('init.ts', [...consultant(join(base, 'd'), envFile), '--vat-method', 'no-vat', '--net-rate', '4.5:Schreinerei']);
  assert.equal(noVat.code, 0, noVat.out);
  assert.match(noVat.out, /--net-rate is ignored/, 'a flag it drops is said, never dropped silently');
  assert.match(noVat.out, /booked gross, without VAT codes/);
  const noVatWs = workspaceAt(join(base, 'd'));
  assert.deepEqual(noVatWs.company.vat, { registered: false });
  assert.equal(noVatWs.company.legalForm, 'GmbH');

  const agreed = cli('init.ts', [...consultant(join(base, 'c'), envFile), '--basis', 'agreed']);
  assert.equal(agreed.code, 0, agreed.out);
  assert.deepEqual(workspaceAt(join(base, 'c')).company.vat, { registered: true, method: 'effective', reporting: 'agreed', period: 'quarterly' });
  rmSync(base, { recursive: true, force: true });
});

test('init takes an IBAN per bank and refuses one with wrong check digits', () => {
  const base = tmp();
  const withIban = cli('init.ts', consultant(join(base, 'a'), join(base, 'app.env'), '--bank', `PostFinance:CHF::${testIban('09000000000000002').replace(/(.{4})(?!$)/g, '$1 ')}`));
  assert.equal(withIban.code, 0, withIban.out);
  assert.deepEqual(workspaceAt(join(base, 'a')).bankAccounts.find((a) => a.bank === 'PostFinance'),
    { bank: 'PostFinance', currency: 'CHF', account: '1023', label: 'PostFinance CHF', role: 'bank', statements: 'camt053', iban: testIban('09000000000000002') });
  const typo = cli('init.ts', consultant(join(base, 'b'), join(base, 'app.env'), '--bank', 'PostFinance:CHF::CH00 0900 0000 0000 0000 2'));
  assert.equal(typo.code, 1);
  assert.match(typo.out, /Bank PostFinance: "CH00 0900 0000 0000 0000 2" is not an IBAN/);
  assert.ok(!existsSync(join(base, 'b')), 'nothing written');
  rmSync(base, { recursive: true, force: true });
});

test('an answer the app does not support yet stops with its explanation and writes nothing', () => {
  const base = tmp();
  const cases: [string[], RegExp][] = [

    [['--period', 'monthly'], /Monthly returns are not supported yet/],
    [['--fiscal-year', 'other'], /calendar year is not supported yet/],
  ];
  for (const [flags, why] of cases) {
    const dir = join(base, flags[1]);
    const r = cli('init.ts', [...consultant(dir, join(base, 'app.env')), ...flags]);
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, why);
    assert.ok(!existsSync(dir), `${flags.join(' ')} wrote nothing`);
  }
  const typo = cli('init.ts', ['--preset', 'consultant', '--dir', join(base, 'x'), '--name', 'X GmbH', '--uid', TYPO_UID, '--no-env', '--yes']);
  assert.equal(typo.code, 1);
  assert.match(typo.out, /wrong check digit/);
  rmSync(base, { recursive: true, force: true });
});

test('doctor names the fix when a bank books on an account the chart lacks; the manifest refuses an unsupported profile', () => {
  const base = tmp();
  const dir = join(base, 'books');
  const bin = stubTools();
  assert.equal(cli('init.ts', consultant(dir, join(base, 'app.env'))).code, 0);
  const manifestPath = join(dir, APP_FOLDER, MANIFEST_FILE);
  const ubs = join(yearPaths(workspacePaths(join(dir, APP_FOLDER)), new Date().toISOString().slice(0, 4)).statements, 'UBS');
  const manifest = readFileSync(manifestPath, 'utf8');

  writeFileSync(manifestPath, manifest.replace('account: "1021"', 'account: "1029"'));
  const doctor = cli('doctor.ts', ['--workspace', dir], bin);
  assert.equal(doctor.code, 1);
  assert.match(doctor.out, /✗ Wise EUR books on 1029, which is not in accounts\.json\n {4}fix: Add \{ "number": "1029"/);

  writeFileSync(manifestPath, manifest);
  writeFileSync(join(ubs, 'export.xml'), '<Document/>');
  const fixture = (name: string) => withTestIbans(readFileSync(join(import.meta.dirname, 'fixtures/camt053', name), 'utf8'));
  writeFileSync(join(ubs, 'Kontoauszug Juli.xml'), fixture('ubs_camt053_001_04.xml'));
  const named = cli('doctor.ts', ['--workspace', dir], bin);
  assert.equal(named.code, 0, named.out);
  assert.ok(named.out.includes(`! UBS CHF books on 1020: 1 statement(s) read from bank-statements/UBS/, for IBAN ${testIban('00230000000000001')}: add iban: ${testIban('00230000000000001')}`), named.out);
  assert.match(named.out, /! bank-statements\/UBS\/export\.xml is not read: not a camt\.053 bank statement/);
  writeFileSync(join(ubs, 'pf.xml'), fixture('postfinance_camt053_001_08.xml'));
  const foreign = cli('doctor.ts', ['--workspace', dir], bin);
  assert.equal(foreign.code, 1);
  assert.match(foreign.out, /✗ bank-statements\/UBS\/pf\.xml belongs to no bank account\n {4}fix: bank-statements\/UBS\/ holds statements of two CHF accounts/);
  assert.ok(foreign.out.includes(`✗ bank-statements/UBS/pf.xml belongs to no bank account\n    fix: statement of IBAN ${testIban('09000000000000003')} in EUR in bank-statements/UBS/ matches no bank account`), foreign.out);

  const raw = parse(manifest);
  raw.profile.sells = 'shoes';
  writeFileSync(manifestPath, JSON.stringify(raw));
  assert.throws(() => workspaceAt(dir), (e: Error) => e instanceof WorkspaceError && /profile\.sells must be one of services, goods, both/.test(e.message));
  rmSync(base, { recursive: true, force: true });
  rmSync(bin, { recursive: true, force: true });
});

test('from-source.md documents every init question, in the order the wizard asks', () => {
  const guide = readFileSync(join(APP_ROOT, 'docs', 'from-source.md'), 'utf8');
  const at = QUESTION_ORDER.map((k) => guide.indexOf(`**${QUESTIONS[k].ask}`));
  QUESTION_ORDER.forEach((k, i) => assert.ok(at[i] >= 0, `the guide names "${QUESTIONS[k].ask}"`));
  assert.deepEqual(at, [...at].sort((a, b) => a - b), 'same order as QUESTION_ORDER');
});

test('a new workspace books its first transaction: no prior-year export, the chart from accounts.json, the casebook as examples', () => {
  const base = tmp();
  const dir = join(base, 'books');
  assert.equal(cli('init.ts', consultant(dir, join(base, 'app.env'))).code, 0);
  const ws = workspaceAt(dir);
  const books = loadBooks(ws);
  // Marked as needing no receipt, so the run books it now instead of waiting for one (issue #29).
  books.transactions.push({ ref: 'TX-1', bank: 'UBS', date: '2026-08-14', amount: 50, currency: 'CHF', direction: 'DBIT', description: 'Software Abo', noReceiptNeeded: true });
  saveBooks(ws, books);

  const prompts = join(base, 'prompts.txt');
  const r = cli('classify.ts', [], join(APP_ROOT, 'tests/support/stub-bin'), { VANILLA_WORKSPACE: dir, CLAUDE_STUB_PROMPTS: prompts });
  assert.equal(r.code, 0, r.out);
  const entries = loadBooks(workspaceAt(dir)).journalEntries;
  assert.deepEqual(entries.map((e) => [e.transactionRef, e.accountDebit, e.accountCredit, e.amount]), [['TX-1', '6570', '1020', 50]]);
  const prompt = readFileSync(prompts, 'utf8');
  assert.match(prompt, /## Chart of Accounts[\s\S]*\n1020\tUBS CHF\n/);
  assert.match(prompt, /## Casebook: invented examples/);
  rmSync(base, { recursive: true, force: true });
});
