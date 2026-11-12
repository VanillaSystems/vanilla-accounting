/**
 * npm run init: set up a workspace for a company's books. Asks the questions of
 * src/workspace/setup.ts (a preset prefills them), the company's identity and its bank accounts,
 * then writes the folder (src/workspace/scaffold.ts), commits it to a new git repository and
 * points the app's .env at it. Every question also has a flag, so it runs without a terminal:
 *
 *   npm run init -- --preset consultant --dir ../my-books --name "Beispiel GmbH" \
 *     --uid <UID> --owner "Erika Beispiel" --bank UBS:CHF --bank Wise:EUR --yes
 *
 * A bank is <bank>:<currency>[:<ledger account>[:<IBAN>]]; the IBAN routes its statements to the
 * account (without it, the folder bank-statements/<bank>/ does). On the net tax rate method
 * (--vat-method net-rate) each approved rate is --net-rate <percent>[:<label>[:<activity code>]], one or two.
 *
 * Rerun on a finished workspace changes nothing. Exit code 2: an answer the app does not support yet.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface, type Interface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { BANKS, bankKind } from '../workspace/banks.js';
import { SetupError, checkBank, checkPreset, createWorkspace, flagOf, type Bank, type Created } from '../workspace/create.js';
import { suggestAccount } from '../workspace/scaffold.js';
import { NO_VAT, PRESETS, PRESET_NAMES, QUESTIONS, QUESTION_ORDER, asked, firstUnsupported, notRegistered, optionOf, unsteered, type Answers, type Preset, type QuestionKey } from '../workspace/setup.js';
import type { NetRate } from '../workspace/vat-setup.js';
import { parseUid } from '../workspace/uid.js';
import { APP_ROOT, appFolderIn, appLanguages, workspaceAt } from '../workspace/workspace.js';

const { values: flags } = parseArgs({
  options: {
    dir: { type: 'string' }, name: { type: 'string' }, uid: { type: 'string' }, owner: { type: 'string' },
    about: { type: 'string' }, language: { type: 'string' }, preset: { type: 'string' }, bank: { type: 'string', multiple: true },
    'export-to': { type: 'string' }, 'net-rate': { type: 'string', multiple: true },
    'app-env': { type: 'string' }, 'no-env': { type: 'boolean' }, 'set-env': { type: 'boolean' },
    yes: { type: 'boolean', short: 'y' },
    ...Object.fromEntries(QUESTION_ORDER.map((k) => [flagOf(k), { type: 'string' as const }])),
  },
}) as { values: Record<string, string | string[] | boolean | undefined> };

/** Stops the wizard with a message; `code` 2 marks an answer the app does not support yet. */
class Stop extends Error {
  constructor(message: string, readonly code = 1) { super(message); }
}

const interactive = process.stdin.isTTY === true && !flags.yes;
let rl: Interface | undefined;

/** The flag's value, else the person's answer (Enter takes the default), else the default. */
async function answer(flag: string, prompt: string, fallback?: string): Promise<string> {
  const given = flags[flag];
  if (typeof given === 'string') return given.trim();
  if (interactive) {
    rl ??= createInterface({ input: process.stdin, output: process.stdout });
    const typed = (await rl.question(`${prompt}${fallback ? ` [${fallback}]` : ''} > `)).trim();
    if (typed) return typed;
  }
  if (fallback !== undefined) return fallback;
  throw new Stop(`Missing --${flag} (${prompt.trim()}). Run npm run init in a terminal to be asked, or pass the flag.`);
}

async function text(flag: string, prompt: string, check?: (v: string) => string | undefined, fallback?: string): Promise<string> {
  for (;;) {
    const v = await answer(flag, prompt, fallback);
    const problem = v ? check?.(v) : 'An answer is needed.';
    if (!problem) return v;
    if (!interactive) throw new Stop(`--${flag}: ${problem}`);
    console.log(`  ${problem}`);
  }
}

async function choose(key: QuestionKey, n: number, preset: Partial<Answers>): Promise<string[]> {
  const q = QUESTIONS[key];
  const multi = 'multi' in q;
  // «we file no VAT returns» beside the method and the basis (#347): «no» to the registration, also as --vat-method no-vat.
  const options = [...(q.options as readonly { value: string; label: string }[]), ...(unsteered(key) ? [{ value: NO_VAT, label: 'we file no VAT returns (not registered for VAT)' }] : [])];
  if (interactive) {
    console.log(`\n${n}/${QUESTION_ORDER.length} ${q.ask}\n    ${q.why}${'where' in q ? `\n    ${q.where}` : ''}`);
    console.log('    ' + options.map((o, i) => `${i + 1}) ${o.label}`).join('   ') + (multi ? '   (several: 1,2; none: -)' : ''));
  }
  const prefilled = preset[key] as string | string[] | undefined;
  const fallback = prefilled === undefined ? undefined : multi ? ([] as string[]).concat(prefilled).join(',') || '-' : String(prefilled);
  for (;;) {
    const raw = await answer(flagOf(key), interactive ? '   ' : q.ask, fallback);
    // "-" and "none" empty a multiple-choice answer; a single-choice question may have an option named none.
    const picked = (multi ? raw.split(',') : [raw]).map((s) => s.trim()).filter((s) => s && !(multi && (s === '-' || s === 'none')))
      .map((s) => (/^\d+$/.test(s) ? options[Number(s) - 1]?.value : options.find((o) => o.value.toLowerCase() === s.toLowerCase())?.value) ?? `?${s}`);
    const bad = picked.find((v) => v.startsWith('?'));
    if (!bad && (multi || picked.length === 1)) return picked;
    const problem = `"${bad?.slice(1) ?? raw}" is not one of ${options.map((o) => o.value).join(', ')}.`;
    if (!interactive) throw new Stop(`--${flagOf(key)}: ${problem}`);
    console.log(`    ${problem}`);
  }
}

async function askAnswers(preset: Preset): Promise<{ answers: Answers; netRates: NetRate[] }> {
  const prefill: Partial<Answers> = PRESETS[preset].answers;
  const answers: Record<string, string | string[]> = {};
  const netRates: NetRate[] = [];
  for (const [i, key] of QUESTION_ORDER.entries()) {
    if (!asked(key, answers)) continue;
    const picked = await choose(key, i + 1, prefill);
    if (picked[0] === NO_VAT) {
      const unregistered = notRegistered(answers);
      for (const k of Object.keys(answers)) delete answers[k];
      Object.assign(answers, unregistered);
      console.log(`    Note: ${optionOf('vatRegistered', 'no')!.caveat}`);
      continue;
    }
    answers[key] = 'multi' in QUESTIONS[key] ? picked : picked[0];
    for (const v of picked) {
      const option = optionOf(key, v);
      if (option?.unsupported) throw new Stop(`${QUESTIONS[key].ask}: ${option.label}.\n${option.unsupported}`, 2);
      if (option?.caveat) console.log(`    Note: ${option.caveat}`);
    }
    if (key === 'vatMethod' && answers[key] === 'net-rate') netRates.push(...await askNetRates());
  }
  return { answers: answers as Answers, netRates };
}

/** The approved net tax rate(s): --net-rate <percent>[:<label>[:<activity code>]], or typed one per line, Enter on an empty line after the first. */
async function askNetRates(): Promise<NetRate[]> {
  const parse = (spec: string): NetRate => {
    const [percent, label, activityId] = spec.split(':').map((s) => s.trim());
    const rate = Number(percent.replace(',', '.').replace(/\s*%$/, ''));
    if (!(rate > 0 && rate < 100)) throw new Stop(`--net-rate "${spec}": the rate is a percent above 0 and below 100, e.g. 4.5, 4.5:Schreinerei or 4.5:Schreinerei:41050.`);
    return { rate, ...(label ? { label } : {}), ...(activityId ? { activityId: activityId.toUpperCase() } : {}) };
  };
  if (Array.isArray(flags['net-rate'])) return flags['net-rate'].map(parse);
  if (!interactive) throw new Stop('Missing --net-rate <percent>[:<label>]: the rate(s) the ESTV approved for the Saldosteuersatz method, one or two.');
  const rates: NetRate[] = [];
  console.log('\n    The approved Saldosteuersatz in percent, a label and the ESTV\'s activity code after colons (e.g. 4.5:Schreinerei:41050; the code is on the ESTV\'s ruling and names the rate in the electronic return). A second one on the next line; Enter on an empty line when done.');
  for (;;) {
    const typed = (await rl!.question(`    Rate ${rates.length + 1} > `)).trim();
    if (!typed) { if (rates.length) return rates; console.log('    At least one rate is needed.'); continue; }
    try { rates.push(parse(typed)); } catch (e) { console.log(`    ${(e as Error).message}`); continue; }
    if (rates.length === 2) return rates;
  }
}

async function askBanks(): Promise<Bank[]> {
  const banks: Bank[] = [];
  const add = (bank: string, currency: string, account?: string, iban = '') => {
    const checked = checkBank({ bank, currency, account, iban }, banks);
    banks.push(checked);
    const note = bankKind(bank).note;
    console.log(`    ${bank} ${checked.currency} on ledger account ${checked.account}${note ? `. Note: ${note}` : ''}`);
  };
  const canonical = (name: string) => Object.keys(BANKS).find((b) => b.toLowerCase() === name.toLowerCase()) ?? name;

  if (Array.isArray(flags.bank)) {
    for (const spec of flags.bank) {
      const [name, currency = 'CHF', account, iban] = spec.split(':').map((s) => s.trim());
      const bank = canonical(name);
      add(bank, currency, account, iban);
    }
  } else if (interactive) {
    const names = [...Object.keys(BANKS).slice(0, 4), 'other cantonal or regional bank', ...Object.keys(BANKS).slice(4)];
    console.log(`\nBank accounts, one at a time (a Wise account per currency). Enter on an empty line when done.`);
    console.log('    ' + names.map((n, i) => `${i + 1}) ${n}`).join('   '));
    for (;;) {
      const pick = (await rl!.question('    Bank > ')).trim();
      if (!pick) { if (banks.length) break; console.log('    At least one bank account is needed.'); continue; }
      const listed = /^\d+$/.test(pick) ? names[Number(pick) - 1] : canonical(pick);
      if (!listed) continue;
      const bank = listed === names[4] ? (await rl!.question('    Name of the bank (e.g. BEKB) > ')).trim() : listed;
      if (!bank) continue;
      const currency = ((await rl!.question('    Currency [CHF] > ')).trim() || 'CHF').toUpperCase();
      const suggested = suggestAccount(bank, currency, new Set(banks.map((b) => b.account)));
      const account = (await rl!.question(`    Ledger account [${suggested}] > `)).trim() || suggested;
      const iban = bankKind(bank).statements
        ? (await rl!.question('    IBAN (Enter to skip: the statement folder then decides; npm run doctor reads it from the first statement) > ')).trim()
        : '';
      try { add(bank, currency, account, iban); } catch (e) { console.log(`    ${(e as Error).message}`); }
    }
  }
  if (banks.length === 0) throw new Stop('At least one bank account is needed: --bank <bank>:<currency>[:<ledger account>], e.g. --bank UBS:CHF.');
  return banks;
}

/** Points the app's .env at the workspace. Another value stays unless the person (or --set-env) says to replace it. */
async function pointEnvAt(envFile: string, root: string): Promise<string> {
  const content = existsSync(envFile) ? readFileSync(envFile, 'utf8') : '';
  const line = `VANILLA_WORKSPACE=${root}`;
  const current = /^(?:VANILLA|BELEGE)_WORKSPACE=(.*)$/m.exec(content);
  if (current?.[0] === line) return `${envFile} already points at this workspace.`;
  if (current?.[1].trim() === root) {
    writeFileSync(envFile, content.replace(current[0], line));
    return `${envFile} points at this workspace, now as VANILLA_WORKSPACE.`;
  }
  if (current) {
    const replace = flags['set-env'] === true
      || (interactive && /^y/i.test(await rl!.question(`\n${envFile} points at ${current[1]}. Point it at ${root} instead? [y/N] > `)));
    if (!replace) return `${envFile} still points at ${current[1]}. To use the new books: VANILLA_WORKSPACE=${root} npm start`;
    writeFileSync(envFile, content.replace(current[0], line));
    return `${envFile} now points at ${root}.`;
  }
  writeFileSync(envFile, content + (content && !content.endsWith('\n') ? '\n' : '') + line + '\n');
  return `${envFile} points at ${root}.`;
}

function gitMessage(git: Created['git']): string {
  if (git === 'committed') return 'Committed the workspace to a new git repository.';
  if (git === 'exists' || !git) return 'Git repository exists: nothing committed.';
  return `The git repository could not be made (${git.error}). Run git init and commit the folder yourself: it keeps every change to the books traceable.`;
}

async function main(): Promise<string> {
  if (interactive) console.log('Vanilla Accounting: set up the books of a company. Enter takes the value in [brackets].\n');
  const presetPrompt = interactive
    ? `Which fits best? ${PRESET_NAMES.map((p, i) => `${i + 1}) ${PRESETS[p].label}`).join('   ')}\n`
    : 'Preset';
  const presetRaw = await answer('preset', presetPrompt, interactive ? '1' : undefined);
  const preset = checkPreset(/^\d+$/.test(presetRaw) ? PRESET_NAMES[Number(presetRaw) - 1] : presetRaw);
  const presetStop = firstUnsupported(PRESETS[preset].answers as Answers);
  if (presetStop) throw new Stop(`${PRESETS[preset].label}: ${presetStop.option.unsupported}`, 2);

  const name = await text('name', 'Company name (as in the commercial register)');
  const slug = name.toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const root = resolve(await text('dir', 'Folder for the books', undefined, interactive ? join(APP_ROOT, '..', `${slug}-books`) : undefined));

  let message: string;
  if (appFolderIn(root)) {
    workspaceAt(root);
    message = `${root} is already a workspace: nothing to change.`;
  } else {
    const uid = await text('uid', 'UID (CHE-###.###.###, from uid.admin.ch)', (v) => { const r = parseUid(v); return 'error' in r ? r.error : undefined; });
    const owner = await text('owner', 'Owner (managing director)');
    const about = await answer('about', 'What the company does, in a few words (helps booking; optional)', '');
    const languages = appLanguages();
    const language = await answer('language', `Language of the app (${languages.join(', ')})`, 'de');
    if (!languages.includes(language)) throw new Stop(`--language must be one of ${languages.join(', ')}.`);
    const { answers, netRates } = await askAnswers(preset);
    const banks = await askBanks();
    const exportTo = await answer('export-to', '\nWhere do the books go at year-end (accounting software or Treuhand; optional)', '');

    const applied = await createWorkspace({ root, preset, name, uid, owner, business: about, language, answers, netRates, banks, exportTo });
    message = [
      `Created ${applied.created.length} files and folders in ${root}.`,
      ...applied.differing.map((p) => `Kept your ${p}: it differs from what init would write.`),
      gitMessage(applied.git),
    ].join('\n');
  }

  if (flags['no-env'] !== true) {
    message += '\n' + await pointEnvAt(typeof flags['app-env'] === 'string' ? resolve(flags['app-env']) : join(APP_ROOT, '.env'), root);
  }
  return message + '\n\nNext: npm run doctor, then npm start. docs/from-source.md lists the commands, docs/getting-started.md walks through the app (first bank statement, first receipts).';
}

main()
  .then((message) => { console.log(`\n${message}`); })
  .catch((e: unknown) => {
    console.error(`\n${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = e instanceof Stop ? e.code : e instanceof SetupError && e.refusal.reason === 'unsupported' ? 2 : 1;
  })
  .finally(() => rl?.close());
