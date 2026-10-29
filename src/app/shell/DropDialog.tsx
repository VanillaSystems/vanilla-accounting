/**
 * Dateien hinzufügen (docs/0.4.0/intake.md, screen 8): every file dropped while it is open joins
 * the list and is taken at once when nothing is unclear about it (a receipt into the inbox, a
 * statement into the books), handed to the inbox's run; a row with an open question (a password, a
 * duplicate, unknown content) waits for its answer. Each row says where its file is and has its own
 * small action, «Rückgängig» for a taken one. Further drops, onto the window or the dialog, add
 * rows until it closes; the work goes on when it does.
 */
import { useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { api, errorText } from '../lib/api.js';
import { language, t, tWith } from '../i18n/index.js';
import { addEach, dropStart, failedLine } from './drop-upload.js';
import { needsYou, tabOf, type DropTab } from './drop-tabs.js';
import { fmt, formatDate } from '../lib/utils.js';
import { monthName } from '../lib/period-label.js';
import { useAutomation } from '../automation/store.js';
import { textIn } from '../../workflows/model.js';
import type { Index } from '../../types/index.js';
import type { DropRow, DropSession } from '../../types/drop.js';
import { FileDetails } from './FileDetails.js';
import { CsvColumnsForm, StatementRead } from './StatementRead.js';
import { Menu } from './Menu.js';
import type { Location, Route } from './route.js';
import { at } from '../areas/receipts/view.js';
import { setBankDraft } from '../areas/company/bank-draft.js';
import { chfOf, suggestion } from '../areas/receipts/model.js';
import { ledgerFor } from '../areas/receipts/view.js';
import { useFx } from '../hooks/use-fx.js';
import { ReportCorrections } from '../areas/receipts/ReportCorrections.js';
import { processingText } from '../automation/processing.js';
import { inProcess, processingOf, runProcessing } from '../../workflows/processing.js';

/** `note`: what a drop left out, a limit it hit named (a limit is never hit silently). */
interface State { open: boolean; session?: DropSession; adding: number; note?: string; error?: string }
let state: State = { open: false, adding: 0 };
const listeners = new Set<() => void>();
const set = (patch: Partial<State>) => { state = { ...state, ...patch }; for (const l of listeners) l(); };
const useDrop = () => useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l); }; }, () => state);

export const dropOpen = (): boolean => state.open;

/** Opens the dialog (or uses the open one) and adds the files to its list; `note` says what the drop left out. */
export async function dropFiles(files: File[], note?: string): Promise<void> {
  set(dropStart(note));
  let session: DropSession;
  try {
    session = state.session ?? await api.dropOpen();
  } catch (e) {
    set({ error: errorText(e) });
    return;
  }
  set({ session, adding: state.adding + files.length });
  const add = async (f: File) => {
    try {
      return await api.dropAdd(session.id, f);
    } finally {
      set({ adding: Math.max(0, state.adding - 1) });
    }
  };
  const failed = await addEach(files, add, (next) => set({ session: next }));
  const line = failedLine(failed, errorText);
  if (line) set({ error: tWith(line.key, line.vars) });
}

export function closeDrop(): void {
  const s = state.session;
  if (s) void api.dropClose(s.id).catch(() => undefined);
  set({ open: false, session: undefined, adding: 0, note: undefined, error: undefined });
}

const act = (session: DropSession, r: DropRow, action: Parameters<typeof api.dropRow>[2]) =>
  api.dropRow(session.id, r.key, action).then((next) => set({ session: next }), (e) => set({ error: errorText(e) }));

const groupIban = (iban: string) => iban.replace(/(.{4})/g, '$1 ').trim();

/** What a waiting row says about its file, the parts apart: its kind (when known), how it was recognized, the ZIP it came out of, the statement's account and period. */
function metaOf(r: DropRow): string {
  return [
    r.provider ? t(`drop.report.${r.provider.kind}`, { provider: r.provider.name }) : r.kind && t(`drop.kind.${r.kind}` as 'drop.kind.receipt'),
    r.how && t(`drop.how.${r.how}` as 'drop.how.structure'),
    r.from && t('drop.from', { name: r.from }),
    r.facts?.iban,
    r.facts?.from && `${formatDate(r.facts.from)} – ${formatDate(r.facts.to!)}`,
    r.facts?.entries !== undefined && t('drop.entries', { n: r.facts.entries }),
    r.document && t(`drop.doc.${r.document}` as 'drop.doc.newsletter'),
    r.twin && t(r.twin.relation === 'companion' ? 'drop.twin.companion' : 'drop.twin.duplicate', { name: r.twin.name }),
    r.twin?.relation === 'duplicate' && t(`drop.twin.why.${r.twin.why}` as 'drop.twin.why.same-text'),
  ].filter(Boolean).join(' · ');
}

/**
 * A statement several accounts of its currency could take, none naming an IBAN (#25): one button
 * per account reads it into that one; the IBAN can be kept on it, so the next statement lands by
 * itself. An account the books lack and a private one stay possible.
 */
function ChooseAccount({ r, session, go }: { r: DropRow; session: DropSession; go(route: Route): void }) {
  const choice = r.chooseAccount!;
  const proposed = choice.accounts.find((a) => a.account === choice.proposed);
  // The proposal (the account whose bank the file names, #208) comes first; the person still clicks it.
  const accounts = proposed ? [proposed, ...choice.accounts.filter((a) => a !== proposed)] : choice.accounts;
  const [keep, setKeep] = useState(true);
  const [busy, setBusy] = useState(false);
  const pick = async (a: (typeof choice.accounts)[number]) => {
    setBusy(true);
    try {
      const next = await api.dropRow(session.id, r.key, { kind: 'account', account: a.account });
      set({ session: next });
      // Only once the statement is read in: a refused one leaves the account as it was.
      if (keep && choice.iban && next.rows.find((x) => x.key === r.key)?.state === 'taken') await api.patchWorkspace({ banks: [{ bank: a.bank, currency: choice.currency, iban: choice.iban }] });
    } catch (e) {
      set({ error: errorText(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <small>{choice.iban ? t('drop.whichAccountIban', { currency: choice.currency, iban: groupIban(choice.iban) }) : t('drop.whichAccount', { currency: choice.currency })}</small>
      <span className="dacts dchoose">
        {accounts.map((a) => (
          <button key={a.account} type="button" className={a === proposed ? 'btn primary' : 'btn'} data-testid={a === proposed ? 'drop-proposed' : undefined} disabled={busy} onClick={() => void pick(a)}>
            {a === proposed ? <span className="dprop">{t('drop.proposal')}</span> : null}{a.label} <span className="mono">{a.account}</span>
          </button>
        ))}
      </span>
      {proposed ? <small>{t('drop.proposalWhy', { label: proposed.label })}</small> : null}
      {choice.iban ? <label className="dkeep"><input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} /> {t('drop.keepIban')}</label> : null}
      {r.unknownAccount ? (
        <span className="dacts">
          <button type="button" className="linkbtn" onClick={() => { setBankDraft(r.unknownAccount!); go({ area: 'company', section: 'banks' }); }}>{t('drop.otherAccount')}</button>
          <button type="button" className="linkbtn" onClick={() => void act(session, r, { kind: 'private' })}>{t('drop.privateAccount')}</button>
        </span>
      ) : null}
    </>
  );
}

/**
 * A provider's report whose company file lacks an account (#203): the row asks for it once, with the
 * fee code where the fees are missing and the cut-over day with the clearing account (the first day
 * of the open period proposed); the answer is kept in that file and the report is taken.
 */
function ProviderAccount({ r, session }: { r: DropRow; session: DropSession }) {
  const ask = r.askProvider!;
  const [account, setAccount] = useState('');
  const [vat, setVat] = useState('');
  const [since, setSince] = useState(ask.since ?? '');
  const needsAccount = ask.missing !== 'since';
  const ready = (!needsAccount || !!account.trim()) && (ask.missing !== 'fees' || !!vat.trim()) && (ask.since === undefined || !!since);
  return (
    <>
      <small>{t(`drop.provider.${ask.missing}`, { provider: ask.name, file: ask.file })}{ask.missing === 'clearing' && ask.since !== undefined ? ` ${t('drop.provider.since', { provider: ask.name, file: ask.file })}` : ''}</small>
      <form className="dpw" data-testid="drop-provider" onSubmit={(e) => { e.preventDefault(); if (ready) void act(session, r, { kind: 'provider', ...(needsAccount ? { account: account.trim() } : {}), ...(ask.missing === 'fees' ? { vat: vat.trim() } : {}), ...(ask.since !== undefined ? { since } : {}) }); }}>
        {needsAccount ? <input value={account} onChange={(e) => setAccount(e.target.value)} placeholder={t('drop.provider.account')} aria-label={t('drop.provider.account')} inputMode="numeric" /> : null}
        {ask.missing === 'fees' ? <input value={vat} onChange={(e) => setVat(e.target.value)} placeholder={t('drop.provider.vat')} aria-label={t('drop.provider.vat')} /> : null}
        {ask.since !== undefined ? <input type="date" value={since} onChange={(e) => setSince(e.target.value)} aria-label={t('drop.provider.sinceLabel')} data-tip={t('drop.provider.sinceLabel')} /> : null}
        <button type="submit" className="btn" disabled={!ready}>{t('drop.provider.keep')}</button>
      </form>
    </>
  );
}

/**
 * A provider's report held because no payout of the provider is recognised among the bank's payments
 * of its days (src/types/drop.ts PayoutUnseen): why, and what was looked at; «Trotzdem übernehmen»
 * books it (the clearing check is the safety net); the payout's name belongs into the provider's file
 * under match.tx, which the partner's page opens.
 */
function PayoutUnseenRow({ r, session, go }: { r: DropRow; session: DropSession; go(route: Route): void }) {
  const u = r.payoutUnseen!;
  return (
    <>
      <small>{t('drop.unseen.why', { provider: u.name, through: formatDate(u.through), since: formatDate(u.since), banks: u.banks.join(', ') || '–' })}</small>
      <small>{t('drop.unseen.hint', { provider: u.name, file: u.file })}</small>
      <span className="dacts">
        <button type="button" className="linkbtn" data-testid="drop-anyway" onClick={() => void act(session, r, { kind: 'anyway' })}>{t('drop.unseen.anyway')}</button>
        <button type="button" className="linkbtn" onClick={() => go({ area: 'partners', id: u.provider })}>{t('drop.unseen.open', { provider: u.name })}</button>
      </span>
    </>
  );
}

/** What a taken report booked and left, in one line (src/types/drop.ts ReportSummary). */
function reportLine(s: NonNullable<DropRow['report']>): string {
  const held = s.held.map((h) => t(`drop.held.${h.why}`, { order: h.order })).join(', ');
  return [
    s.from && s.to && `${formatDate(s.from)} – ${formatDate(s.to)}`,
    s.kind === 'sales' ? t('drop.booked.sales', { orders: s.orders, refunds: s.refunds }) : t('drop.booked.fees', { n: s.fees }),
    s.kind === 'fees' && (s.orders || s.refunds) ? t('drop.booked.completed', { orders: s.orders, refunds: s.refunds }) : '',
    s.unpaid ? t('drop.booked.unpaid', { n: s.unpaid }) : '',
    s.known ? t('drop.booked.known', { n: s.known }) : '',
    s.filed ? t('drop.booked.filed', { n: s.filed }) : '',
    s.before ? t('drop.booked.before', { n: s.before }) : '',
    s.beforeSince ? t('drop.booked.beforeSince', {
      n: s.beforeSince, reach: formatDate(s.reach), since: formatDate(s.since), provider: s.name, days: s.payoutDays, file: s.home,
      orders: s.beforeSinceRows.map((o) => (s.kind === 'sales' ? `#${o}` : o)).join(', '), more: s.beforeSinceMore ? t('drop.booked.more', { n: s.beforeSinceMore }) : '',
    }) : '',
    s.other ? t('drop.booked.other', { n: s.other, ways: s.ways.join(', '), more: s.waysMore ? t('drop.booked.more', { n: s.waysMore }) : '' }) : '',
    s.test ? t('drop.booked.test', { n: s.test }) : '',
    s.unread ? t('drop.booked.unread', { n: s.unread }) : '',
    held ? t('drop.booked.held', { n: s.held.length + s.heldMore, orders: held, more: s.heldMore ? t('drop.booked.more', { n: s.heldMore }) : '' }) : '',
    s.proofs ? t('drop.booked.proofs', { n: s.proofs }) : '',
  ].filter(Boolean).join(' · ');
}

/** A row with an open question, or one not taken: what it is and its small action. */
function Waiting({ r, session, go }: { r: DropRow; session: DropSession; go(route: Route): void }) {
  const [password, setPassword] = useState('');
  const [open, setOpen] = useState(false);
  const asked = r.state === 'duplicate' && r.reason === 'possible-duplicate';
  const chip = r.state === 'take' ? t('drop.taking') : asked ? t('drop.state.possible') : r.readAs ? t('drop.state.read') : t(`drop.state.${r.state}` as 'drop.state.duplicate');
  const details = r.state === 'asks' ? r.details : undefined;
  // A statement read without a bank export (#217): its table, unless it asks for its account first; a bank CSV: its columns.
  const table = r.state === 'asks' && r.read && !r.chooseAccount && !r.unknownAccount;
  const columns = r.state === 'asks' && r.reason === 'csv-columns' && r.csv;
  return (
    <>
      <div className={`droprow s-${r.state}${details && open ? ' open' : ''}`} data-testid="drop-row" data-file={r.name} data-state={r.state}>
        <div className="dn">
          <b className="mono">{r.name}</b>
          <small>{metaOf(r)}</small>
          {details ? (
            <button type="button" className="linkbtn dfold" aria-expanded={open} aria-label={t('drop.c.toggleOf', { name: r.name })} data-testid="drop-details" onClick={() => setOpen(!open)}>
              {t('drop.c.toggle')}
              <svg className="i" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
            </button>
          ) : null}
        </div>
        <div className="dgo">
          <span className={`dchip c-${r.state}`}>{chip}</span>
          {r.askProvider ? <ProviderAccount key={r.askProvider.missing} r={r} session={session} /> : r.payoutUnseen ? <PayoutUnseenRow r={r} session={session} go={go} /> : r.chooseAccount ? <ChooseAccount r={r} session={session} go={go} /> : r.unknownAccount ? (
            <>
              <small>{t(r.unknownAccount.owner ? 'drop.unknownAccountOf' : r.unknownAccount.bankName ? 'drop.unknownAccountAt' : 'drop.unknownAccount', { iban: groupIban(r.unknownAccount.iban), currency: r.unknownAccount.currency, bank: r.unknownAccount.bankName ?? '', owner: r.unknownAccount.owner ?? '' })}</small>
              <button type="button" className="linkbtn" onClick={() => { setBankDraft(r.unknownAccount!); go({ area: 'company', section: 'banks' }); }}>{t('drop.firmAccount')}</button>
              <button type="button" className="linkbtn" onClick={() => void act(session, r, { kind: 'private' })}>{t('drop.privateAccount')}</button>
            </>
          ) : r.readAs ? (
            <>
              <small>{t('drop.readAs', { file: r.readAs.file })}</small>
              {r.readAs.ref ? <button type="button" className="linkbtn" data-testid="drop-open-statement" onClick={() => go({ area: 'bank', payment: r.readAs!.ref })}>{t('drop.openStatement')}</button> : null}
            </>
          ) : r.asked ? <small data-testid="drop-asked">{t('drop.read.asked', { month: monthName(`${r.asked.month}-01`) })}</small>
          : r.message ? <small>{r.message}</small> : r.reason ? <small>{t(`drop.reason.${r.reason}` as 'drop.reason.duplicate')}</small> : null}
          {asked ? (
            <span className="dacts">
              <button type="button" className="linkbtn" data-testid="drop-twin-same" onClick={() => void act(session, r, { kind: 'twin', answer: 'same' })}>{t('drop.twin.same')}</button>
              <button type="button" className="linkbtn" data-testid="drop-twin-distinct" onClick={() => void act(session, r, { kind: 'twin', answer: 'distinct' })}>{t('drop.twin.distinct')}</button>
            </span>
          ) : r.kind === 'statement-pdf' && r.reason === 'not-imported' && !r.chooseAccount && !r.unknownAccount && !r.read
            ? <button type="button" className="linkbtn" onClick={() => void act(session, r, { kind: 'as', as: 'receipt' })}>{t('drop.isReceipt')}</button>
          : (r.state === 'duplicate' || r.state === 'quarantine') && r.kind !== 'camt' && r.kind !== 'statement-pdf' && r.kind !== 'statement-csv' && r.reason !== 'unreadable'
            ? <button type="button" className="linkbtn" onClick={() => void act(session, r, { kind: 'take' })}>{r.state === 'quarantine' && r.reason === 'not-receipt' ? t('drop.isReceipt') : t('drop.takeAnyway')}</button> : null}
          {r.state === 'locked' ? (
            <form className="dpw" onSubmit={(e) => { e.preventDefault(); if (password) void act(session, r, { kind: 'unlock', password }).then(() => setPassword('')); }}>
              <input type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={t('drop.password')} aria-label={t('drop.password')} />
              <button type="submit" className="btn" disabled={!password}>{t('drop.unlock')}</button>
            </form>
          ) : null}
        </div>
        {r.state === 'take' || r.state === 'undone' ? <span /> : <button type="button" className="dx" aria-label={t('drop.remove', { name: r.name })} onClick={() => void act(session, r, { kind: 'remove' })}>×</button>}
      </div>
      {details && open ? <FileDetails d={details} name={r.from ? `${r.from} › ${r.name}` : r.name} /> : null}
      {table ? <StatementRead key={`${r.read!.by}-${r.read!.statement.movements.length}-${r.read!.statement.closing.amount}`} read={r.read!} pdf={r.kind === 'statement-pdf'} act={(a) => act(session, r, a)} go={go}
        asReceipt={r.kind === 'statement-pdf' ? () => void act(session, r, { kind: 'as', as: 'receipt' }) : undefined} /> : null}
      {columns ? <CsvColumnsForm r={r} act={(a) => act(session, r, a)} /> : null}
    </>
  );
}

/**
 * Where one taken file is, read from the books and its run: still in its step (said as Belege says
 * it, #218: «Sucht die Zahlung …», «Wartet (3 vor diesem)»), read, matched, waiting for a person,
 * its run stopped, or set aside by the run with the reason.
 */
type FileState = { kind: 'working'; step?: string } | { kind: 'read' } | { kind: 'matched' } | { kind: 'waits' } | { kind: 'orderPage'; provider: string } | { kind: 'stuck'; run: string } | { kind: 'statement' } | { kind: 'report' } | { kind: 'refused'; reason: string };

const isWorking = (run?: { status: string }) => !!run && (run.status === 'queued' || run.status === 'running');

type View = ReturnType<typeof useAutomation>['view'];

/** The id a taken receipt has in the books: the run's arrival names the PDF a photo became (r8k-9), else the dropped bytes'. */
function receiptIdOf(r: DropRow, view: View): string {
  const a = view?.runs.find((x) => x.id === r.run)?.arrived?.find((x) => x.file === r.name);
  return a?.kind === 'receipt' ? a.id : r.id;
}

function fileState(r: DropRow, books: Index, view: View): FileState {
  const run = r.run ? view?.runs.find((x) => x.id === r.run) : undefined;
  const steps = view?.workflows.find((w) => w.id === run?.workflow)?.steps ?? [];
  const step = run?.at ? steps.find((x) => x.id === run.at) : undefined;
  const working: FileState = { kind: 'working', ...(step ? { step: textIn(step.label, language()) } : {}) };
  // Its run is not in the last poll yet: it has only just started.
  if (r.run && !run) return working;
  if (r.statement) {
    const p = run && runProcessing(run, view?.runs ?? []);
    return inProcess(p) ? { kind: 'working', step: processingText(p, view) } : isWorking(run) ? working : { kind: 'statement' };
  }
  if (r.report) return { kind: 'report' };
  const arrival = run?.arrived?.find((x) => x.file === r.name);
  if (arrival?.kind === 'refused') return { kind: 'refused', reason: arrival.reason };
  const id = receiptIdOf(r, view);
  const proc = processingOf(view?.runs ?? [], books.receipts).get(id);
  if (inProcess(proc)) return { kind: 'working', step: processingText(proc, view) };
  if (books.mappings.some((m) => m.receiptId === id)) return { kind: 'matched' };
  if (isWorking(run)) return working;
  if (proc?.kind === 'stuck') return { kind: 'stuck', run: proc.run };
  const receipt = books.receipts.find((x) => x.id === id);
  // At rest but not in the books the page holds: they are being loaded again, unless the run stopped.
  if (!receipt) return run?.status === 'stuck' ? { kind: 'stuck', run: run.id } : working;
  if (receipt.location !== 'archived') return { kind: 'waits' };
  // An order page of the provider way (#253): the provider's order export brings its order, no payment comes for it.
  const page = ledgerFor(books).byId.get(id)?.orderPage;
  return page ? { kind: 'orderPage', provider: page.name } : { kind: 'read' };
}

/** A reason the run gives as a code has words of its own; any other is shown as the run said it. */
const reasonText = (reason: string) => (reason === 'unreadable' ? t('drop.reason.unreadable') : reason);

/** A taken receipt's quick details: what was read off it, the payment it was linked to and the entries booked on that payment, each a link. */
function ReceiptDetails({ id, books, go }: { id: string; books: Index; go(route: Route): void }) {
  const receipt = books.receipts.find((x) => x.id === id);
  if (!receipt) return null;
  const refs = new Set(books.mappings.filter((m) => m.receiptId === id).map((m) => m.transactionRef));
  const payments = books.transactions.filter((x) => refs.has(x.ref));
  const entries = (books.journalEntries ?? []).filter((e) => refs.has(e.transactionRef));
  const read = [receipt.description, receipt.date && formatDate(receipt.date), receipt.amount !== undefined && `${receipt.currency ?? ''} ${fmt(receipt.amount)}`.trim()].filter(Boolean).join(' · ');
  const vat = receipt.vatSummary?.length ? receipt.vatSummary.map((g) => `${g.ratePercent} % ${fmt(g.vat)}`).join(' · ')
    : receipt.hasSwissVat === false ? t('drop.d.noSwissVat') : '–';
  return (
    <dl className="ddet">
      <dt>{t('drop.d.read')}</dt><dd>{read || '–'}</dd>
      <dt>{t('drop.d.vat')}</dt><dd>{vat}{receipt.vatId ? ` · ${receipt.vatId}` : ''}</dd>
      <dt>{t('drop.d.payment')}</dt>
      <dd>{payments.length ? payments.map((x) => (
        <button key={x.ref} type="button" className="linkbtn" onClick={() => go({ area: 'bank', payment: x.ref })}>
          {formatDate(x.date)} · {x.bank} · {x.currency} {fmt(x.direction === 'DBIT' ? -x.amount : x.amount)}
        </button>
      )) : t('drop.d.none')}</dd>
      <dt>{t('drop.d.entry')}</dt>
      <dd>{entries.length ? entries.map((e) => (
        <button key={e.id} type="button" className="linkbtn" onClick={() => go({ area: 'journal', id: e.id })}>
          {e.accountDebit} / {e.accountCredit}{e.vatCode ? ` · ${e.vatCode}` : ''} · {fmt(e.amount)}
        </button>
      )) : t('drop.d.none')}</dd>
      <dt>{t('drop.d.file')}</dt><dd className="mono">{receipt.filename}</dd>
    </dl>
  );
}

/** A taken file: where it is, its quick details, the way to its page, and «Rückgängig». */
function Taken({ r, session, books, go, refresh }: { r: DropRow; session: DropSession; books: Index; go(route: Route, date?: string): void; refresh(): void }) {
  const { view } = useAutomation();
  const { rates } = useFx();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const x = fileState(r, books, view);
  const receipt = books.receipts.find((y) => y.id === receiptIdOf(r, view));
  const facts = !r.report && receipt && (receipt.date || receipt.amount !== undefined)
    ? [receipt.date && formatDate(receipt.date), receipt.amount !== undefined && `${receipt.currency ?? ''} ${fmt(receipt.amount)}`.trim()].filter(Boolean).join(' · ') : '';
  const running = view?.runs.find((y) => y.id === r.run)?.status === 'running';
  const lacks = (x.kind === 'waits' || x.kind === 'stuck') && receipt ? [!receipt.date && t('drop.p.date'), receipt.amount === undefined && t('drop.p.amount')].filter(Boolean).join(', ') : '';
  // «Zahlung bestätigen» only when Belege has a payment to propose for it (r8k-5).
  const ledger = ledgerFor(books);
  const proposed = x.kind === 'waits' && receipt && ledger.byId.has(receipt.id) ? !!suggestion(ledger.byId.get(receipt.id)!, ledger, chfOf(rates)) : false;
  const missing = x.kind !== 'waits' && x.kind !== 'stuck' ? '' : lacks ? t('drop.p.missing', { what: lacks }) : proposed ? t('drop.p.payment') : t('drop.p.noPayment');
  const shown = !!receipt && open;
  // The books changed under the page: Belege must not show the receipt any more.
  const undo = () => { setBusy(true); void act(session, r, { kind: 'undo' }).then(refresh).finally(() => setBusy(false)); };
  // A statement PDF kept as the statement, its movements not read in (#254): «Aktionen» reads them.
  const keptPdf = r.kind === 'statement-pdf' && !!r.statement?.file.toLowerCase().endsWith('.pdf');
  const [menu, setMenu] = useState<DOMRect | null>(null);
  const readPdf = () => { setBusy(true); void act(session, r, { kind: 'readPdf' }).then(refresh).finally(() => setBusy(false)); };
  return (
    <>
      <div className={`droprow s-taken${shown ? ' open' : ''}`} data-testid="drop-row" data-file={r.name} data-state={x.kind}>
        <div className="dn"><b className="mono">{r.name}</b><small>{r.report ? `${t(`drop.report.${r.report.kind}`, { provider: r.report.name })} · ${reportLine(r.report)}` : r.statement ? [r.read && t(`drop.read.by.${r.read.by}`), r.facts?.from && r.facts.to && `${formatDate(r.facts.from)} – ${formatDate(r.facts.to)}`, keptPdf ? t('drop.kept') : t('drop.entries', { n: r.statement.refs.length })].filter(Boolean).join(' · ') : receipt && receipt.filename !== r.name ? receipt.filename : t(`drop.kind.${r.kind ?? 'receipt'}` as 'drop.kind.receipt')}{facts ? ` · ${facts}` : ''}{r.twin?.relation === 'companion' ? ` · ${t('drop.twin.companion', { name: r.twin.name })}` : r.document ? ` · ${t(`drop.doc.${r.document}` as 'drop.doc.newsletter')}` : ''}</small></div>
        <div className="dgo">
          <span className={`dchip p-${x.kind}`}>{x.kind === 'working' ? (x.step ?? t('drop.p.working')) : t(`drop.p.${x.kind}` as 'drop.p.read')}</span>
          {missing ? <small className="dwhy">{missing}</small> : x.kind === 'orderPage' ? <small className="dwhy" data-testid="drop-order-page">{t('drop.p.orderPageWhy', { provider: x.provider })}</small> : x.kind === 'refused' ? <small className="dwhy">{reasonText(x.reason)}</small> : null}
          <span className="dacts">
            {x.kind === 'stuck' ? <button type="button" className="linkbtn" data-testid="drop-stuck-run" onClick={() => go({ area: 'automation', view: 'run', run: x.run })}>{t('processing.toRun')}</button> : null}
            {receipt ? <button type="button" className="linkbtn" onClick={() => go({ area: 'receipts', id: receipt.id }, receipt.date)}>{t('drop.openReceipt')}</button> : null}
            {(r.kind === 'receipt' || r.kind === 'photo') && !r.report && x.kind !== 'matched' && x.kind !== 'working' ? <button type="button" className="linkbtn" data-testid="drop-as-statement" disabled={busy} onClick={() => { setBusy(true); void act(session, r, { kind: 'statement' }).then(refresh).finally(() => setBusy(false)); }}>{t('drop.asStatement')}</button> : null}
            {keptPdf ? <button type="button" className="linkbtn" data-act="actions" data-testid="drop-actions" aria-haspopup="menu" aria-expanded={!!menu} disabled={busy} onClick={(e) => setMenu(e.currentTarget.getBoundingClientRect())}>{t('actions.label')}</button> : null}
            <button type="button" className="linkbtn" disabled={running || busy} data-tip={running ? t('drop.undoBusy') : undefined} onClick={undo}>{t('drop.undo')}</button>
          </span>
          {/* The dialog is moved and blurred, which would shift a fixed menu inside it: the menu goes to the page. */}
          {menu ? createPortal(<Menu anchor={menu} items={[{ label: <span data-action="readPdf">{t('statementActions.readPdf')}</span>, run: readPdf }]} onClose={() => setMenu(null)} />, document.body) : null}
        </div>
        {receipt ? (
          <button type="button" className="dtog" aria-expanded={shown} aria-label={t('drop.d.toggle', { name: r.name })} onClick={() => setOpen(!open)}>
            <svg className="i" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
          </button>
        ) : <span />}
      </div>
      {(r.report?.corrections ?? []).map((id) => <ReportCorrections key={id} receipt={id} books={books} canEdit said={(message, ok) => { set({ error: ok ? undefined : message }); refresh(); }} />)}
      {shown ? <ReceiptDetails id={receipt.id} books={books} go={go} /> : null}
    </>
  );
}

export function DropDialog({ onGo, books, refresh }: { onGo(loc: Location): void; books: Index; refresh(): void }) {
  const s = useDrop();
  const { view } = useAutomation();
  const [tab, setTab] = useState<DropTab>('all');
  if (!s.open) return null;
  const rows = s.session?.rows ?? [];
  const tabs: DropTab[] = ['all', 'statements', 'receipts', ...(rows.some((r) => tabOf(r) === 'unclear') ? ['unclear' as const] : []), 'out'];
  const shown = tab === 'all' ? rows : rows.filter((r) => tabOf(r) === tab);
  const taken = rows.filter((r) => r.state === 'taken');
  const states = taken.map((r) => fileState(r, books, view));
  const working = s.adding > 0 || rows.some((r) => r.state === 'take') || states.some((x) => x.kind === 'working');
  const finished = states.filter((x) => x.kind !== 'working').length;
  const pct = taken.length ? Math.round((finished / taken.length) * 100) : 0;
  const waits = !working && states.some((x) => x.kind === 'waits' || x.kind === 'stuck');
  // A receipt of a sealed quarter opens in that quarter, not in the open one (r9k-8).
  const go = (route: Route, date?: string) => { closeDrop(); onGo(date ? at(route, date) : { route, query: {} }); };
  return (
    <>
      <div className="scrim" style={{ background: 'color-mix(in srgb, var(--bg) 45%, transparent)' }} onClick={closeDrop} />
      <div className="palette dropdlg" role="dialog" aria-label={t('drop.dialog')} data-testid="drop-dialog" data-working={working}>
        <div className="dhd">
          <b>{!taken.length ? t('drop.dialog') : working ? t('drop.titleWorking') : t('drop.titleDone')}</b>
          {s.adding ? <span className="wfpill st-running">{t('drop.reading', { n: s.adding })}</span> : null}
          <button type="button" className="chip" aria-label={t('common.close')} onClick={closeDrop}>×</button>
        </div>
        {taken.length ? (
          <div className="dprog">
            <div className="dbar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}><i style={{ width: `${pct}%` }} /></div>
            <p className="m">{t('drop.overall', { pct, done: finished, n: taken.length })}</p>
          </div>
        ) : null}
        <div className="wftabs" role="tablist">
          {tabs.map((x) => {
            const of = x === 'all' ? rows : rows.filter((r) => tabOf(r) === x);
            return (
              <button key={x} type="button" role="tab" aria-selected={tab === x} className={tab === x ? 'on' : ''} onClick={() => setTab(x)}>
                {t(`drop.tab.${x}` as 'drop.tab.all')} <span className="mono">{of.length}</span>{of.some(needsYou) ? <i className="ddot" aria-hidden="true" /> : null}
              </button>
            );
          })}
        </div>
        <div className="drows">
          {shown.length ? shown.map((r) => (r.state === 'taken'
            ? <Taken key={r.key} r={r} session={s.session!} books={books} go={go} refresh={refresh} />
            : <Waiting key={r.key} r={r} session={s.session!} go={go} />)) : <p className="m">{rows.length ? t('drop.emptyTab') : t('drop.empty')}</p>}
        </div>
        {s.note ? <p className="warnline" data-testid="drop-note">{s.note}</p> : null}
        {s.error ? <p className="warnline">{s.error}</p> : null}
        {waits ? <p className="m">{t('drop.waitsHint')}</p> : null}
        {rows.some((r) => (r.state === 'duplicate' && r.reason === 'possible-duplicate') || r.state === 'locked' || r.state === 'unclear') ? <p className="m" data-testid="close-hint">{t('drop.closeHint')}</p> : null}
        {rows.some((r) => r.state === 'asks' && !r.asked) ? <p className="m" data-testid="read-hint">{t('drop.read.closeHint')}</p> : null}
        {rows.some((r) => r.state === 'asks' && r.asked) ? <p className="m" data-testid="asked-hint">{t('drop.read.askedHint')}</p> : null}
        <div className="dfoot">
          <span className="m">{taken.length ? <button type="button" className="linkbtn" onClick={() => go({ area: 'automation', view: 'runs' })}>{t('drop.toRuns')}</button> : t('drop.moreHint')}</span>
          <button type="button" className="btn primary" data-testid="drop-close" onClick={closeDrop}>{working ? t('drop.background') : t('common.close')}</button>
        </div>
      </div>
    </>
  );
}
