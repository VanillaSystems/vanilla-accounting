/**
 * The desktop app's first screen (ADR 0009): open existing books, set up new ones, or look at a copy
 * of the demo. Shown at /start and whenever no books are open. A fresh install (no books open, none
 * known) opens straight into «Einrichtung» (docs/0.4.0/ai-setup.md, decision 1 as changed on
 * 12.11.2026; src/app/ai/FirstRun.tsx): what the person wants first. With an AI ready, new books run
 * the setup conversation (#139, DraftConversation); without one they open the form with the
 * questions of `npm run init` (src/workspace/setup.ts, checked again by src/workspace/create.ts),
 * which stays «Ohne KI einrichten» beside the conversation. Both end in the same createWorkspace.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { BANKS, parseIban } from '../../workspace/banks.js';
import { PRESETS, PRESET_NAMES, QUESTIONS, QUESTION_ORDER, asked, firstMissing, hasWhere, firstUnsupported, notRegistered, optionOf, unsteered, withoutUnsteered, NO_VAT, type Answers, type Preset, type QuestionKey } from '../../workspace/setup.js';
import { parseUid } from '../../workspace/uid.js';
import type { DesktopInfo, KnownBooks } from '../../types/desktop.js';
import { LOCALES, t, tData } from '../i18n/index.js';
import { ApiError, api, errorText } from '../lib/api.js';
import { DEMO_HOME, START_PATH, desktop, setupPath } from './bridge.js';
import { FirstRun, freeName } from '../ai/FirstRun.js';
import { DraftConversation } from '../onboarding/DraftConversation.js';
import './start.css';

interface BankRow { bank: string; currency: string; account: string; iban: string }

interface Form {
  preset: Preset;
  name: string;
  uid: string;
  owner: string;
  business: string;
  language: string;
  /** Empty: the folder follows the name (booksHome/<name>). */
  root: string;
  answers: Partial<Answers>;
  /** The approved net tax rates as typed: [percent, label, activity code] each, the second row optional. */
  netRates: [string, string, string][];
  banks: BankRow[];
  exportTo: string;
}

const NO_RATES: [string, string, string][] = [['', '', ''], ['', '', '']];
/** The tax authority's activity code as the manifest takes it (src/workspace/vat-setup.ts). */
const ACTIVITY_ID = /^[A-Z0-9]{5}$/;
const rateOf = (text: string): number | undefined => {
  const n = Number(text.trim().replace(',', '.').replace(/\s*%$/, ''));
  return text.trim() && n > 0 && n < 100 ? n : undefined;
};

const NEW_BANK: BankRow = { bank: '', currency: 'CHF', account: '', iban: '' };
const BANK_NAMES = Object.keys(BANKS);

/** Whether the page is the start screen: in the desktop app at /start, or while no books are open; undefined until known. */
export function useStartScreen(): boolean | undefined {
  const [start, setStart] = useState<boolean | undefined>(() => (!desktop ? false : location.pathname === START_PATH ? true : undefined));
  useEffect(() => {
    if (start !== undefined) return;
    void api.desktop.info().then((i) => setStart(!i.open), () => setStart(false));
  }, [start]);
  return start;
}

const answerList = (a: Partial<Answers>, key: QuestionKey): string[] => ([] as string[]).concat(a[key] ?? []);

/** What the start screen shows: the choices, «Einrichtung» from the AI to the folder, the setup conversation in a folder, or the form. */
/** `first` with `create`: new books were chosen already (the start page, the menu's /start?new). */
type Mode = { kind: 'home' } | { kind: 'first'; create?: boolean } | { kind: 'setup'; root: string } | { kind: 'form' };

const modeOfUrl = (): Mode => {
  const q = new URLSearchParams(location.search);
  const root = q.get('setup');
  return root ? { kind: 'setup', root } : q.has('new') ? { kind: 'first', create: true } : { kind: 'home' };
};

export function StartScreen({ language, onLanguage }: { language: string; onLanguage(code: string): void }) {
  const [info, setInfo] = useState<DesktopInfo | null>(null);
  const [mode, setModeState] = useState<Mode>(modeOfUrl);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  /** Books refused for their layout before 0.4.0: the folder the app offers to move into the current one. */
  const [upgradable, setUpgradable] = useState<string>();

  /** The first look at what this Mac knows was taken. */
  const looked = useRef(false);
  useEffect(() => {
    void api.desktop.info().then((i) => {
      setInfo(i);
      // macOS still asks about the Documents folder: the screen shows now, the folders follow.
      if (i.foldersPending) void api.desktop.folders().then(({ folders }) => setInfo((was) => (was ? { ...was, folders, foldersPending: false } : was)), () => undefined);
      // A fresh install: no books open and none known. Once: «Zur Startseite» from there stays on the start screen.
      if (!looked.current && mode.kind === 'home' && !i.open && !i.recent.length && !location.search) setMode({ kind: 'first' });
      looked.current = true;
    }, (e) => setError(errorText(e)));
  }, [mode.kind]);
  const setMode = (next: Mode) => {
    setError('');
    history.replaceState(null, '', next.kind === 'setup' ? setupPath(next.root) : START_PATH);
    setModeState(next);
  };
  /** «Neue Buchhaltung anlegen» (also the menu's /start?new): «Einrichtung», what the person wants, the AI where it has work. */
  const startNew = () => setMode({ kind: 'first', create: true });
  useEffect(() => { document.title = 'Vanilla Accounting'; }, []);
  // /start?new has acted once it set the mode: a reload does not open the save panel again.
  useEffect(() => { if (new URLSearchParams(location.search).has('new')) history.replaceState(null, '', START_PATH); }, []);

  const run = async (open: () => Promise<KnownBooks>) => {
    setBusy(true);
    setError('');
    setUpgradable(undefined);
    try {
      const books = await open();
      if (books.setup) { setBusy(false); setMode({ kind: 'setup', root: books.root }); return; }
      location.assign(books.demo ? DEMO_HOME : '/');
    } catch (e) {
      setError(errorText(e));
      if (e instanceof ApiError && e.body.code === 'oldLayout') setUpgradable(e.body.params.root);
      setBusy(false);
    }
  };
  const chooseAndOpen = async () => {
    setError('');
    let root: string | null | undefined;
    try { root = await desktop?.chooseFolder(t('desktop.chooseOpen')); } catch (e) { setError(errorText(e)); }
    if (root) await run(() => api.desktop.open(root));
  };

  return (
    <div className="st">
      <header className="st-top">
        <span className="seg2" role="radiogroup" aria-label={t('desktop.language')}>
          {LOCALES.map((l) => (
            <button key={l.code} type="button" role="radio" aria-checked={l.code === language} className={l.code === language ? 'on' : ''} data-tip={l.name} onClick={() => onLanguage(l.code)}>{l.code.toUpperCase()}</button>
          ))}
        </span>
      </header>
      {mode.kind === 'setup' ? <DraftConversation root={mode.root} onLeave={() => setMode({ kind: 'home' })} />
        : mode.kind === 'first' ? <FirstRun info={info} create={mode.create} onLeave={() => setMode({ kind: 'home' })} onSetup={(root) => setMode({ kind: 'setup', root })} onForm={() => setMode({ kind: 'form' })} />
        : mode.kind === 'form'
        ? <CreateForm info={info} language={language} busy={busy} error={error} onCancel={() => setMode({ kind: 'home' })} onCreate={(setup) => run(() => api.desktop.create(setup))} />
        : (
          <div className="st-main">
            <h1>Vanilla Accounting</h1>
            <p className="st-sub">{info?.open ? t('desktop.switchBooks', { name: info.open.demo ? t('desktop.demoName') : info.open.name ?? info.open.root }) : t('desktop.welcome')}</p>
            <div className="st-choices">
              <button type="button" className="st-choice" data-act="open" disabled={busy} onClick={() => void chooseAndOpen()}>
                <b>{t('desktop.open')}</b><span>{t('desktop.openHint')}</span>
              </button>
              <button type="button" className="st-choice" data-act="new" disabled={busy} onClick={startNew}>
                <b>{t('desktop.new')}</b><span>{t('desktop.newHint')}</span>
              </button>
              <button type="button" className="st-choice" data-act="demo" disabled={busy} onClick={() => void run(api.desktop.demo)}>
                <b>{t('desktop.demo')}</b><span>{t('desktop.demoHint')}</span>
              </button>
            </div>
            {error && <p className="warnline" role="alert">{error}</p>}
            {upgradable && (
              <p className="st-upgrade">
                <button type="button" className="st-choice" data-act="upgrade" disabled={busy} onClick={() => void run(() => api.desktop.upgrade(upgradable))}>
                  <b>{t('desktop.upgrade')}</b><span>{t('desktop.upgradeHint')}</span>
                </button>
              </p>
            )}
            {!!info?.recent.length && (
              <section className="st-recent">
                <h2>{t('desktop.recent')}</h2>
                {info.recent.map((b) => (
                  <button key={b.root} type="button" className="st-book" data-tip={b.root} disabled={busy || (!b.name && !b.problem && !b.setup)} onClick={() => void run(() => api.desktop.open(b.root))}>
                    <b>{b.demo ? t('desktop.demoName') : b.name ?? t(b.setup ? 'desktop.flow.unnamed' : b.problem ? 'desktop.unreadable' : 'desktop.missing')}</b>{b.setup ? <span className="st-badge">{t('desktop.flow.inProgress')}</span> : null}<span className="mono">{b.root}</span>
                    {b.problem && <small className="st-problem">{b.problem}</small>}
                  </button>
                ))}
              </section>
            )}
            {info?.open && <p className="st-back"><a href="/">{t('desktop.backTo', { name: info.open.demo ? t('desktop.demoName') : info.open.name ?? '' })}</a></p>}
          </div>
        )}
    </div>
  );
}

function CreateForm({ info, language, busy, error, onCancel, onCreate }: {
  /** The app's language now: the form is in it, and the new books' language starts as it. */
  info: DesktopInfo | null; language: string; busy: boolean; error: string; onCancel(): void;
  onCreate(setup: Parameters<typeof api.desktop.create>[0]): void;
}) {
  const [f, setF] = useState<Form>(() => ({
    preset: 'consultant', name: '', uid: '', owner: '', business: '', language: LOCALES.some((l) => l.code === language) ? language : 'de', root: '',
    answers: withoutUnsteered({ ...PRESETS.consultant.answers }), netRates: NO_RATES, banks: [{ ...NEW_BANK, bank: 'UBS' }], exportTo: '',
  }));
  const [checked, setChecked] = useState(false);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }));
  const setBank = (i: number, patch: Partial<BankRow>) => set('banks', f.banks.map((b, j) => (j === i ? { ...b, ...patch } : b)));

  const root = f.root || (info ? `${info.booksHome}/${freeName(t('desktop.folderName', { year: String(new Date().getFullYear()) }), info.folders)}` : '');
  const questions = QUESTION_ORDER.filter((k) => asked(k, f.answers));
  const netRate = f.answers.vatRegistered === 'yes' && f.answers.vatMethod === 'net-rate';
  const complete = firstMissing(f.answers) === undefined;
  const stop = complete ? firstUnsupported(f.answers as Answers) : undefined;
  const errors = useMemo(() => {
    const uid = parseUid(f.uid);
    return {
      name: !f.name.trim() ? t('desktop.setup.required.name') : '',
      uid: 'error' in uid ? t('desktop.setup.uid', { detail: f.uid }) : '',
      owner: !f.owner.trim() ? t('desktop.setup.required.owner') : '',
      netRate: netRate && rateOf(f.netRates[0][0]) === undefined ? t('desktop.netRateMissing') : netRate && f.netRates.some((r) => r[2].trim() && !ACTIVITY_ID.test(r[2].trim().toUpperCase())) ? t('desktop.activityIdInvalid') : '',
      banks: f.banks.map((b) => (!b.bank.trim() ? t('desktop.setup.bankName') : b.iban.trim() && !parseIban(b.iban) ? t('desktop.setup.iban', { bank: b.bank, detail: b.iban }) : '')),
      bankField: f.banks.map((b) => (!b.bank.trim() ? 'bank' : 'iban')),
    };
  }, [f, netRate]);
  const problems = [
    errors.name && t('desktop.name'), errors.uid && t('desktop.uid'), errors.owner && t('desktop.owner'), errors.netRate && t('desktop.netRates'),
    ...f.banks.map((b, i) => errors.banks[i] && `${t('desktop.iban')} ${b.bank || i + 1}`),
  ].filter(Boolean);
  const invalid = !!(errors.name || errors.uid || errors.owner || errors.netRate || errors.banks.some(Boolean) || f.banks.length === 0);

  // «Etwas anderes» keeps what is answered so far and takes its own defaults (not registered for VAT) on top.
  const choosePreset = (preset: Preset) => setF((x) => ({ ...x, preset, answers: preset === 'custom' ? { ...x.answers, ...PRESETS.custom.answers } : withoutUnsteered({ ...PRESETS[preset].answers }) }));
  const pick = (key: QuestionKey, value: string) => setF((x) => {
    const multi = 'multi' in QUESTIONS[key];
    const now = answerList(x.answers, key);
    const next = multi ? (now.includes(value) ? now.filter((v) => v !== value) : [...now, value]) : value;
    // The reporting period follows the method (r5f-14): half-yearly on the net tax rate, quarterly on the effective one; the person may still change it.
    const period: Partial<Answers> = key === 'vatMethod' ? { period: value === 'net-rate' ? 'half-yearly' : 'quarterly' } : {};
    // Not registered, by «nein» or by the answer «we file no VAT returns» (#347): the questions of a registered firm go.
    if ((key === 'vatRegistered' && value === 'no') || value === NO_VAT) return { ...x, answers: notRegistered(x.answers) };
    return { ...x, answers: { ...x.answers, [key]: next, ...period } };
  });
  const [folderError, setFolderError] = useState('');
  const chooseFolder = async () => {
    setFolderError('');
    try {
      const dir = await desktop?.chooseFolder(t('desktop.chooseNew'));
      if (dir) set('root', dir);
    } catch (e) { setFolderError(errorText(e)); }
  };
  const submit = () => {
    setChecked(true);
    if (invalid || !complete) {
      requestAnimationFrame(() => {
        const first = document.querySelector<HTMLElement>('.st-form .err');
        first?.scrollIntoView({ block: 'center', behavior: 'smooth' });
        first?.querySelector<HTMLElement>('input, button')?.focus({ preventScroll: true });
      });
      return;
    }
    if (stop) return;
    const netRates = netRate ? f.netRates.flatMap(([percent, label, activityId]) => (rateOf(percent) === undefined ? [] : [{ rate: rateOf(percent)!, ...(label.trim() ? { label: label.trim() } : {}), ...(activityId.trim() ? { activityId: activityId.trim().toUpperCase() } : {}) }])) : [];
    onCreate({
      root, preset: f.preset, name: f.name, uid: f.uid, owner: f.owner, business: f.business, language: f.language,
      answers: f.answers as Answers, netRates, banks: f.banks, exportTo: f.exportTo,
    });
  };
  const setRate = (i: 0 | 1, part: 0 | 1 | 2, value: string) => set('netRates', f.netRates.map((r, j) => (j === i ? r.map((x, k) => (k === part ? value : x)) : r)) as [string, string, string][]);
  const err = (text: string) => (checked && text ? <em>{text}</em> : null);

  return (
    <div className="st-main st-create">
      <h1>{t('desktop.new')}</h1>
      <p className="st-sub">{t('desktop.newIntro')}</p>
      <form className="st-form" noValidate onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <section>
          <h2>{t('desktop.preset')}</h2>
          <div className="st-opts" role="radiogroup" aria-label={t('desktop.preset')}>
            {PRESET_NAMES.map((p) => (
              <button key={p} type="button" role="radio" aria-checked={f.preset === p} className={f.preset === p ? 'on' : ''} onClick={() => choosePreset(p)}>{tData(`desktop.q.preset.${p}`)}</button>
            ))}
          </div>
        </section>

        <section className="st-grid">
          <h2>{t('desktop.company')}</h2>
          <label className={`cf s4${checked && errors.name ? ' err' : ''}`}><span>{t('desktop.name')}{err(errors.name)}</span>
            <input name="name" value={f.name} onChange={(e) => set('name', e.target.value)} placeholder={t('desktop.namePh')} autoFocus />
          </label>
          <label className={`cf s2${checked && errors.uid ? ' err' : ''}`}><span>{t('desktop.uid')}{err(errors.uid)}</span>
            <input name="uid" className="mono" value={f.uid} onChange={(e) => set('uid', e.target.value)} placeholder={t('desktop.uidPh')} />
          </label>
          <label className={`cf s2${checked && errors.owner ? ' err' : ''}`}><span>{t('desktop.owner')}{err(errors.owner)}</span>
            <input name="owner" value={f.owner} onChange={(e) => set('owner', e.target.value)} />
          </label>
          <label className="cf s4"><span>{t('desktop.business')}</span>
            <input value={f.business} onChange={(e) => set('business', e.target.value)} placeholder={t('desktop.optional')} />
          </label>
          <div className="cf s4"><span>{t('desktop.appLanguage')}</span>
            <span className="seg2" role="radiogroup" aria-label={t('desktop.appLanguage')}>
              {LOCALES.map((l) => (
                <button key={l.code} type="button" role="radio" aria-checked={f.language === l.code} className={f.language === l.code ? 'on' : ''} onClick={() => set('language', l.code)}>{l.code.toUpperCase()}</button>
              ))}
            </span>
          </div>
          <label className="cf s4"><span>{t('desktop.folder')}</span>
            <span className="st-row">
              <input name="root" className="mono" value={root} onChange={(e) => set('root', e.target.value)} />
              {desktop && <button type="button" className="btn ghost" onClick={() => void chooseFolder()}>{t('desktop.chooseButton')}</button>}
            </span>
          </label>
          {folderError && <p className="st-stop" role="alert">{folderError}</p>}
        </section>

        <section>
          <h2>{t('desktop.questions')}</h2>
          {questions.map((key) => {
            const chosen = answerList(f.answers, key);
            const notes = chosen.map((v) => optionOf(key, v)).filter((o) => o?.unsupported || o?.caveat);
            return (
              <div key={key} className={checked && !answerList(f.answers, key).length && !('multi' in QUESTIONS[key] && !('required' in QUESTIONS[key])) ? 'st-q err' : 'st-q'} data-q={key}>
                <div className="st-qhd"><b>{tData(`desktop.q.${key}.ask`)}</b><span>{tData(`desktop.q.${key}.why`)}</span>{hasWhere(key) ? <span data-where>{tData(`desktop.q.${key}.where`)}</span> : null}</div>
                <div className="st-opts" role={'multi' in QUESTIONS[key] ? 'group' : 'radiogroup'} aria-label={tData(`desktop.q.${key}.ask`)}>
                  {QUESTIONS[key].options.map((o) => (
                    <button key={o.value} type="button" role={'multi' in QUESTIONS[key] ? 'checkbox' : 'radio'} aria-checked={chosen.includes(o.value)} className={chosen.includes(o.value) ? 'on' : ''} onClick={() => pick(key, o.value)}>
                      {tData(`desktop.q.${key}.${o.value}`)}
                    </button>
                  ))}
                  {unsteered(key) ? <button type="button" role="radio" aria-checked={false} data-answer={NO_VAT} onClick={() => pick(key, NO_VAT)}>{t('desktop.q.noVat')}</button> : null}
                </div>
                {unsteered(key) ? <p className="st-note" data-no-vat-hint>{t('desktop.q.noVat.hint')}</p> : null}
                {notes.map((o) => (
                  <p key={o!.value} className={o!.unsupported ? 'st-stop' : 'st-note'}>{tData(`desktop.q.${key}.${o!.value}.${o!.unsupported ? 'unsupported' : 'caveat'}`)}</p>
                ))}
                {key === 'vatMethod' && netRate && (
                  <div className={`st-rates${checked && errors.netRate ? ' err' : ''}`} data-q="netRates">
                    <div className="st-qhd"><b>{t('desktop.netRates')}</b><span>{t('desktop.netRateHint')}</span></div>
                    {([0, 1] as const).map((i) => (
                      <div key={i} className="st-row">
                        <label className="cf"><span>{t(i === 0 ? 'desktop.netRate1' : 'desktop.netRate2')}{i === 0 && err(errors.netRate)}</span><input name={`netRate${i + 1}`} className="mono" value={f.netRates[i][0]} onChange={(e) => setRate(i, 0, e.target.value)} /></label>
                        <label className="cf"><span>{t('desktop.netRateLabel')}</span><input name={`netRateLabel${i + 1}`} value={f.netRates[i][1]} placeholder={t('desktop.optional')} onChange={(e) => setRate(i, 1, e.target.value)} /></label>
                        <label className="cf"><span>{t('desktop.netRateActivityId')}</span><input name={`netRateActivity${i + 1}`} className="mono" maxLength={5} value={f.netRates[i][2]} placeholder={t('desktop.optional')} onChange={(e) => setRate(i, 2, e.target.value)} /></label>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </section>

        <section>
          <h2>{t('desktop.banks')}</h2>
          <p className="st-note">{t('desktop.banksHint')}</p>
          <datalist id="st-banks">{BANK_NAMES.map((b) => <option key={b} value={b} />)}</datalist>
          {f.banks.map((b, i) => (
            <div key={i} className="st-bank">
              <label className={`cf${checked && errors.banks[i] && errors.bankField[i] === 'bank' ? ' err' : ''}`}><span>{t('desktop.bank')}</span><input list="st-banks" value={b.bank} onChange={(e) => setBank(i, { bank: e.target.value })} /></label>
              <label className="cf"><span>{t('desktop.currency')}</span><input className="mono" maxLength={3} value={b.currency} onChange={(e) => setBank(i, { currency: e.target.value.toUpperCase() })} /></label>
              <label className="cf"><span>{t('desktop.ledgerAccount')}</span><input className="mono" value={b.account} placeholder={t('desktop.automatic')} onChange={(e) => setBank(i, { account: e.target.value })} /></label>
              <label className={`cf${checked && errors.banks[i] && errors.bankField[i] === 'iban' ? ' err' : ''}`}><span>{t('desktop.iban')}</span><input className="mono" value={b.iban} placeholder={t('desktop.optional')} onChange={(e) => setBank(i, { iban: e.target.value })} /></label>
              <button type="button" className="btn ghost" aria-label={t('desktop.removeBank')} disabled={f.banks.length === 1} onClick={() => set('banks', f.banks.filter((_, j) => j !== i))}>×</button>
              {checked && errors.banks[i] && <em className="st-bankerr">{errors.banks[i]}</em>}
            </div>
          ))}
          <button type="button" className="btn ghost" onClick={() => set('banks', [...f.banks, { ...NEW_BANK }])}>{t('desktop.addBank')}</button>
        </section>

        <section className="st-grid">
          <label className="cf s4"><span>{t('desktop.exportTo')}</span>
            <input value={f.exportTo} onChange={(e) => set('exportTo', e.target.value)} placeholder={t('desktop.optional')} />
          </label>
        </section>

        {error && <p className="warnline" role="alert">{error}</p>}
        {checked && invalid && <p className="warnline" role="alert">{t('desktop.fixAbove', { fields: problems.join(', ') })}</p>}
        {checked && !complete && <p className="warnline">{t('desktop.answerAll')}</p>}
        <div className="st-foot">
          <button type="button" className="btn ghost" onClick={onCancel}>{t('common.cancel')}</button>
          <button type="submit" className="btn primary" data-act="create" disabled={busy || !!stop}>{t('desktop.create')}</button>
        </div>
      </form>
    </div>
  );
}
