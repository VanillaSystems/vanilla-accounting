/**
 * The setup conversation as the code draws it (docs/0.4.0/onboarding.md): each step's words, its
 * card and its answers to click, the person's answer, and what follows it, between the AI's turns
 * in the order they happened. The cards show what the app knows (src/onboarding/facts.ts); a VAT
 * change waits on its card for «Übernehmen», saved through the Firma page's own path.
 */
import { Fragment, createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { t } from '../i18n/index.js';
import { fmt } from '../lib/utils.js';
import { api, errorText } from '../lib/api.js';
import { BotIcon } from '../areas/automation/Graph.js';
import { ICONS } from '../areas/icons.js';
import { RuleDraft } from '../areas/company/RulesSection.js';
import { closeAssistant, sendMessage } from '../assistant/store.js';
import type { Route } from '../shell/route.js';
import type { Turn } from '../../types/assistant.js';
import type { ClearPartner } from '../../onboarding/facts.js';
import { askedAt, vatLine, vatSetupOf, type Line, type Origin, type SetupCard, type SetupStep } from '../../onboarding/conversation.js';
import type { QuestionId } from '../../onboarding/model.js';
import { placeKeys, type HandPlace } from '../../onboarding/hand.js';
import { answer, keepSells, keepVat, setupReady, undoVat, useSetup } from './state.js';
import { kindsOfAnswer } from '../../onboarding/model.js';
import { salesKinds, type SalesKind } from '../../workspace/setup.js';
import { say } from './words.js';
import { useNoAi } from '../ai/no-ai.js';

/** No AI answers on this Mac (#364): the conversation offers only what works without one. */
const NoAi = createContext(false);
/** A line in the words for this Mac: its `noAi` words while no AI answers. */
const useLine = () => { const noAi = useContext(NoAi); return (l: Line) => say(noAi && l.noAi ? l.noAi : l); };

type Go = (route: Route) => void;

const placeOf = (go: HandPlace) => placeKeys(go).map((k) => t(k as 'area.company')).join(' › ');

const Ai = ({ children }: { children: ReactNode }) => <div className="msg ai obsay"><BotIcon /><div>{children}</div></div>;
const ByHand = ({ go, onGo }: { go: HandPlace; onGo: Go }) => (
  <button type="button" className="linkbtn obhand" onClick={() => onGo(go)}>{t('onboarding.byHand', { place: placeOf(go) })}</button>
);

/**
 * The steps and the AI's turns in one thread, in the order they happened: a step's question where it
 * was asked (when the step before it was answered), its answer and what follows where it was
 * answered, the AI's turns where they were sent. An answer the AI recorded for the person thus
 * follows the message that gave it.
 */
export function SetupConversation({ turns, turn, onGo, noAi: columnNoAi }: { turns: Turn[]; turn(t: Turn, i: number): ReactNode; onGo: Go; noAi?: boolean }) {
  const { steps, error } = useSetup();
  const noAi = useNoAi() || !!columnNoAi;
  useNewestStep(steps?.at(-1)?.id);
  if (!steps) return null;
  const times = askedAt(steps);
  const events: Array<{ at: string; node: ReactNode }> = [];
  steps.forEach((step, n) => {
    events.push({ at: times[n], node: <Question key={`q-${step.id}`} step={step} onGo={onGo} /> });
    if (step.answer) events.push({ at: step.answer.at, node: <Answered key={`a-${step.id}`} step={step} onGo={onGo} /> });
  });
  turns.forEach((x, i) => events.push({ at: x.at, node: <Fragment key={`t${i}`}>{turn(x, i)}</Fragment> }));
  // A stable sort: what happened at the same moment keeps the order it was pushed in.
  const ordered = events.map((e, i) => ({ ...e, i })).sort((x, y) => (x.at < y.at ? -1 : x.at > y.at ? 1 : x.i - y.i));
  return <NoAi.Provider value={noAi}>{ordered.map((e) => e.node)}{error ? <p className="warnline">{error}</p> : null}</NoAi.Provider>;
}

/**
 * The newest step in sight (#364): a question that appears after an answer is scrolled into view (as
 * little as needed), the summary to its top, so its first step and button show; the summary also when
 * the setup opens on it again. After the sidebar's own scroll to its end, which runs after this
 * effect when both mount together; smooth only without prefers-reduced-motion.
 */
function useNewestStep(id: string | undefined): void {
  const shown = useRef<string>();
  useEffect(() => {
    const was = shown.current;
    shown.current = id;
    if (!id || id === was || (was === undefined && id !== 'summary')) return;
    const frame = requestAnimationFrame(() => {
      const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
      document.querySelector(`.aside.setup .obstep[data-step="${id}"]`)?.scrollIntoView({ block: id === 'summary' ? 'start' : 'nearest', behavior: reduced ? 'auto' : 'smooth' });
    });
    return () => cancelAnimationFrame(frame);
  }, [id]);
}

function Question({ step, onGo }: { step: SetupStep; onGo: Go }) {
  const { busy } = useSetup();
  const line = useLine();
  return (
    <div className="obstep" data-step={step.id}>
      {step.say.map((l, i) => <Ai key={i}><p>{line(l)}</p></Ai>)}
      {step.card ? <div className="obind"><Card card={step.card} onGo={onGo} /></div> : null}
      {step.go && !step.answer ? <div className="obind"><ByHand go={step.go} onGo={onGo} /></div> : null}
      {!step.answer && step.multi ? <div className="obind"><Toggles step={step} /></div> : null}
      {!step.answer && step.choices.length && !step.multi ? (
        <div className="obind">
          <div className="qacts" role="group" aria-label={say(step.say.at(-1)!)}>
            {step.choices.map((c) => (
              <button key={c.value} type="button" className={`btn${c.primary ? ' primary' : ''}`} disabled={busy} data-answer={c.value} onClick={() => void answer(step.id as QuestionId, c.value)}>
                {say(c.label)}{c.sub ? <small>{say(c.sub)}</small> : null}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** A step whose choices go together (`sells`): each a toggle, started from what the app has, sent with «Weiter». */
function Toggles({ step }: { step: SetupStep }) {
  const { busy } = useSetup();
  const [on, setOn] = useState<string[]>(() => step.choices.filter((c) => c.primary).map((c) => c.value));
  const flip = (v: string) => setOn((x) => (x.includes(v) ? x.filter((y) => y !== v) : [...x, v]));
  const kinds = salesKinds(on);
  return (
    <div className="qacts" role="group" aria-label={say(step.say.at(-1)!)}>
      {step.choices.map((c) => (
        <button key={c.value} type="button" role="checkbox" aria-checked={on.includes(c.value)} className={`btn${on.includes(c.value) ? ' primary' : ''}`} disabled={busy} data-answer={c.value} onClick={() => flip(c.value)}>
          {say(c.label)}{c.sub ? <small>{say(c.sub)}</small> : null}
        </button>
      ))}
      <button type="button" className="btn" disabled={busy || !kinds.length} data-tip={kinds.length ? undefined : t('onboarding.sellsCard.none')} data-act="sells-next" onClick={() => void keepSells(kinds)}>{t('onboarding.sellsCard.next')}</button>
    </div>
  );
}

function Answered({ step, onGo }: { step: SetupStep; onGo: Go }) {
  const { busy } = useSetup();
  const picked = step.multi && step.answer ? step.choices.filter((c) => kindsOfAnswer(step.answer!.value).includes(c.value as SalesKind)) : [];
  // The firm's card is shown, not asked: its answer («Etwas ändern», or «Stimmt so» of older books) has no button to find the words in.
  const chosen = step.multi ? (picked.length ? { label: picked.map((c) => say(c.label)).join(', ') } : undefined)
    : step.id === 'company' && step.answer ? { label: say({ key: `onboarding.q.company.${step.answer.value}` }) }
      : step.choices.find((c) => c.value === step.answer?.value);
  return (
    <div className="obstep" data-answered={step.id}>
      {chosen ? (
        <div className="obme">
          <button type="button" className="linkbtn" disabled={busy} onClick={() => void answer(step.id as QuestionId, null)}>{t('onboarding.change')}</button>
          <div className="msg me">{typeof chosen.label === 'string' ? chosen.label : say(chosen.label)}</div>
        </div>
      ) : null}
      {step.reply?.lines.map((l, i) => <Ai key={i}><p>{say(l)}</p></Ai>)}
      {step.reply?.card ? <div className="obind"><Card card={step.reply.card} onGo={onGo} /></div> : null}
      {step.reply?.go ? <div className="obind"><ByHand go={step.reply.go} onGo={onGo} /></div> : null}
    </div>
  );
}

function Card({ card, onGo }: { card: SetupCard; onGo: Go }) {
  switch (card.kind) {
    case 'company': return <CompanyCard card={card} />;
    case 'vat': return <VatCard card={card} onGo={onGo} />;
    case 'sells': return <SellsCard card={card} />;
    case 'opening': return (
      <div className="obcard">
        <table className="obtable">
          <thead><tr><th>{t('onboarding.opening.account')}</th><th /><th className="n">{t('onboarding.opening.amount')}</th></tr></thead>
          <tbody>{card.rows.map((r) => <tr key={r.account}><td className="mono">{r.account}</td><td>{r.name}</td><td className="n">{fmt(r.amount)}</td></tr>)}</tbody>
        </table>
      </div>
    );
    case 'banks': return (
      <div className="obcard">
        {card.banks.length ? (
          <ul className="obcheck">
            {card.banks.map((b) => (
              <li key={`${b.bank} ${b.currency}`}>{ICONS.bank}<b>{b.label}</b>
                <span className={`obbadge ${b.iban ? 'pos' : 'warn'}`}>{b.iban ? t('onboarding.banks.iban') : t('onboarding.banks.noIban')}</span>
                <span className="rk mono">{[b.currency, b.account, b.iban?.replace(/(.{4})/g, '$1 ').trim()].filter(Boolean).join(' · ')}</span>
              </li>
            ))}
          </ul>
        ) : <span className="rk">{t('onboarding.banks.none')}</span>}
        <span className="rk">{t('onboarding.banks.statements')}</span>
        <div className="actions"><button type="button" className="aiact" onClick={() => onGo({ area: 'company', section: 'banks' })}>{ICONS.plus}{t('onboarding.banks.add')}</button></div>
      </div>
    );
    case 'sources': return <SourcesCard card={card} onGo={onGo} />;
    case 'partners': return <PartnersCard card={card} onGo={onGo} />;
    case 'summary': return <SummaryCard card={card} onGo={onGo} />;
  }
}

/** What the app knows of the firm, shown once; «Etwas ändern» opens the questions behind it. */
function CompanyCard({ card }: { card: Extract<SetupCard, { kind: 'company' }> }) {
  const { busy } = useSetup();
  const { company: c, origin } = card;
  const address = c.address && [[c.address.street, c.address.number].filter(Boolean).join(' '), `${c.address.postcode} ${c.address.town}`.trim()].filter(Boolean).join(', ');
  const rows: Array<[string, ReactNode]> = [
    [t('onboarding.company.name'), c.name],
    [t('onboarding.company.uid'), <span className="mono">{c.uid}</span>],
    ...(c.legalForm ? [[t('onboarding.company.legalForm'), c.legalForm] as [string, ReactNode]] : []),
    ...(c.owner ? [[t('onboarding.company.owner'), c.owner] as [string, ReactNode]] : []),
    ...(address ? [[t('onboarding.company.address'), address] as [string, ReactNode]] : []),
    [t('onboarding.company.vat'), say(vatLine(c.vat))],
    ...(card.sells ? [[t('onboarding.company.sells'), card.sells.map((k) => t(`onboarding.sellsCard.kind.${k}`)).join(', ')] as [string, ReactNode]] : []),
  ];
  return (
    <div className="obcard">
      <dl className="obkv">
        {rows.map(([k, v], i) => <Fragment key={k}><dt>{k}</dt><dd>{v}</dd><dd>{i === 0 ? <span className="obbadge">{t(`onboarding.origin.${origin}`)}</span> : null}</dd></Fragment>)}
      </dl>
      {card.change ? <div className="actions"><button type="button" className="linkbtn" disabled={busy} data-answer="fix" onClick={() => void answer('company', 'fix')}>{t('onboarding.q.company.fix')}</button></div> : null}
    </div>
  );
}

function VatCard({ card, onGo }: { card: Extract<SetupCard, { kind: 'vat' }>; onGo: Go }) {
  const { view } = useSetup();
  const [rate, setRate] = useState('');
  const [label, setLabel] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const kept = view?.progress.answers.vat?.kept;
  const percent = Number(rate.replace(',', '.'));
  const next = vatSetupOf(card.to, rate && percent > 0 && percent < 100 ? { rate: percent, ...(label.trim() ? { label: label.trim() } : {}) } : undefined, card.from.registered ? card.from.reporting : 'received');
  const run = async (f: () => Promise<string | undefined>) => { setBusy(true); setError(await f()); setBusy(false); };
  return (
    <div className="ruledraft obvat" data-state={card.state}>
      <b>{t('onboarding.vatCard.title')}</b>
      <span><span className="m">{say(vatLine(card.from))}</span>{' → '}<b>{t(`onboarding.vatCard.to.${card.to}`)}</b></span>
      {card.state === 'proposed' && card.to === 'net-rate' ? (
        <span className="obrate">
          <label>{t('onboarding.vatCard.rate')}<input inputMode="decimal" value={rate} placeholder="4.5" onChange={(e) => setRate(e.target.value)} /></label>
          <label>{t('onboarding.vatCard.label')}<input value={label} placeholder={t('onboarding.vatCard.labelHint')} onChange={(e) => setLabel(e.target.value)} /></label>
        </span>
      ) : null}
      {card.state === 'proposed' ? <span className="m">{t('onboarding.vatCard.lead')}</span> : <span className="okline">{ICONS.check}{t('onboarding.vatCard.kept')}</span>}
      <span className="ruleacts">
        {card.state === 'proposed'
          ? <button type="button" className="btn primary" disabled={busy || !next} onClick={() => void run(() => keepVat(next!, card.from))}>{t('onboarding.vatCard.take')}</button>
          : kept ? <button type="button" className="linkbtn" disabled={busy} onClick={() => void run(() => undoVat(kept.before))}>{t('assistant.undo')}</button> : null}
        <button type="button" className="linkbtn" onClick={() => onGo({ area: 'company', section: 'vat' })}>{t('assistant.show')}</button>
      </span>
      {error ? <span className="warnline">{error}</span> : null}
    </div>
  );
}

/** The default accounts an answer to «Was verkauft ihr?» gives; «Übernehmen» while the company's profile says otherwise. */
function SellsCard({ card }: { card: Extract<SetupCard, { kind: 'sells' }> }) {
  const { busy } = useSetup();
  return (
    <div className="ruledraft obsells" data-state={card.state}>
      <b>{t('onboarding.sellsCard.title')}</b>
      <dl className="obkv">
        {card.purchase.length ? <><dt>{t('onboarding.sellsCard.purchase')}</dt><dd>{card.purchase.map((p) => `${t(`onboarding.sellsCard.buy.${p.kind as 'made'}`)} → ${p.account}`).join(' · ')}</dd><dd /></> : null}
        <dt>{t('onboarding.sellsCard.sales')}</dt><dd>{card.sales.map((s) => `${t(`onboarding.sellsCard.kind.${s.kind}`)} → ${s.account}`).join(' · ')}</dd><dd />
      </dl>
      {card.state === 'proposed'
        ? <><span className="m">{t('onboarding.sellsCard.lead')}</span><span className="ruleacts"><button type="button" className="btn primary" disabled={busy} onClick={() => void keepSells(card.kinds)}>{t('onboarding.sellsCard.take')}</button></span></>
        : <span className="okline">{ICONS.check}{t('onboarding.sellsCard.kept')}</span>}
    </div>
  );
}

function SourcesCard({ card, onGo }: { card: Extract<SetupCard, { kind: 'sources' }>; onGo: Go }) {
  const lang = document.documentElement.lang || 'de';
  // «Mit mir einrichten» asks the AI: offered only while one answers; otherwise its place says so and leads to setting one up (#364).
  const noAi = useContext(NoAi);
  return (
    <div className="obcard">
      {card.sources.length ? (
        <ul className="obcheck">{card.sources.map((s) => <li key={s.id}>{ICONS.receipts}<b>{s.label[lang] ?? s.label.en}</b><span className="obbadge pos">{t('onboarding.sources.on')}</span></li>)}</ul>
      ) : <span className="rk">{t('onboarding.sources.none')}</span>}
      {noAi ? <span className="rk" data-testid="sources-no-ai">{t('onboarding.sources.noAi')}</span> : null}
      <div className="actions">
        {noAi
          ? <button type="button" className="aiact" data-act="ai-set-up" onClick={() => onGo({ area: 'company', section: 'ai' })}>{t('aiSetup.line.setUp')}</button>
          : <button type="button" className="aiact primary" data-act="sources-ask" onClick={() => void sendMessage(t('onboarding.sources.askText'), undefined)}>{t('onboarding.sources.ask')}</button>}
        <button type="button" className="aiact" onClick={() => onGo({ area: 'company', section: 'sources' })}>{t('onboarding.sources.show')}</button>
      </div>
    </div>
  );
}

/** A partner always booked the same way, opened: «Als Regel entwerfen» drafts the rule by hand's path, shown on the rule card with «Behalten». */
function ClearRow({ p, onGo }: { p: ClearPartner; onGo: Go }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<string>();
  const [error, setError] = useState<string>();
  const make = () => {
    setError(undefined);
    api.draftHand({ match: { kind: 'business', id: p.id }, account: p.account, vat: p.vat ?? null }).then((r) => setDraft(r.path), (e: unknown) => setError(errorText(e)));
  };
  return (
    <li>
      <button type="button" className="obrow" aria-expanded={open} onClick={() => setOpen(!open)}>
        {ICONS.right}<span className="nm">{p.name}</span><span className="ev">{t('onboarding.partners.times', { n: p.n })}</span>
        <span className="bk">{p.account} {p.accountName}{p.vat ? ` · ${p.vat}` : ''}</span><span className="sm">{fmt(p.sum)}</span>
      </button>
      {open ? (
        <div className="obrowmore">
          {draft ? <RuleDraft path={draft} onRules={() => onGo({ area: 'company', section: 'rules' })} /> : (
            <span className="actions">
              <button type="button" className="aiact" onClick={make}>{t('onboarding.partners.draft')}</button>
              <button type="button" className="linkbtn" onClick={() => onGo({ area: 'partners', id: p.id })}>{t('onboarding.partners.page')}</button>
            </span>
          )}
          {error ? <span className="warnline">{error}</span> : null}
        </div>
      ) : null}
    </li>
  );
}

function PartnersCard({ card, onGo }: { card: Extract<SetupCard, { kind: 'partners' }>; onGo: Go }) {
  return (
    <div className="obcard">
      {card.clear.length ? (
        <div className="obbin">
          <div className="obbinh"><b>{t('onboarding.partners.clear')}</b><span className="count">{card.clear.length}</span><span className="rk">{t('onboarding.partners.clearWhy')}</span></div>
          <ul className="obrows">{card.clear.map((p) => <ClearRow key={p.id} p={p} onGo={onGo} />)}</ul>
        </div>
      ) : null}
      {card.mixed.length ? (
        <div className="obbin">
          <div className="obbinh"><b>{t('onboarding.partners.mixed')}</b><span className="count">{card.mixed.length}</span><span className="rk">{t('onboarding.partners.mixedWhy')}</span></div>
          <div className="obmix">
            {card.mixed.map((m) => (
              <Fragment key={m.id}>
                <button type="button" className="linkbtn" onClick={() => onGo({ area: 'partners', id: m.id })}>{m.name} <span className="rk">{t('onboarding.partners.times', { n: m.n })}</span></button>
                <span className="obsplit">{m.parts.slice(0, 3).map((x, i) => <i key={i} style={{ flex: x.n }} />)}</span>
                <span className="rk">{m.parts.map((x) => `${x.n}× ${x.account}${x.vat ? ` ${x.vat}` : ''}`).join(' · ')}</span>
              </Fragment>
            ))}
          </div>
        </div>
      ) : null}
      {card.rare.length ? (
        <div className="obbin">
          <div className="obbinh"><b>{t('onboarding.partners.rare')}</b><span className="count">{card.rare.length + card.rareMore}</span><span className="rk">{t('onboarding.partners.rareWhy')}</span></div>
          <div className="obrare">{card.rare.map((r) => <span key={r.name}>{r.name} {r.n}×</span>)}{card.rareMore ? <span>{t('onboarding.partners.more', { n: card.rareMore })}</span> : null}</div>
        </div>
      ) : null}
      <div className="actions"><button type="button" className="aiact" onClick={() => onGo({ area: 'partners' })}>{t('onboarding.partners.all')}</button></div>
    </div>
  );
}

const ORIGIN_CLASS: Record<Origin, string> = { form: '', answer: '', app: 'pos' };

/**
 * The first step first (#364): one sentence and its button, the rest behind «Mehr dazu»; then what the
 * app knows and what is open. The conversation scrolls to it when it appears (useNewestStep).
 */
function SummaryCard({ card, onGo }: { card: Extract<SetupCard, { kind: 'summary' }>; onGo: Go }) {
  const end = () => { void setupReady(); closeAssistant(); };
  return (
    <div className="obcard" data-testid="setup-summary">
      <h4>{t('onboarding.summary.first')}</h4>
      <span className="lead" data-first>{say(card.first)}</span>
      <div className="actions">
        <button type="button" className="aiact primary" data-testid="setup-statement" onClick={() => { end(); onGo({ area: 'bank' }); }}>{t('onboarding.summary.statement')}</button>
        <button type="button" className="aiact" data-testid="setup-go" onClick={end}>{t('onboarding.summary.go')}</button>
      </div>
      <details className="obmore">
        <summary>{t('onboarding.summary.more')}</summary>
        <p>{t('onboarding.sum.firstMore')} {t('onboarding.summary.lead')}</p>
      </details>
      <h4>{t('onboarding.summary.title')}</h4>
      <ul className="obsum">{card.items.map((it, i) => <li key={i}><span>{say(it.what)}</span><span><span className={`obbadge ${ORIGIN_CLASS[it.origin]}`}>{t(`onboarding.origin.${it.origin}`)}</span></span></li>)}</ul>
      {card.open.length ? (
        <>
          <h4>{t('onboarding.summary.open')}</h4>
          <ul className="obsum">
            {card.open.map((o) => (
              <li key={o.topic} data-open={o.topic}>
                <span>{t(`onboarding.topic.${o.topic}`)} <span className="rk">{t(`onboarding.state.${o.state}`)}</span></span>
                <span>{o.go ? <ByHand go={o.go} onGo={onGo} /> : null}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}
