/**
 * Setting up a workspace from the answers of src/workspace/setup.ts: the checks and the writing
 * behind `npm run init` (src/cli/init.ts asks in a terminal) and the desktop app's "Neue
 * Buchhaltung anlegen" (a form). Both refuse what the wizard refuses, with the same reasons.
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadChart } from './chart.js';
import { bankKind, parseIban } from './banks.js';
import { applyPlan, planWorkspace, suggestAccount, type InitInput } from './scaffold.js';
import { PRESET_NAMES, QUESTIONS, firstMissing, firstUnsupported, optionOf, vatSetupOf, type Answers, type Preset, type QuestionKey, type SupportedAnswers } from './setup.js';
import { parseNetRates, type NetRate, type VatSetup } from './vat-setup.js';
import { parseUid } from './uid.js';
import { initRepository } from './git.js';
import { appFolderIn, appLanguages, workspaceAt } from './workspace.js';

/**
 * Why a setup was refused. `unsupported`: an answer the engine does not support yet (the
 * question and the option's value say which); the others name the field that is wrong.
 */
export type SetupRefusal =
  | { reason: 'unsupported'; question: QuestionKey | 'preset'; value: string }
  | { reason: 'missing'; question: QuestionKey }
  /** The net tax rate method needs its approved rate(s): what is wrong with the ones given. */
  | { reason: 'netRates'; detail: string }
  | { reason: 'required'; field: 'name' | 'owner' | 'root' }
  | { reason: 'uid' | 'language' | 'preset'; detail: string }
  | { reason: 'iban' | 'currency' | 'account' | 'accountTwice' | 'bankTwice'; bank: string; detail: string }
  | { reason: 'noBank' }
  /** A bank account listed without the bank's name (the setup conversation's bank step). */
  | { reason: 'bankName' };

export class SetupError extends Error {
  constructor(message: string, readonly refusal: SetupRefusal) { super(message); }
}

export type Bank = InitInput['banks'][number];

/** A bank account as asked: the ledger account is suggested when absent, the IBAN is optional. */
export interface BankSpec { bank: string; currency: string; account?: string; iban?: string }

/** One bank account, checked against those listed before it. */
export function checkBank(spec: BankSpec, before: readonly Bank[]): Bank {
  const { bank } = spec;
  const currency = spec.currency.trim().toUpperCase();
  const ibanRaw = spec.iban?.trim() ?? '';
  const iban = ibanRaw ? parseIban(ibanRaw) : undefined;
  if (ibanRaw && !iban) {
    throw new SetupError(`Bank ${bank}: "${ibanRaw}" is not an IBAN (wrong length or check digits).`, { reason: 'iban', bank, detail: ibanRaw });
  }
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new SetupError(`Bank ${bank}: currency "${currency}" must be a 3-letter code like CHF or EUR.`, { reason: 'currency', bank, detail: currency });
  }
  const taken = new Set(before.map((b) => b.account));
  const account = spec.account?.trim() || suggestAccount(bank, currency, taken);
  const range = bankKind(bank).range;
  const cls = range === 'card' ? '2' : '1';
  if (!/^\d{4}$/.test(account) || account[0] !== cls) {
    throw new SetupError(`Bank ${bank}: ledger account "${account}" must be 4 digits in class ${cls}.`, { reason: 'account', bank, detail: account });
  }
  if (taken.has(account)) throw new SetupError(`Bank ${bank}: ledger account ${account} is used twice.`, { reason: 'accountTwice', bank, detail: account });
  if (before.some((b) => b.bank === bank && b.currency === currency)) {
    throw new SetupError(`${bank} ${currency} is listed twice.`, { reason: 'bankTwice', bank, detail: currency });
  }
  return { bank, currency, account, ...(iban ? { iban } : {}) };
}

/** The preset's own stop (a freelancer without VAT), before any question is asked. */
export function checkPreset(raw: string): Preset {
  const preset = raw as Preset;
  if (!PRESET_NAMES.includes(preset)) throw new SetupError(`--preset must be one of ${PRESET_NAMES.join(', ')}.`, { reason: 'preset', detail: raw });
  return preset;
}

/** The answers the engine runs on, and the VAT setup they make with the approved net rates (`netRates`, the net tax rate method only). */
export function checkAnswers(given: Answers, netRates: readonly NetRate[] = []): { answers: SupportedAnswers; vat: VatSetup } {
  // A multiple-choice answer sent as one value (a form of before #46 sent `sells: services`) is a list of one.
  const answers = Object.fromEntries(Object.entries(given).map(([k, v]) => [k, typeof v === 'string' && (QUESTIONS[k as QuestionKey] as { multi?: boolean } | undefined)?.multi ? [v] : v])) as Answers;
  const stop = firstUnsupported(answers);
  if (stop) {
    throw new SetupError(stop.option.unsupported!, { reason: 'unsupported', question: stop.key, value: stop.option.value });
  }
  const missing = firstMissing(answers) ?? firstUnknown(answers);
  if (missing) throw new SetupError(`${QUESTIONS[missing].ask}: an answer is needed (--${flagOf(missing)}: ${QUESTIONS[missing].options.map((o) => o.value).join(', ')}).`, { reason: 'missing', question: missing });
  const supported = answers as SupportedAnswers;
  if (supported.vatRegistered === 'yes' && supported.vatMethod === 'net-rate') {
    const rates = parseNetRates(netRates.length ? netRates : undefined, (msg) => { throw new SetupError(`The net tax rate method needs its approved rate(s), --net-rate <percent>[:<label>], one or two: ${msg}.`, { reason: 'netRates', detail: msg }); });
    return { answers: supported, vat: vatSetupOf(supported, rates)! };
  }
  if (netRates.length) throw new SetupError('Net tax rates belong to the net tax rate method only.', { reason: 'netRates', detail: 'method' });
  return { answers: supported, vat: vatSetupOf(supported)! };
}

/** The first asked question whose answer is none of its options (a form sent a value the table does not have). */
function firstUnknown(answers: Answers): QuestionKey | undefined {
  return (Object.keys(QUESTIONS) as QuestionKey[]).find((key) => {
    const given = answers[key];
    return given !== undefined && ([] as string[]).concat(given).some((v) => !optionOf(key, v));
  });
}

/** The wizard's flag of a question: --vat-method, --period. */
export const flagOf = (key: QuestionKey): string => key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

export interface SetupRequest {
  /** The company's repository; created when missing. The books go into its vanilla-accounting/. */
  root: string;
  preset: Preset;
  name: string;
  uid: string;
  owner: string;
  business?: string;
  language?: string;
  answers: Answers;
  /** The approved net tax rate(s), when the VAT method is the net tax rate. */
  netRates?: NetRate[];
  banks: BankSpec[];
  exportTo?: string;
}

export interface Created {
  root: string;
  /** The folder already was a workspace: nothing was written. */
  existed: boolean;
  created: string[];
  /** Files that were there with other content: kept. */
  differing: string[];
  /** The first commit of the new books; `exists` when the folder already was a repository. */
  git?: 'committed' | 'exists' | { error: string };
}

/**
 * Checks every answer, writes the workspace and commits it to a new git repository. A folder that
 * already is a workspace stays as it is.
 */
export async function createWorkspace(req: SetupRequest): Promise<Created> {
  if (!req.root.trim()) throw new SetupError('A folder for the books is needed.', { reason: 'required', field: 'root' });
  const root = resolve(req.root);
  if (appFolderIn(root)) {
    workspaceAt(root);
    return { root, existed: true, created: [], differing: [] };
  }
  const name = req.name.trim();
  const owner = req.owner.trim();
  if (!name) throw new SetupError('The company name is needed.', { reason: 'required', field: 'name' });
  const parsed = parseUid(req.uid);
  if ('error' in parsed) throw new SetupError(parsed.error, { reason: 'uid', detail: req.uid });
  if (!owner) throw new SetupError('The owner is needed.', { reason: 'required', field: 'owner' });
  const languages = appLanguages();
  const language = req.language || 'de';
  if (!languages.includes(language)) throw new SetupError(`--language must be one of ${languages.join(', ')}.`, { reason: 'language', detail: language });
  const preset = checkPreset(req.preset);
  const { answers, vat } = checkAnswers(req.answers, req.netRates ?? []);
  const banks = req.banks.reduce<Bank[]>((list, spec) => [...list, checkBank(spec, list)], []);
  if (banks.length === 0) {
    throw new SetupError('At least one bank account is needed: --bank <bank>:<currency>[:<ledger account>], e.g. --bank UBS:CHF.', { reason: 'noBank' });
  }
  const business = req.business?.trim();
  const exportTo = req.exportTo?.trim();
  const input: InitInput = {
    name, uid: parsed.uid, owner, ...(business ? { business } : {}), ...(language !== 'de' ? { language } : {}),
    preset, answers, vat, banks, ...(exportTo ? { exportTo } : {}),
  };
  const applied = applyPlan(root, planWorkspace(input, loadChart()));
  workspaceAt(root);
  return { root, existed: false, ...applied, git: await firstCommit(root) };
}

async function firstCommit(root: string): Promise<NonNullable<Created['git']>> {
  if (existsSync(join(root, '.git'))) return 'exists';
  try {
    await initRepository(root, 'Workspace set up');
    return 'committed';
  } catch (e) {
    return { error: (e as Error).message.split('\n')[0] };
  }
}
