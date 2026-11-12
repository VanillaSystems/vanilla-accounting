/**
 * The setup conversation before the books exist (#139, src/onboarding/draft.ts), in the wide panel
 * of the start screen: the specialist's words and the answers to click or type, drawn by code from
 * the draft in the folder. Each answer is saved at once; «Ändern» takes one back. Words typed below
 * go to the AI (#145, src/onboarding/draft-talk.ts), which fills what they state, asks back or
 * explains; code checks each answer it read, and those it saved carry «aus deiner Nachricht». Once every step is
 * answered, «Buchhaltung anlegen» writes the books through createWorkspace, the form's own path,
 * and the conversation goes on inside them (src/app/onboarding/state.ts opens it there).
 */
import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { BANKS } from '../../workspace/banks.js';
import { NO_VAT, PRESET_NAMES, QUESTIONS, QUESTION_ORDER, asked, hasWhere, optionOf, unsteered, unsureOf, unusualPeriod, type QuestionKey } from '../../workspace/setup.js';
import type { BankSpec } from '../../workspace/create.js';
import type { NetRate } from '../../workspace/vat-setup.js';
import { DRAFT_PHASES, assumedOf, draftProgress, draftSteps, type DraftPatch, type DraftStep, type Firm, type QuestionValue, type SetupDraft, type SetupDraftView, type StepMark } from '../../onboarding/draft.js';
import type { SetupReply, TalkRefusal } from '../../onboarding/draft-talk.js';
import { LOCALES, t, tData } from '../i18n/index.js';
import { api, errorText, setupText } from '../lib/api.js';
import { BotIcon } from '../areas/automation/Graph.js';
import { ICONS } from '../areas/icons.js';
import { useFollowEnd } from './follow-end.js';

/** As src/onboarding/draft-talk.ts MAX_TEXT: the server refuses a longer message. */
const MAX_TALK = 4000;
import './onboarding.css';

type Send = (patch: DraftPatch) => Promise<boolean>;

const Ai = ({ children }: { children: ReactNode }) => <div className="msg ai obsay"><BotIcon /><div>{children}</div></div>;
const list = (v: QuestionValue | undefined): string[] => ([] as string[]).concat(v ?? []);
const valueLabel = (key: QuestionKey, v: QuestionValue | undefined): string => {
  const values = list(v);
  return values.length ? values.map((x) => tData(`desktop.q.${key}.${x}`)).join(', ') : t('onboarding.draft.none');
};
const firmLine = (f: Firm) => `${f.name} · ${f.uid} · ${f.owner}`;
const ratesLine = (rates: readonly NetRate[]) => rates.map((r) => `${r.rate} %${r.label ? ` ${r.label}` : ''}${r.activityId ? ` (${r.activityId})` : ''}`).join(' · ');
const banksLine = (banks: readonly BankSpec[]) => banks.map((b) => `${b.bank} ${b.currency}${b.iban ? ` · ${b.iban}` : ''}`).join(' · ');

/** A message typed and what came of it; `at`: the step that waited when it was sent, where the turn stays in the conversation. */
interface Turn { at: string; me: string; reply?: SetupReply; error?: string; filled?: Array<{ label: string; value: string }> }

const stepKey = (s: DraftStep) => (s.id === 'question' ? s.key : s.id);
/** An answer taken from the words, as the reply lists it: what it answers and the answer, as saved. */
const filledLine = (m: StepMark, d: SetupDraft): { label: string; value: string } =>
  m === 'firm' ? { label: t('onboarding.draft.firmLabel'), value: d.firm ? firmLine(d.firm) : '' }
    : m === 'preset' ? { label: t('desktop.preset'), value: d.preset ? tData(`desktop.q.preset.${d.preset}`) : '' }
      : m === 'netRates' ? { label: t('desktop.netRates'), value: ratesLine(d.netRates ?? []) }
        : m === 'banks' ? { label: t('desktop.banks'), value: banksLine(d.banks ?? []) }
          : { label: tData(`desktop.q.${m}.ask`), value: valueLabel(m, d.answers[m]) };
const refusalText = (r: TalkRefusal): string =>
  r.reason === 'notStated' ? t(`onboarding.talk.notStated.${r.field}`, { detail: r.detail })
    : r.reason === 'notAnOption' ? t('onboarding.talk.notAnOption', { question: tData(`desktop.q.${r.question}.ask`), value: r.value })
      : r.reason === 'unusualPeriod' ? t(`onboarding.talk.unusualPeriod.${r.method}`)
        : setupText(r);
const FromText = ({ on }: { on: boolean }) => (on ? <span className="obbadge ai" data-from-text>{t('onboarding.talk.fromText')}</span> : null);
/** An answer the kind of firm gave and she never said (#364): marked, with why, until she answers it herself. */
const Assumed = ({ draft, k }: { draft: SetupDraft; k: StepMark }) => (assumedOf(draft).includes(k as QuestionKey)
  ? <span className="obbadge assumed" data-assumed data-tip={draft.assumedBy ? t('onboarding.draft.assumedWhy', { preset: tData(`desktop.q.preset.${draft.assumedBy}`) }) : undefined}>{t('onboarding.draft.assumed')}</span>
  : null);

export function DraftConversation({ root, onLeave }: { root: string; onLeave(): void }) {
  const [view, setView] = useState<SetupDraftView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const turnsBox = useRef<HTMLDivElement>(null);
  const end = useRef<HTMLDivElement>(null);
  useFollowEnd(turnsBox, end);
  /** What an «Ändern» took back, so the step asks again with it filled in. */
  const taken = useRef<Partial<Record<string, unknown>>>({});
  const [turns, setTurns] = useState<Turn[]>([]);
  const [text, setText] = useState('');
  /** Typed words need an AI; without one the buttons and fields carry the conversation (docs/0.4.0/ai-setup.md). */
  const [aiAnswers, setAiAnswers] = useState(true);
  /** «KI ganz ausschalten» on this Mac (issue #212): the words wait for it to be on again. */
  const [aiOff, setAiOff] = useState(false);
  useEffect(() => { void api.desktop.setup(root).then(setView, (e) => setError(errorText(e))); }, [root]);
  useEffect(() => { void api.desktop.ai().then((r) => { setAiAnswers(r.available); setAiOff(r.off === true); }, () => setAiAnswers(false)); }, []);
  const steps = view ? draftSteps(view.draft) : [];

  const send: Send = async (patch) => {
    setBusy(true);
    setError('');
    try {
      setView(await api.desktop.setupPatch(root, patch));
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    } finally { setBusy(false); }
  };
  const talk = async () => {
    const words = text.trim();
    if (!words || busy || !view) return;
    const at = stepKey(steps.at(-1)!);
    setText('');
    setError('');
    setBusy(true);
    setTurns((x) => [...x, { at, me: words }]);
    const settle = (turn: Partial<Turn>) => setTurns((x) => x.map((y, i) => (i === x.length - 1 ? { ...y, ...turn } : y)));
    try {
      const { view: next, reply } = await api.desktop.setupTalk(root, words);
      setView(next);
      settle({ reply, ...(reply.kind === 'read' ? { filled: reply.filled.map((m) => filledLine(m, next.draft)) } : {}) });
    } catch (e) {
      settle({ error: errorText(e) });
    } finally { setBusy(false); }
  };
  const shown = new Set<string>(steps.map(stepKey));
  const turnsAt = (key: string | null) => turns.map((x, i) => ((key === null ? !shown.has(x.at) : x.at === key) ? <TurnView key={i} turn={x} /> : null));
  const change = (key: string, patch: DraftPatch, was: unknown) => { taken.current[key] = was; void send(patch); };
  const progress = view ? draftProgress(view.draft) : undefined;
  const create = async () => {
    setBusy(true);
    setError('');
    try {
      await api.desktop.setupCreate(root);
      location.assign('/');
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  return (
    <div className="obflow" aria-label={t('onboarding.title')}>
      <header className="obflowhd">
        <span className="obwho">
          <span className="obface"><BotIcon /></span>
          <span><b>{t('onboarding.title')}</b><small>{t('onboarding.who')}</small></span>
        </span>
        {/* How far she is (#364): the four parts of the setup, the same for every firm, so the count never jumps. */}
        {progress ? <span className="obcount" data-progress>{t('onboarding.draft.progress', { n: progress.done, of: progress.of })}</span> : null}
        <button type="button" className="linkbtn" data-act="setup-later" data-tip={t('onboarding.draft.laterHint')} onClick={onLeave}>{t('onboarding.draft.later')}</button>
      </header>
      {progress ? (
        <nav className="obrail obphases" aria-label={t('onboarding.rail')}>
          {DRAFT_PHASES.map((p) => (
            <span key={p} data-phase={p} className={progress.phases[p] ? 'done' : p === progress.next ? 'next' : 'open'} data-tip={`${t(`onboarding.draft.phase.${p}`)}: ${t(`onboarding.state.${progress.phases[p] ? 'done' : 'open'}`)}`}>
              <span className="dot" />{t(`onboarding.draft.phase.${p}`)}
            </span>
          ))}
        </nav>
      ) : null}
      <div ref={turnsBox} className="obflowturns">
        <Ai><p>{t('onboarding.draft.hello')}</p><p className="obfolder mono">{root}</p></Ai>
        {view && steps.map((step) => (
          <Fragment key={stepKey(step)}>
            <Step step={step} draft={view.draft} currency={view.baseCurrency} root={root} busy={busy} send={send} change={change} taken={taken.current} onCreate={() => void create()} />
            {turnsAt(stepKey(step))}
          </Fragment>
        ))}
        {turnsAt(null)}
        {error && <p className="warnline" role="alert">{error}</p>}
        <div ref={end} className="obend" />
      </div>
      {view && (
        <form className="obtalk" onSubmit={(e) => { e.preventDefault(); void talk(); }}>
          <div className={busy ? 'obtalkbox busy' : 'obtalkbox'}>
            <textarea
              name="talk" rows={2} maxLength={MAX_TALK} value={text} disabled={!aiAnswers} placeholder={t(aiAnswers ? 'onboarding.talk.placeholder' : aiOff ? 'aiOff.talk' : 'aiSetup.talkWaits')} aria-label={t('onboarding.talk.label')}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void talk(); } }}
            />
            <button type="submit" className="aisend" data-act="setup-talk" aria-label={t('assistant.send')} disabled={busy || !aiAnswers || !text.trim()}>{ICONS.arrowUp}</button>
          </div>
        </form>
      )}
    </div>
  );
}

interface StepProps {
  step: DraftStep; draft: SetupDraft; currency: string; root: string; busy: boolean; send: Send;
  change(key: string, patch: DraftPatch, was: unknown): void;
  taken: Partial<Record<string, unknown>>;
  onCreate(): void;
}

/** A typed message, and the AI's reply: what code saved from it, what it refused and why, the AI's own words. */
function TurnView({ turn }: { turn: Turn }) {
  const r = turn.reply;
  return (
    <div className="obturn" data-turn>
      <div className="obme"><div className="msg me">{turn.me}</div></div>
      {turn.error ? <p className="warnline" role="alert">{turn.error}</p>
        : !r ? <Ai><p className="obwhy">{t('onboarding.talk.reading')}</p></Ai>
          : r.kind === 'unreadable' ? <Ai><p>{t('onboarding.talk.unreadable')}</p></Ai>
            : r.kind === 'failed' ? <Ai><p>{t('onboarding.talk.failed', { detail: r.detail })}</p></Ai>
              : (
                <Ai>
                  {turn.filled?.length ? (
                    <div data-filled>
                      <p>{t('onboarding.talk.filled')}</p>
                      <dl className="obkv obfilled">{turn.filled.map((x) => <Fragment key={x.label}><dt>{x.label}</dt><dd>{x.value}</dd></Fragment>)}</dl>
                    </div>
                  ) : null}
                  {r.refused.map((x, i) => <p key={i} className="obrefused" data-refused={x.step}>{t('onboarding.talk.refused', { why: refusalText(x.refusal) })}</p>)}
                  {r.say ? <p>{r.say}</p> : null}
                  {!r.filled.length && !r.refused.length && !r.say ? <p>{t('onboarding.talk.nothing')}</p> : null}
                </Ai>
              )}
    </div>
  );
}

/** The person's answer, with «Ändern» beside it. */
const Answer = ({ text, busy, fromText, assumed, onChange }: { text: string; busy: boolean; fromText: boolean; assumed?: ReactNode; onChange(): void }) => (
  <div className="obme">
    <button type="button" className="linkbtn" disabled={busy} onClick={onChange}>{t('onboarding.change')}</button>
    <FromText on={fromText} />
    {assumed}
    <div className="msg me">{text}</div>
  </div>
);

function Step({ step, draft, currency, root, busy, send, change, taken, onCreate }: StepProps) {
  const marked = (m: StepMark) => !!draft.fromText?.includes(m);
  switch (step.id) {
    case 'firm': return (
      <div className="obstep" data-step="firm">
        {/* What her words said of the firm is kept in the draft (`said`): the card starts with it, and only what is empty is asked. */}
        <Ai><p>{t(!step.answer && draft.said && Object.keys(draft.said).length ? 'onboarding.draft.firmRest' : 'onboarding.draft.firm')}</p></Ai>
        {step.answer
          ? <Answer text={firmLine(step.answer)} busy={busy} fromText={marked('firm')} onChange={() => change('firm', { step: 'firm', value: null }, step.answer)} />
          : <div className="obind"><FirmCard key={JSON.stringify(draft.said ?? {})} initial={(taken.firm as Firm | undefined) ?? draft.said} busy={busy} send={send} /></div>}
      </div>
    );
    case 'preset': return (
      <div className="obstep" data-step="preset">
        <Ai><p>{t('onboarding.draft.preset', { name: draft.firm?.name ?? '' })}</p></Ai>
        {step.answer
          ? <Answer text={tData(`desktop.q.preset.${step.answer}`)} busy={busy} fromText={marked('preset')} onChange={() => change('preset', { step: 'preset', value: null }, step.answer)} />
          : (
            <div className="obind"><div className="qacts" role="group" aria-label={t('desktop.preset')}>
              {PRESET_NAMES.map((p) => <button key={p} type="button" className="btn" disabled={busy} data-answer={p} onClick={() => void send({ step: 'preset', value: p })}>{tData(`desktop.q.preset.${p}`)}</button>)}
            </div></div>
          )}
      </div>
    );
    case 'question': return <QuestionStep step={step} draft={draft} busy={busy} send={send} change={change} fromText={marked(step.key)} />;
    case 'netRates': return (
      <div className="obstep" data-step="netRates">
        <Ai><p>{t('onboarding.draft.netRates')}</p></Ai>
        {step.answer
          ? <Answer text={ratesLine(step.answer)} busy={busy} fromText={marked('netRates')} onChange={() => change('netRates', { step: 'netRates', value: null }, step.answer)} />
          : <div className="obind"><RatesCard initial={taken.netRates as NetRate[] | undefined} busy={busy} send={send} /></div>}
      </div>
    );
    case 'banks': return (
      <div className="obstep" data-step="banks">
        <Ai><p>{t('onboarding.draft.banks')}</p></Ai>
        {step.answer
          ? <Answer text={banksLine(step.answer)} busy={busy} fromText={marked('banks')} onChange={() => change('banks', { step: 'banks', value: null }, step.answer)} />
          : <div className="obind"><BanksCard initial={taken.banks as BankSpec[] | undefined} currency={currency} busy={busy} send={send} /></div>}
      </div>
    );
    case 'review': return <Review draft={draft} root={root} busy={busy} change={change} onCreate={onCreate} />;
  }
}

function QuestionStep({ step, draft, busy, send, change, fromText }: { step: Extract<DraftStep, { id: 'question' }>; draft: SetupDraft; busy: boolean; send: Send; change: StepProps['change']; fromText: boolean }) {
  const { key } = step;
  /** «Weiss nicht»: the answer the setup takes then, named on the button (src/workspace/setup.ts `unsure`). */
  const unsure = unsureOf(key);
  /** A period granted only on request, chosen by click: taken, with what is usual said after it. */
  const odd = key === 'period' && step.answer !== undefined ? unusualPeriod(draft.answers) : undefined;
  const multi = 'multi' in QUESTIONS[key];
  const [on, setOn] = useState<string[]>(() => list(step.suggested));
  const notes = list(step.answer).map((v) => optionOf(key, v)).filter((o) => o?.caveat);
  const pick = (value: string) => (multi ? setOn((x) => (x.includes(value) ? x.filter((y) => y !== value) : [...x, value])) : void send({ step: 'question', key, value }));
  return (
    <div className="obstep" data-step={key}>
      {key === 'vatRegistered' ? <Ai><p>{t('onboarding.draft.vat')}</p></Ai> : null}
      <Ai><p>{tData(`desktop.q.${key}.ask`)}</p><p className="obwhy">{tData(`desktop.q.${key}.why`)}</p>{hasWhere(key) ? <p className="obwhy obwhere" data-where>{tData(`desktop.q.${key}.where`)}</p> : null}</Ai>
      {step.answer !== undefined ? (
        <>
          <Answer text={valueLabel(key, step.answer)} busy={busy} fromText={fromText} assumed={<Assumed draft={draft} k={key} />} onChange={() => change(key, { step: 'question', key, value: null }, step.answer)} />
          {notes.map((o) => <Ai key={o!.value}><p>{tData(`desktop.q.${key}.${o!.value}.caveat`)}</p></Ai>)}
          {odd ? <Ai><p data-unusual>{t(`onboarding.draft.periodUnusual.${odd.method}`)}</p></Ai> : null}
        </>
      ) : (
        <div className="obind">
          <div className="qacts" role="group" aria-label={tData(`desktop.q.${key}.ask`)}>
            {QUESTIONS[key].options.map((o) => {
              const chosen = multi ? on.includes(o.value) : list(step.suggested).includes(o.value);
              return (
                <button key={o.value} type="button" role={multi ? 'checkbox' : undefined} aria-checked={multi ? chosen : undefined} className={`btn${chosen ? ' primary' : ''}`} disabled={busy} data-answer={o.value} onClick={() => pick(o.value)}>
                  {tData(`desktop.q.${key}.${o.value}`)}
                </button>
              );
            })}
            {multi ? <button type="button" className="btn" disabled={busy || ('required' in QUESTIONS[key] && !on.length)} data-act="question-next" onClick={() => void send({ step: 'question', key, value: on })}>{t('onboarding.draft.next')}</button> : null}
            {unsure ? <button type="button" className="btn ghost" disabled={busy} data-act="question-unsure" onClick={() => void send({ step: 'question', key, value: unsure })}>{t('onboarding.draft.unsure', { answer: tData(`desktop.q.${key}.${unsure}`) })}</button> : null}
            {/* the answer «we file no VAT returns» (#347): «nein» to the registration, the same patch as that answer. */}
            {unsteered(key) ? <button type="button" className="btn" disabled={busy} data-answer={NO_VAT} onClick={() => void send({ step: 'question', key: 'vatRegistered', value: 'no' })}>{t('desktop.q.noVat')}</button> : null}
          </div>
          {unsteered(key) ? <p className="obwhy" data-no-vat-hint>{t('desktop.q.noVat.hint')}</p> : null}
        </div>
      )}
    </div>
  );
}

function FirmCard({ initial, busy, send }: { initial?: Partial<Firm>; busy: boolean; send: Send }) {
  const [f, setF] = useState<Firm>({ name: '', uid: '', owner: '', ...initial });
  const set = (k: keyof Firm) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  return (
    <form className="obcard obform" noValidate onSubmit={(e) => { e.preventDefault(); void send({ step: 'firm', value: f }); }}>
      <label><span>{t('desktop.name')}</span><input name="name" value={f.name} placeholder={t('desktop.namePh')} onChange={set('name')} autoFocus={!initial?.name} /></label>
      <label><span>{t('desktop.uid')}</span><input name="uid" className="mono" value={f.uid} placeholder={t('desktop.uidPh')} onChange={set('uid')} /></label>
      <label><span>{t('desktop.owner')}</span><input name="owner" value={f.owner} onChange={set('owner')} /></label>
      <div className="actions"><button type="submit" className="btn primary" data-act="firm-next" disabled={busy || !f.name.trim() || !f.uid.trim() || !f.owner.trim()}>{t('onboarding.draft.next')}</button></div>
    </form>
  );
}

const NO_RATE = { rate: '', label: '', activityId: '' };

function RatesCard({ initial, busy, send }: { initial?: NetRate[]; busy: boolean; send: Send }) {
  const [rows, setRows] = useState(() => [0, 1].map((i) => (initial?.[i] ? { rate: String(initial[i].rate), label: initial[i].label ?? '', activityId: initial[i].activityId ?? '' } : { ...NO_RATE })));
  const set = (i: number, k: keyof typeof NO_RATE, v: string) => setRows((x) => x.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  const rates = rows.filter((r) => r.rate.trim()).map((r) => ({
    rate: Number(r.rate.trim().replace(',', '.').replace(/\s*%$/, '')),
    ...(r.label.trim() ? { label: r.label.trim() } : {}), ...(r.activityId.trim() ? { activityId: r.activityId.trim().toUpperCase() } : {}),
  }));
  return (
    <form className="obcard obform" noValidate onSubmit={(e) => { e.preventDefault(); void send({ step: 'netRates', value: rates }); }}>
      <span className="rk">{t('desktop.netRateHint')}</span>
      {rows.map((r, i) => (
        <div key={i} className="obrow3">
          <label><span>{t(i === 0 ? 'desktop.netRate1' : 'desktop.netRate2')}</span><input name={`netRate${i + 1}`} className="mono" inputMode="decimal" value={r.rate} onChange={(e) => set(i, 'rate', e.target.value)} /></label>
          <label><span>{t('desktop.netRateLabel')}</span><input value={r.label} placeholder={t('desktop.optional')} onChange={(e) => set(i, 'label', e.target.value)} /></label>
          <label><span>{t('desktop.netRateActivityId')}</span><input className="mono" maxLength={5} value={r.activityId} placeholder={t('desktop.optional')} onChange={(e) => set(i, 'activityId', e.target.value)} /></label>
        </div>
      ))}
      <div className="actions"><button type="submit" className="btn primary" disabled={busy || !rates.length}>{t('onboarding.draft.next')}</button></div>
    </form>
  );
}

type BankRow = { bank: string; currency: string; iban: string };

function BanksCard({ initial, currency, busy, send }: { initial?: BankSpec[]; currency: string; busy: boolean; send: Send }) {
  const blank: BankRow = { bank: '', currency, iban: '' };
  const [rows, setRows] = useState<BankRow[]>(() => (initial?.length ? initial.map((b) => ({ bank: b.bank, currency: b.currency, iban: b.iban ?? '' })) : [blank]));
  const set = (i: number, k: keyof BankRow, v: string) => setRows((x) => x.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  return (
    <form className="obcard obform" noValidate onSubmit={(e) => { e.preventDefault(); void send({ step: 'banks', value: rows }); }}>
      <datalist id="ob-banks">{Object.keys(BANKS).map((b) => <option key={b} value={b} />)}</datalist>
      {rows.map((r, i) => (
        <div key={i} className="obbankrow">
          <label><span>{t('desktop.bank')}</span><input name={`bank${i + 1}`} list="ob-banks" value={r.bank} onChange={(e) => set(i, 'bank', e.target.value)} /></label>
          <label><span>{t('desktop.currency')}</span><input className="mono" maxLength={3} value={r.currency} onChange={(e) => set(i, 'currency', e.target.value.toUpperCase())} /></label>
          <label><span>{t('desktop.iban')}</span><input name={`iban${i + 1}`} className="mono" value={r.iban} placeholder={t('desktop.optional')} onChange={(e) => set(i, 'iban', e.target.value)} /></label>
          <button type="button" className="btn ghost" aria-label={t('desktop.removeBank')} disabled={rows.length === 1} onClick={() => setRows((x) => x.filter((_, j) => j !== i))}>×</button>
        </div>
      ))}
      <div className="actions">
        <button type="button" className="btn ghost" onClick={() => setRows((x) => [...x, { ...blank }])}>{t('desktop.addBank')}</button>
        <button type="submit" className="btn primary" data-act="banks-next" disabled={busy || rows.some((r) => !r.bank.trim())}>{t('onboarding.draft.next')}</button>
      </div>
    </form>
  );
}

/** Everything the books are created with, each with «Ändern»; the answers a preset gave are changed here. */
function Review({ draft, root, busy, change, onCreate }: { draft: SetupDraft; root: string; busy: boolean; change: StepProps['change']; onCreate(): void }) {
  const questions = QUESTION_ORDER.filter((k) => asked(k, draft.answers));
  const lang = LOCALES.find((l) => l.code === draft.language)?.name ?? draft.language;
  const marked = (m: StepMark) => !!draft.fromText?.includes(m);
  return (
    <div className="obstep" data-step="review">
      <Ai>
        <p>{t('onboarding.draft.review')}</p>
        {draft.fromText?.length ? <p className="obwhy">{t('onboarding.talk.reviewNote')}</p> : null}
        {assumedOf(draft).length ? <p className="obwhy" data-assumed-note>{draft.assumedBy ? t('onboarding.draft.assumedNote', { preset: tData(`desktop.q.preset.${draft.assumedBy}`) }) : t('onboarding.draft.assumedNoteBare')}</p> : null}
      </Ai>
      <div className="obind">
        <div className="obcard">
          <h4>{t('onboarding.draft.reviewTitle')}</h4>
          <dl className="obkv obreview">
            {draft.firm ? <><dt>{t('onboarding.draft.firmLabel')}</dt><dd>{firmLine(draft.firm)} <FromText on={marked('firm')} /></dd><dd /></> : null}
            {draft.preset ? <><dt>{t('desktop.preset')}</dt><dd>{tData(`desktop.q.preset.${draft.preset}`)} <FromText on={marked('preset')} /></dd><dd /></> : null}
            {questions.map((k) => (
              <ReviewRow key={k} label={tData(`desktop.q.${k}.ask`)} value={k === 'vatRegistered' && draft.answers[k] === 'no' ? t('onboarding.draft.noVat') : valueLabel(k, draft.answers[k])} fromText={marked(k)} assumed={<Assumed draft={draft} k={k} />} busy={busy} onChange={() => change(k, { step: 'question', key: k, value: null }, draft.answers[k])} />
            ))}
            {draft.netRates?.length ? <><dt>{t('desktop.netRates')}</dt><dd>{ratesLine(draft.netRates)} <FromText on={marked('netRates')} /></dd><dd /></> : null}
            {draft.banks ? <><dt>{t('desktop.banks')}</dt><dd>{banksLine(draft.banks)} <FromText on={marked('banks')} /></dd><dd /></> : null}
            <dt>{t('desktop.flow.language')}</dt><dd>{lang}</dd><dd />
            <dt>{t('desktop.folder')}</dt><dd className="mono">{root}</dd><dd />
          </dl>
          <div className="actions"><button type="button" className="aiact primary" data-act="setup-create" disabled={busy} onClick={onCreate}>{busy ? t('onboarding.draft.creating') : t('desktop.create')}</button></div>
        </div>
      </div>
    </div>
  );
}

const ReviewRow = ({ label, value, fromText, assumed, busy, onChange }: { label: string; value: string; fromText: boolean; assumed: ReactNode; busy: boolean; onChange(): void }) => (
  <><dt>{label}</dt><dd>{value} <FromText on={fromText} />{assumed}</dd><dd><button type="button" className="linkbtn" disabled={busy} onClick={onChange}>{t('onboarding.change')}</button></dd></>
);
