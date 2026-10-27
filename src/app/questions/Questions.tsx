/**
 * Questions in the UI (src/questions/model.ts): the block on a payment, a receipt or a booking
 * (its questions, «Frage stellen»), one question as a card (answer with one click or a few words,
 * «beantwortet» for the asker, «Zurücknehmen», «Erledigt»), and Aufgaben's two lists, «Fragen an
 * dich» and «Deine offenen Fragen». The app's own question about a sale without an invoice shows
 * its proposal first and why; its answer books that payment only, and «Immer so?» under it offers
 * the payer's rule on its card, or says the payer is mixed (#38).
 */
import { useState } from 'react';
import './questions.css';
import { t } from '../i18n/index.js';
import { api, errorText } from '../lib/api.js';
import { fmt, formatDate } from '../lib/utils.js';
import { at } from '../areas/receipts/view.js';
import type { Nav } from '../areas/index.js';
import type { Location } from '../shell/route.js';
import type { Index } from '../../types/index.js';
import { askedByMe, PRIVATE_CHOICES, forMe, onTarget, undoable, type Choice, type Question, type QuestionTarget } from '../../questions/model.js';
import { domesticSale, normalRate, saleChoiceOf, saleProposal } from '../../accounting/sales-without-vat.js';
import { baseCurrency, chart, invoicing } from '../../engines/index.js';
import { answerQuestion, askQuestion, closeQuestion, setMe, undoAnswer, useQuestions } from './store.js';
import { RuleDraft } from '../areas/company/RulesSection.js';
import type { SaleRuleOffer } from '../../saving/sale-rule.js';

/** The domestic sale at the normal rate; on the net tax rate method the firm's code and approved rate, which the answer books. */
function saleDomesticText(): string {
  const d = domesticSale();
  return d?.net ? t('questions.choice.saleDomesticNet', { code: d.code, rate: String(d.rate) }) : t('questions.choice.saleDomestic', { rate: String(d?.rate ?? normalRate()) });
}
const choiceText = (c: Choice) => (c === 'saleDomestic' ? saleDomesticText() : t(`questions.choice.${c}` as 'questions.choice.private'));
const when = (iso: string) => formatDate(iso.slice(0, 10));
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const asker = (q: Question) => (q.origin === 'assistant' ? t('questions.ai') : q.origin === 'booking' ? t('questions.app') : q.by);

/** The question in the viewer's language: the app's own question is said from its payment, a person's as written. */
export function questionText(q: Pick<Question, 'topic' | 'on' | 'text'>, books: Index): string {
  const entry = q.topic === 'reportPayment' ? books.journalEntries?.find((e) => e.id === q.on.id) : undefined;
  if (entry) return t('questions.reportPayment.text', { entry: entry.description ?? entry.transactionRef });
  const tx = q.topic === 'saleVat' ? books.transactions.find((x) => x.ref === q.on.id) : undefined;
  return tx ? t('questions.sale.text', { who: tx.counterparty || tx.description, amount: `${tx.currency} ${fmt(tx.amount)}`, date: formatDate(tx.date) }) : q.text;
}

/** How the app's question's payment is booked while it waits: the code on its revenue, so the owner sees what her answer changes. */
function bookedNow(q: Question, books: Index): string {
  const codes = [...new Set((books.journalEntries ?? []).filter((e) => e.transactionRef === q.on.id && chart().typeOf(e.accountCredit) === 'revenue').map((e) => e.vatCode || t('journal.noVat')))];
  return codes.length ? t('questions.sale.bookedNow', { code: codes.join(', ') }) : '';
}

/**
 * A person's own export code on the payment of a payer at home, which the app asked back instead
 * of taking it as «Ausland» (r4c-35): the code, else undefined.
 */
function herZeroAtHome(q: Question, books: Index): string | undefined {
  const tx = q.topic === 'saleVat' ? books.transactions.find((x) => x.ref === q.on.id) : undefined;
  if (!tx || saleProposal(tx).choice !== 'saleDomestic') return undefined;
  const sales = (books.journalEntries ?? []).filter((e) => e.transactionRef === tx.ref && chart().typeOf(e.accountCredit) === 'revenue');
  const codes = [...new Set(sales.map((e) => e.vatCode ?? ''))];
  return sales.length && sales.every((e) => e.origin === 'manual') && codes.length === 1 && saleChoiceOf(codes[0]) === 'saleAbroad' ? codes[0] : undefined;
}

/** What the app said instead of acting on an answer, in the viewer's words. */
const notActedText = (a: { refused: string; detail?: string }) => t(`questions.notActed.${a.refused}` as 'questions.notActed.refused', { detail: a.detail ?? '' });

/** Runs a command; a refusal is said in the toast. */
async function run(nav: Nav, p: Promise<unknown>, done?: string): Promise<boolean> {
  try { await p; } catch (e) { nav.toast(errorText(e)); return false; }
  nav.refresh();
  if (done) nav.toast(done);
  return true;
}

/** «Ich bin …»: the viewer's name, from the people of the books or typed. */
export function IAm() {
  const { me, people } = useQuestions();
  return (
    <label className="qme" data-tip={t('questions.iAmTip')}>
      <span>{t('questions.iAm')}</span>
      <input list="q-people" defaultValue={me} key={me} aria-label={t('questions.iAm')} onBlur={(e) => { if (e.currentTarget.value.trim() && e.currentTarget.value !== me) setMe(e.currentTarget.value); }}
        onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
      <datalist id="q-people">{people.map((p) => <option key={p} value={p} />)}</datalist>
    </label>
  );
}

/**
 * «Immer so?» under an answer to the app's sale question (#38): the click lets code read the payer's
 * other payments and draft the rule for its card, or say why it drafts none (a mixed payer).
 */
function AlwaysSo({ q, nav }: { q: Question; nav: Nav }) {
  const [offer, setOffer] = useState<SaleRuleOffer>();
  const [busy, setBusy] = useState(false);
  if (offer?.kind === 'rule') return <RuleDraft path={offer.path} nav={nav} onRules={() => nav.go({ route: { area: 'company', section: 'rules' }, query: {} })} title={t('questions.sale.ruleTitle')} />;
  const ask = () => {
    setBusy(true);
    api.draftSaleRule(q.id).then(setOffer, (e) => nav.toast(errorText(e))).finally(() => setBusy(false));
  };
  return (
    <div className="ruledraft" data-sale-rule={q.id}>
      {offer?.kind === 'mixed' ? <span data-testid="sale-mixed">{t(`questions.sale.mixed.${offer.why}`, { who: offer.name, n: offer.other })}</span>
        : offer?.kind === 'none' ? <span className="m" data-testid="sale-no-rule">{t(`questions.sale.none.${offer.why}`)}</span>
        : (
          <>
            <span>{t('questions.sale.always')}</span>
            <span className="ruleacts"><button type="button" className="btn" disabled={busy} data-act="sale-always" onClick={ask}>{t('rules.share.draft')}</button></span>
          </>
        )}
    </div>
  );
}

/** What the app did with the answer, in one line. */
function Acted({ q, owner }: { q: Question; owner: string }) {
  const a = q.answer?.acted;
  if (!a) return null;
  if ('refused' in a) return <p className="qnote warn">{notActedText(a)}</p>;
  if ('vatCode' in a) {
    const sale = [
      a.marked ? (a.booked.length && a.account ? t('questions.sale.notSale', { n: a.booked.length, account: owner.startsWith(`${a.account} `) ? owner : a.account }) : t('questions.sale.marked')) : a.correction ? t('questions.sale.corrected', { code: a.vatCode || t('journal.noVat') }) : t('questions.sale.booked', { n: a.booked.length, code: a.vatCode || '–' }),
      ...(a.rule ? [t('questions.sale.rule')] : []),
      ...(a.also?.length ? [t('questions.sale.also', { n: a.also.length })] : []),
    ];
    return <p className="qnote" data-testid="sale-acted">{sale.join(' · ')}</p>;
  }
  const parts = [
    'booked' in a && a.booked.length ? t('questions.booked', { n: a.booked.length, account: owner }) : '',
    ('precedent' in a && a.precedent) || q.answer?.from ? t('questions.kept') : '',
  ].filter(Boolean);
  return parts.length ? <p className="qnote">{parts.join(' · ')}</p> : null;
}

export function QuestionCard({ q, nav, canEdit, books, showItem }: { q: Question; nav: Nav; canEdit: boolean; books: Index; showItem?: boolean }) {
  const { me, view } = useQuestions();
  const [text, setText] = useState('');
  const mine = same(q.by, me);
  const owner = view?.owner ?? '';
  const item = showItem ? itemOf(books, q.on) : undefined;
  // A refused answer is said in the toast: on Aufgaben the card leaves the open list with it.
  const answer = async (a: Parameters<typeof answerQuestion>[1]) => {
    try {
      const done = await answerQuestion(q.id, a);
      const acted = done.answer?.acted;
      nav.refresh();
      nav.toast(acted && 'refused' in acted ? notActedText(acted) : t('questions.answeredToast'));
      return true;
    } catch (e) { nav.toast(errorText(e)); nav.refresh(); return false; }
  };
  const zero = q.status === 'open' ? herZeroAtHome(q, books) : undefined;
  return (
    <div className={`qcard ${q.status}`} data-question={q.id}>
      <div className="qhead">
        <span className={`qpill ${q.status}`}>{t(`questions.status.${q.status}` as 'questions.status.open')}</span>
        <span className="m">{q.to ? t('questions.askedTo', { by: asker(q), to: q.to, date: when(q.askedAt) }) : t('questions.askedBy', { by: asker(q), date: when(q.askedAt) })}</span>
        {item ? <button type="button" className="linkbtn" onClick={() => nav.go(item.go)}>{item.label}</button> : null}
      </div>
      <p className="qtext">{questionText(q, books)}</p>
      {q.status === 'open' ? (
        <>
          {q.choices.includes('private') && !mine ? <p className="qnote">{t('questions.privateDoes', { account: owner })}</p> : null}
          {zero ? <p className="qnote warn" data-testid="sale-zero-home">{t('questions.sale.zeroAtHome', { code: zero })}</p> : null}
          {q.proposal && !zero ? <p className="qnote" data-testid="sale-proposal">{t(`questions.sale.why.${q.proposal.why}` as 'questions.sale.why.domesticIban', { choice: choiceText(q.proposal.choice), currency: baseCurrency(), countries: invoicing().territory.join(', ') })} {bookedNow(q, books)} {t('questions.sale.does')}</p> : null}
          {canEdit ? (
            <div className="qacts">
              {mine ? null : <>
                {q.choices.map((c) => { const proposed = !zero && c === q.proposal?.choice; return <button key={c} type="button" className={proposed ? 'btn primary' : 'btn'} data-choice={c} onClick={() => void answer({ choice: c })}>{choiceText(c)}{proposed ? ` · ${t('questions.proposed')}` : ''}</button>; })}
                <input className="qinput" value={text} placeholder={t('questions.answerPlaceholder')} aria-label={t('questions.answerPlaceholder')} onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && text.trim()) void answer({ text: text.trim() }).then((ok) => ok && setText('')); }} />
                <button type="button" className="btn ghost" disabled={!text.trim()} onClick={() => void answer({ text: text.trim() }).then((ok) => ok && setText(''))}>{t('questions.reply')}</button>
              </>}
              {mine ? <button type="button" className="linkbtn" onClick={() => void run(nav, closeQuestion(q.id, 'withdrawn'), t('questions.withdrawn'))}>{t('questions.withdraw')}</button> : null}
            </div>
          ) : null}
        </>
      ) : q.answer ? (
        <>
          <p className="qanswer">
            <b>{'choice' in q.answer.answer ? choiceText(q.answer.answer.choice) : q.answer.answer.text}</b>
            <span className="m">{' '}{q.answer.from ? t('questions.answeredFrom', { by: q.answer.by }) : t('questions.answeredBy', { by: q.answer.by, date: when(q.answer.at) })}</span>
          </p>
          <Acted q={q} owner={owner} />
          {canEdit && q.status === 'answered' && q.topic === 'saleVat' && q.answer.acted && 'vatCode' in q.answer.acted && !q.answer.acted.rule && !q.answer.from && undoable(q, books) ? <AlwaysSo q={q} nav={nav} /> : null}
          {canEdit && q.status === 'answered' ? (
            <div className="qacts">
              {mine || q.origin === 'assistant' ? <button type="button" className="btn" onClick={() => void run(nav, closeQuestion(q.id, 'done'))}>{t('questions.done')}</button> : null}
              {q.answer.acted && !('refused' in q.answer.acted) && undoable(q, books) ? <button type="button" className="btn ghost" data-tip={t('questions.undoTip')} onClick={() => void run(nav, undoAnswer(q.id), t('questions.undone'))}>{t('questions.undo')}</button> : null}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/** «Frage stellen»: the question, to whom, and whether the answer is «privat» or «geschäftlich». */
function AskForm({ on, nav, onDone }: { on: QuestionTarget; nav: Nav; onDone(): void }) {
  const { me, people } = useQuestions();
  const [text, setText] = useState('');
  const [to, setTo] = useState(() => people.find((p) => !same(p, me)) ?? '');
  const [choices, setChoices] = useState(on.kind !== 'receipt');
  const send = async () => {
    if (!text.trim()) return;
    if (!me) { nav.toast(t('questions.needName')); return; }
    try {
      const q = await askQuestion(on, text.trim(), choices ? [...PRIVATE_CHOICES] : [], to.trim() || undefined);
      nav.refresh();
      nav.toast(q.status === 'answered' && q.answer && 'choice' in q.answer.answer ? t('questions.answeredByPrecedent', { answer: choiceText(q.answer.answer.choice) }) : t('questions.asked'));
      onDone();
    } catch (e) { nav.toast(errorText(e)); }
  };
  return (
    <div className="qform">
      <IAm />
      <label className="qme"><span>{t('questions.to')}</span><input list="q-people" value={to} aria-label={t('questions.to')} onChange={(e) => setTo(e.target.value)} /></label>
      <textarea rows={2} autoFocus value={text} placeholder={t(`questions.placeholder.${on.kind}` as 'questions.placeholder.payment')} aria-label={t('questions.title')} onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send(); } if (e.key === 'Escape') onDone(); }} />
      <label className="qcheck"><input type="checkbox" checked={choices} onChange={(e) => setChoices(e.target.checked)} />{t('questions.withChoices')}</label>
      <div className="qacts">
        <button type="button" className="btn primary" disabled={!text.trim()} onClick={() => void send()}>{t('questions.send')} <span className="m">⌘↵</span></button>
        <button type="button" className="linkbtn" onClick={onDone}>{t('questions.cancel')}</button>
      </div>
    </div>
  );
}

/** The questions on one payment, receipt or booking, those on what belongs to it (`also`: its payment, receipts, bookings), and «Frage stellen». */
export function QuestionsOn({ on, also = [], nav, canEdit, books }: { on: QuestionTarget; also?: QuestionTarget[]; nav: Nav; canEdit: boolean; books: Index }) {
  const { questions } = useQuestions();
  const [asking, setAsking] = useState(false);
  const here = [on, ...also].flatMap((x) => onTarget(questions, x));
  const gone = [on, ...also].flatMap((x) => questions.filter((q) => q.status === 'closed' && q.closed?.why && q.on.kind === x.kind && q.on.id === x.id));
  if (!here.length && !gone.length && !canEdit) return null;
  return (
    <div className="qblock" data-testid="questions-on">
      {gone.map((q) => <p key={q.id} className="qnote" data-testid="question-gone">{t(`questions.gone.${q.closed!.why!}` as 'questions.gone.closed')}</p>)}
      {here.map((q) => <QuestionCard key={q.id} q={q} nav={nav} canEdit={canEdit} books={books} showItem={q.on.kind !== on.kind || q.on.id !== on.id} />)}
      {canEdit ? (asking ? <AskForm on={on} nav={nav} onDone={() => setAsking(false)} /> : (
        <button type="button" className="golink qaskbtn" data-tip={t('questions.askTip')} onClick={() => setAsking(true)}>{t('questions.ask')}</button>
      )) : null}
    </div>
  );
}

/** Aufgaben's questions: those waiting for the viewer, then the viewer's own until they mark them done. */
export function QuestionTasks({ nav, canEdit, books }: { nav: Nav; canEdit: boolean; books: Index }) {
  const { questions, me } = useQuestions();
  const toMe = forMe(questions, me);
  const mine = askedByMe(questions, me);
  return (
    <div className="qtasks">
      <div className="qtaskshead"><h3>{t('questions.forMe')}</h3><IAm /></div>
      {toMe.length ? toMe.map((q) => <QuestionCard key={q.id} q={q} nav={nav} canEdit={canEdit} books={books} showItem />) : <p className="m">{t('questions.noneForMe')}</p>}
      <h3>{t('questions.mine')}</h3>
      {mine.length ? mine.map((q) => <QuestionCard key={q.id} q={q} nav={nav} canEdit={canEdit} books={books} showItem />) : <p className="m">{t('questions.noneMine')}</p>}
    </div>
  );
}

/** What a question is about, as a link to it: its words and the place that shows it. */
function itemOf(books: Index, on: QuestionTarget): { label: string; go: Location } | undefined {
  switch (on.kind) {
    case 'payment': {
      const tx = books.transactions.find((x) => x.ref === on.id);
      return tx && { label: t('questions.on.payment', { what: `${formatDate(tx.date)} · ${tx.description} · ${tx.currency} ${fmt(tx.amount)}` }), go: at({ area: 'bank', payment: tx.ref }, tx.date) };
    }
    case 'receipt': {
      const r = books.receipts.find((x) => x.id === on.id);
      return r && { label: t('questions.on.receipt', { what: r.description || r.filename }), go: at({ area: 'receipts', id: r.id }, r.date) };
    }
    case 'entry': {
      const e = (books.journalEntries ?? []).find((x) => x.id === on.id);
      return e && { label: t('questions.on.entry', { what: `${formatDate(e.date)} · ${e.description ?? e.transactionRef}` }), go: at({ area: 'journal', id: e.id }, e.date) };
    }
  }
}
