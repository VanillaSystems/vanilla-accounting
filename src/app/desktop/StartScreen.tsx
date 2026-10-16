/**
 * The desktop app's first screen (ADR 0009): open existing books, set up new ones with the
 * questions of `npm run init` (src/workspace/setup.ts, checked again by src/workspace/create.ts),
 * or look at a copy of the demo. Shown at /start and whenever no books are open.
 */
import { useEffect, useMemo, useState } from 'react';
import { BANKS, parseIban } from '../../workspace/banks.js';
import { PRESETS, PRESET_NAMES, QUESTIONS, QUESTION_ORDER, asked, firstUnsupported, optionOf, type Answers, type Preset, type QuestionKey } from '../../workspace/setup.js';
import { parseUid } from '../../workspace/uid.js';
import type { DesktopInfo, KnownBooks } from '../../types/desktop.js';
import { LOCALES, t, tData } from '../i18n/index.js';
import { api, errorText } from '../lib/api.js';
import { START_PATH, desktop } from './bridge.js';
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
  /** The approved net tax rates as typed: [percent, label] each, the second row optional. */
  netRates: [string, string][];
  banks: BankRow[];
  exportTo: string;
}

const NO_RATES: [string, string][] = [['', ''], ['', '']];
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

export function StartScreen({ language, onLanguage }: { language: string; onLanguage(code: string): void }) {
  const [info, setInfo] = useState<DesktopInfo | null>(null);
  const [creating, setCreating] = useState(() => new URLSearchParams(location.search).has('new'));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => { void api.desktop.info().then(setInfo, (e) => setError(errorText(e))); }, []);
  useEffect(() => { document.title = 'Vanilla Accounting'; }, []);

  const run = async (open: () => Promise<KnownBooks>) => {
    setBusy(true);
    setError('');
    try {
      await open();
      location.assign('/');
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };
  const chooseAndOpen = async () => {
    const root = await desktop?.chooseFolder(t('desktop.chooseOpen'));
    if (root) await run(() => api.desktop.open(root));
  };

  return (
    <div className="st">
      <header className="st-top">
        <span className="seg2" role="radiogroup" aria-label={t('desktop.language')}>
          {LOCALES.map((l) => (
            <button key={l.code} type="button" role="radio" aria-checked={l.code === language} className={l.code === language ? 'on' : ''} title={l.name} onClick={() => onLanguage(l.code)}>{l.code.toUpperCase()}</button>
          ))}
        </span>
      </header>
      {creating
        ? <CreateForm info={info} busy={busy} error={error} onCancel={() => { setCreating(false); setError(''); history.replaceState(null, '', '/start'); }} onCreate={(setup) => run(() => api.desktop.create(setup))} />
        : (
          <div className="st-main">
            <h1>Vanilla Accounting</h1>
            <p className="st-sub">{info?.open ? t('desktop.switchBooks', { name: info.open.demo ? t('desktop.demoName') : info.open.name ?? info.open.root }) : t('desktop.welcome')}</p>
            <div className="st-choices">
              <button type="button" className="st-choice" data-act="open" disabled={busy} onClick={() => void chooseAndOpen()}>
                <b>{t('desktop.open')}</b><span>{t('desktop.openHint')}</span>
              </button>
              <button type="button" className="st-choice" data-act="new" disabled={busy} onClick={() => { setCreating(true); setError(''); }}>
                <b>{t('desktop.new')}</b><span>{t('desktop.newHint')}</span>
              </button>
              <button type="button" className="st-choice" data-act="demo" disabled={busy} onClick={() => void run(api.desktop.demo)}>
                <b>{t('desktop.demo')}</b><span>{t('desktop.demoHint')}</span>
              </button>
            </div>
            {error && <p className="warnline" role="alert">{error}</p>}
            {!!info?.recent.length && (
              <section className="st-recent">
                <h2>{t('desktop.recent')}</h2>
                {info.recent.map((b) => (
                  <button key={b.root} type="button" className="st-book" disabled={busy || !b.name} onClick={() => void run(() => api.desktop.open(b.root))}>
                    <b>{b.demo ? t('desktop.demoName') : b.name ?? t('desktop.missing')}</b><span className="mono">{b.root}</span>
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

function CreateForm({ info, busy, error, onCancel, onCreate }: {
  info: DesktopInfo | null; busy: boolean; error: string; onCancel(): void;
  onCreate(setup: Parameters<typeof api.desktop.create>[0]): void;
}) {
  const [f, setF] = useState<Form>(() => ({
    preset: 'consultant', name: '', uid: '', owner: '', business: '', language: 'de', root: '',
    answers: { ...PRESETS.consultant.answers }, netRates: NO_RATES, banks: [{ ...NEW_BANK, bank: 'UBS' }], exportTo: '',
  }));
  const [checked, setChecked] = useState(false);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }));
  const setBank = (i: number, patch: Partial<BankRow>) => set('banks', f.banks.map((b, j) => (j === i ? { ...b, ...patch } : b)));

  const root = f.root || (info ? `${info.booksHome}/${t('desktop.folderName', { name: f.name.trim() || t('desktop.folderDefault') }).replace(/[/:]/g, '-')}` : '');
  const questions = QUESTION_ORDER.filter((k) => asked(k, f.answers));
  const netRate = f.answers.vatRegistered === 'yes' && f.answers.vatMethod === 'net-rate';
  const complete = questions.every((k) => 'multi' in QUESTIONS[k] || f.answers[k] !== undefined);
  const stop = complete ? firstUnsupported(f.answers as Answers) : undefined;
  const errors = useMemo(() => {
    const uid = parseUid(f.uid);
    return {
      name: !f.name.trim() ? t('desktop.setup.required.name') : '',
      uid: 'error' in uid ? t('desktop.setup.uid', { detail: f.uid }) : '',
      owner: !f.owner.trim() ? t('desktop.setup.required.owner') : '',
      netRate: netRate && rateOf(f.netRates[0][0]) === undefined ? t('desktop.netRateMissing') : '',
      banks: f.banks.map((b) => (!b.bank.trim() ? t('desktop.setup.bankName') : b.iban.trim() && !parseIban(b.iban) ? t('desktop.setup.iban', { bank: b.bank, detail: b.iban }) : '')),
      bankField: f.banks.map((b) => (!b.bank.trim() ? 'bank' : 'iban')),
    };
  }, [f, netRate]);
  const problems = [
    errors.name && t('desktop.name'), errors.uid && t('desktop.uid'), errors.owner && t('desktop.owner'), errors.netRate && t('desktop.netRates'),
    ...f.banks.map((b, i) => errors.banks[i] && `${t('desktop.iban')} ${b.bank || i + 1}`),
  ].filter(Boolean);
  const invalid = !!(errors.name || errors.uid || errors.owner || errors.netRate || errors.banks.some(Boolean) || f.banks.length === 0);

  const choosePreset = (preset: Preset) => setF((x) => ({ ...x, preset, answers: preset === 'custom' ? x.answers : { ...PRESETS[preset].answers } }));
  const pick = (key: QuestionKey, value: string) => setF((x) => {
    const multi = 'multi' in QUESTIONS[key];
    const now = answerList(x.answers, key);
    const next = multi ? (now.includes(value) ? now.filter((v) => v !== value) : [...now, value]) : value;
    return { ...x, answers: { ...x.answers, [key]: next } };
  });
  const chooseFolder = async () => {
    const dir = await desktop?.chooseFolder(t('desktop.chooseNew'));
    if (dir) set('root', dir);
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
    const netRates = netRate ? f.netRates.flatMap(([percent, label]) => (rateOf(percent) === undefined ? [] : [{ rate: rateOf(percent)!, ...(label.trim() ? { label: label.trim() } : {}) }])) : [];
    onCreate({
      root, preset: f.preset, name: f.name, uid: f.uid, owner: f.owner, business: f.business, language: f.language,
      answers: f.answers as Answers, netRates, banks: f.banks, exportTo: f.exportTo,
    });
  };
  const setRate = (i: 0 | 1, part: 0 | 1, value: string) => set('netRates', f.netRates.map((r, j) => (j === i ? (part === 0 ? [value, r[1]] : [r[0], value]) : r)) as [string, string][]);
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
        </section>

        <section>
          <h2>{t('desktop.questions')}</h2>
          {questions.map((key) => {
            const chosen = answerList(f.answers, key);
            const notes = chosen.map((v) => optionOf(key, v)).filter((o) => o?.unsupported || o?.caveat);
            return (
              <div key={key} className="st-q" data-q={key}>
                <div className="st-qhd"><b>{tData(`desktop.q.${key}.ask`)}</b><span>{tData(`desktop.q.${key}.why`)}</span></div>
                <div className="st-opts" role={'multi' in QUESTIONS[key] ? 'group' : 'radiogroup'} aria-label={tData(`desktop.q.${key}.ask`)}>
                  {QUESTIONS[key].options.map((o) => (
                    <button key={o.value} type="button" role={'multi' in QUESTIONS[key] ? 'checkbox' : 'radio'} aria-checked={chosen.includes(o.value)} className={chosen.includes(o.value) ? 'on' : ''} onClick={() => pick(key, o.value)}>
                      {tData(`desktop.q.${key}.${o.value}`)}
                    </button>
                  ))}
                </div>
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
              <button type="button" className="btn ghost" aria-label={t('desktop.removeBank')} title={t('desktop.removeBank')} disabled={f.banks.length === 1} onClick={() => set('banks', f.banks.filter((_, j) => j !== i))}>×</button>
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
