/**
 * Dateien hinzufügen (docs/0.4.0/intake.md, screen 8): every file dropped while it is open joins
 * the list and is taken at once when nothing is unclear about it (a receipt into the inbox, a
 * statement into the books), handed to the inbox's run; a row with an open question (a password, a
 * duplicate, unknown content) waits for its answer. Each row says where its file is and has its own
 * small action, «Rückgängig» for a taken one. Further drops, onto the window or the dialog, add
 * rows until it closes; the work goes on when it does.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { api, errorText } from '../lib/api.js';
import { language, t, tWith } from '../i18n/index.js';
import { dropStore, failedLine } from './drop-upload.js';
import { CLOSING_SENTENCE, OTHER_SENTENCES, RECEIPT_SENTENCES, closingGroupOf, linkedAs, readOf, datesIn, dropProgress, dropSummary, landedPeriod, majorityPeriod, receiptStateOf, waitsAfterDrop, type ClosingCounts, type ClosingGroup, type DropSummary, type FileState } from './drop-summary.js';
import { isUnbooked } from '../areas/bank/model.js';
import { receiptWaits } from '../areas/automation/period-issues.js';
import { parsePeriod, filingKeyOf, parseSwissDate } from '../../accounting/periods.js';
import { useQuestions } from '../questions/store.js';
import { reloadWorkspace, useWorkspace } from '../hooks/use-workspace.js';
import { periodName } from '../lib/period-label.js';
import { OPEN_ITEMS } from '../areas/vat/model.js';
import { localToday, type Period } from '../../accounting/periods.js';
import { chargesVat, filing } from '../../engines/index.js';
import { needsYou, tabOf, type DropTab } from './drop-tabs.js';
import { fmt, formatDate } from '../lib/utils.js';
import { monthName } from '../lib/period-label.js';
import { useAutomation } from '../automation/store.js';
import { textIn } from '../../workflows/model.js';
import { tasksWaiting } from '../automation/widget.js';
import { forMe } from '../../questions/model.js';
import type { Index } from '../../types/index.js';
import type { DropRow, DropSession, OtherExportOf } from '../../types/drop.js';
import { FileDetails } from './FileDetails.js';
import { AccountField } from '../areas/journal/AccountField.js';
import { BOOKING_SWITCH_ON, payoutsBookedText } from '../lib/payouts.js';
import { CsvColumnsForm, StatementRead } from './StatementRead.js';
import { Menu } from './Menu.js';
import type { Location, Route } from './route.js';
import { at } from '../areas/receipts/view.js';
import { fileKeyOf } from '../areas/bank/model.js';
import { startIntake } from '../automation/intake.js';
import { emptyRefsLine } from '../areas/bank/actions.js';
import { draftForm } from '../areas/company/bank-draft.js';
import { getAccountMap } from '../lib/accounts.js';
import { cardStatementOf, chfOf, markLabel, suggestion } from '../areas/receipts/model.js';
import { cardStatementLine, ledgerFor, noneText, txLine } from '../areas/receipts/view.js';
import { offersInBooks } from '../../intake/near-pairs.js';
import { useFx } from '../hooks/use-fx.js';
import { ReportCorrections } from '../areas/receipts/ReportCorrections.js';
import { processingText } from '../automation/processing.js';
import { useNoAi } from '../ai/no-ai.js';
import { statementSigns } from '../../parsers/receipt-text.js';
import { INTAKE_STEPS, INTAKE_WORKFLOW, inProcess, processingOf, runProcessing } from '../../workflows/processing.js';

const drop = dropStore(
  { open: api.dropOpen, add: api.dropAdd, close: api.dropClose },
  errorText,
  (f) => { const line = failedLine(f, errorText); return line && tWith(line.key, line.vars); },
);
const { set } = drop;
const useDrop = () => useSyncExternalStore(drop.subscribe, drop.get);

export const dropOpen = (): boolean => drop.get().open;

/** Opens the dialog (or uses the open one) and adds the files to its list; `note` says what the drop left out. */
export const dropFiles = (files: File[], note?: string): Promise<void> => drop.drop(files, note);

export const closeDrop = (): void => drop.close();

/** What closing the window by hand does besides closing it (the open dialog sets it): the page behind opens the drop's statement. */
let finishing: (() => void) | undefined;
/** Closes the window as its «Schliessen» does (the shell's Escape too). */
export const finishDrop = (): void => (finishing ? finishing() : closeDrop());

/** Where a taken statement row opens: its file under Kontoauszüge, in the period of its last day. */
export function statementLocation(r: DropRow): Location | undefined {
  const account = r.statement?.account;
  const name = r.statement?.file.split('/').pop();
  if (!account || !name) return undefined;
  return at({ area: 'bank', file: fileKeyOf(account, name) }, r.facts?.to ?? localToday());
}

/**
 * The files a closed window could not upload (#279), named with their reasons: a line beside the
 * pages while the window is closed, in the window while it is open. «Erneut ablegen» drops them again.
 */
function Lost({ inDialog }: { inDialog?: boolean }) {
  const s = useDrop();
  const line = failedLine(s.lost, errorText);
  if (!line || s.open !== !!inDialog) return null;
  return (
    <div className={inDialog ? 'warnline droplost' : 'toast show droplost'} role="alert" data-testid="drop-lost">
      <span>{tWith(line.key, line.vars)}</span>
      <button type="button" className={inDialog ? 'linkbtn' : undefined} data-act="drop-retry" onClick={() => void drop.retry()}>{t('drop.lost.retry')}</button>
      <button type="button" className={inDialog ? 'linkbtn' : undefined} data-act="drop-dismiss" onClick={drop.dismiss}>{t('drop.lost.dismiss')}</button>
    </div>
  );
}

const act = (session: DropSession, r: DropRow, action: Parameters<typeof api.dropRow>[2]) =>
  api.dropRow(session.id, r.key, action).then(drop.answered, (e) => set({ error: errorText(e) }));

const groupIban = (iban: string) => iban.replace(/(.{4})/g, '$1 ').trim();

/** What a waiting row says about its file, the parts apart: its kind (when known), the ZIP it came out of, the statement's account and period. */
function metaOf(r: DropRow): string {
  return [
    r.provider ? t(`drop.report.${r.provider.kind}`, { provider: r.provider.name }) : r.otherExport ? t(`drop.otherExport.kind.${r.otherExport.what}`, { provider: r.otherExport.name }) : r.kind && t(`drop.kind.${r.kind}` as 'drop.kind.receipt'),
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
function ChooseAccount({ r, session }: { r: DropRow; session: DropSession }) {
  const choice = r.chooseAccount!;
  const [adding, setAdding] = useState(false);
  const proposed = choice.accounts.find((a) => a.account === choice.proposed);
  // The proposal (the account whose bank the file names, #208) comes first; the person still clicks it.
  const accounts = proposed ? [proposed, ...choice.accounts.filter((a) => a !== proposed)] : choice.accounts;
  const [keep, setKeep] = useState(true);
  const [busy, setBusy] = useState(false);
  const pick = async (a: (typeof choice.accounts)[number]) => {
    setBusy(true);
    try {
      const next = await api.dropRow(session.id, r.key, { kind: 'account', account: a.account });
      drop.answered(next);
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
      {r.unknownAccount ? (adding ? <AddAccount r={r} session={session} onCancel={() => setAdding(false)} /> : (
        <span className="dacts">
          <button type="button" className="linkbtn" data-testid="drop-firm-account" onClick={() => setAdding(true)}>{t('drop.otherAccount')}</button>
          <button type="button" className="linkbtn" onClick={() => void act(session, r, { kind: 'private' })}>{t('drop.privateAccount')}</button>
        </span>
      )) : null}
    </>
  );
}

/**
 * «Ja, Bankkonto hinzufügen» on a statement of an account the books lack (#401): the account is
 * added right in its row, its bank's name, currency and IBAN read from the file and its ledger
 * account proposed as Firma › Geldkonten would (draftForm), saved through the same route as that
 * form (PATCH /api/workspace addBank, which checks it), and the statement is read in at once: the
 * dialog stays open with all its rows. Firma › Geldkonten stays the way by hand.
 */
function AddAccount({ r, session, onCancel }: { r: DropRow; session: DropSession; onCancel(): void }) {
  const d = r.unknownAccount!;
  const banks = useWorkspace()?.bankAccounts;
  const [busy, setBusy] = useState(false);
  if (!banks) return null;
  // Added already (the statement's read failed after the account was saved): the row reads it into that account, no form again.
  const there = banks.find((a) => a.iban && compactOf(a.iban) === compactOf(d.iban));
  if (there) {
    const read = () => { setBusy(true); api.dropRow(session.id, r.key, { kind: 'firmAccount' }).then(drop.answered, (e) => set({ error: errorText(e) })).finally(() => setBusy(false)); };
    return (
      <span className="dacts">
        <small>{t('drop.addAccount.there', { label: there.label, account: there.account })}</small>
        <button type="button" className="btn primary" data-testid="drop-read-into" disabled={busy} onClick={read}>{t('drop.addAccount.readNow')}</button>
      </span>
    );
  }
  return <AddAccountForm key={d.iban} d={d} banks={banks} r={r} session={session} onCancel={onCancel} />;
}

const compactOf = (iban: string) => iban.replace(/\s+/g, '').toUpperCase();
/** Whether the firm has an account of the statement's IBAN now (#401): the row then offers to read it in. */
const accountThere = (r: DropRow, banks: ReadonlyArray<{ iban?: string }> | undefined) => !!r.unknownAccount && !!banks?.some((a) => a.iban && compactOf(a.iban) === compactOf(r.unknownAccount!.iban));

function AddAccountForm({ d, banks, r, session, onCancel }: { d: NonNullable<DropRow['unknownAccount']>; banks: ReadonlyArray<{ bank: string; currency: string; account: string }>; r: DropRow; session: DropSession; onCancel(): void }) {
  const [f, setF] = useState(() => draftForm(d, banks, Object.keys(getAccountMap())));
  const [busy, setBusy] = useState(false);
  const valid = !!f.bank.trim() && /^\d{4}$/.test(f.account.trim());
  const save = async () => {
    setBusy(true);
    try {
      await api.patchWorkspace({ addBank: { bank: f.bank.trim(), currency: d.currency, account: f.account.trim(), label: f.label.trim() || `${f.bank.trim()} ${d.currency}`, iban: d.iban, ...(f.statements ? { statements: f.statements } : {}) } });
      reloadWorkspace();
      drop.answered(await api.dropRow(session.id, r.key, { kind: 'firmAccount' }));
    } catch (e) {
      set({ error: errorText(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="dpw dadd" data-testid="drop-add-account" onSubmit={(e) => { e.preventDefault(); if (valid && !busy) void save(); }}>
      <small>{t('drop.addAccount.read', { currency: d.currency, iban: groupIban(d.iban) })}</small>
      <label>{t('company.bank')}<input value={f.bank} onChange={(e) => setF({ ...f, bank: e.target.value })} autoFocus /></label>
      <label>{t('yearClose.colAccount')}<input className="mono" inputMode="numeric" value={f.account} onChange={(e) => setF({ ...f, account: e.target.value })} /></label>
      <span className="dacts">
        <button type="submit" className="btn primary" disabled={!valid || busy}>{t('drop.addAccount.save')}</button>
        <button type="button" className="linkbtn" disabled={busy} onClick={onCancel}>{t('common.cancel')}</button>
      </span>
    </form>
  );
}

/**
 * A provider's report whose company file lacks an account (#203): the row asks for it once, one
 * question at a time, each labelled, with its proposal and a sentence on why (#404): the clearing
 * account, then the cut-over day (typed the app's way, dd.mm.yyyy), then, for a sales report whose
 * provider's file names none, the revenue account the firm's setup proposes. The fee report's fee
 * account says in words where the fees' VAT comes from instead of asking a code. One the chart lacks
 * is added when the answer is kept. The answers are kept in that file and the report is taken. A
 * second row of the same provider that asks the same shows no second question, only that it waits for it.
 */
function ProviderAccount({ r, session }: { r: DropRow; session: DropSession }) {
  const ask = r.askProvider!;
  const propose = ask.propose;
  type Step = 'account' | 'since' | 'revenue';
  const steps: Step[] = [...(ask.missing !== 'since' ? ['account' as const] : []), ...(ask.since !== undefined ? ['since' as const] : []), ...(ask.revenue ? ['revenue' as const] : [])];
  const [at, setAt] = useState(0);
  const [answer, setAnswer] = useState<{ account?: string; since: string; revenue?: string }>({ since: ask.since ? formatDate(ask.since) : '' });
  // The fee code is no question (AGENTS.md «Shopify billing»): the proposal is kept; a firm without one types it.
  const [vat, setVat] = useState(propose?.vat ?? '');
  const first = session.rows.find((x) => x.askProvider?.provider === ask.provider && x.askProvider.missing === ask.missing);
  if (first && first.key !== r.key) return <small className="dpq" data-testid="drop-provider-waits">{t('drop.provider.waitsAbove', { provider: ask.name })}</small>;
  const step = steps[at];
  const last = at === steps.length - 1;
  const day = parseSwissDate(answer.since);
  const next = (form: HTMLFormElement) => {
    const field = (n: string) => form.elements.namedItem(n) as HTMLInputElement | null;
    const got = { ...answer };
    if (step === 'account') { const v = field('account')?.value.trim() ?? ''; if (!v) { field('account')?.focus(); return; } got.account = v; }
    if (step === 'since' && !day) { field('since')?.focus(); return; }
    if (step === 'revenue') { const v = field('revenue')?.value.trim() ?? ''; if (!v) { field('revenue')?.focus(); return; } got.revenue = v; }
    setAnswer(got);
    if (!last) { setAt(at + 1); return; }
    const create = !!propose?.name && got.account === propose.account;
    void act(session, r, {
      kind: 'provider', ...(got.account ? { account: got.account } : {}), ...(create ? { create: true } : {}),
      ...(ask.missing === 'fees' ? { vat: vat.trim() } : {}), ...(ask.since !== undefined && day ? { since: day } : {}), ...(got.revenue ? { revenue: got.revenue } : {}),
    });
  };
  const ready = step !== 'since' || !!day;
  const sells = (ask.revenue?.sells ?? []).map((k) => t(`desktop.q.sells.${k}` as 'desktop.q.sells.traded')).join(', ');
  return (
    <form className="dpq" data-testid="drop-provider" data-step={step} onSubmit={(e) => { e.preventDefault(); if (ready) next(e.currentTarget); }}>
      {steps.length > 1 ? <small className="dpn">{t('drop.provider.stepOf', { n: at + 1, of: steps.length })}</small> : null}
      {step === 'account' ? (
        <>
          <b>{t(`drop.provider.q.${ask.missing === 'fees' ? 'fees' : ask.missing === 'revenue' ? 'revenue' : 'clearing'}`, { provider: ask.name })}</b>
          <small>{ask.missing === 'fees' ? (propose?.vat ? t('drop.provider.why.feesVat', { provider: ask.name, code: propose.vat }) : t('drop.provider.why.feesCode'))
            : ask.missing === 'revenue' ? (propose ? t('drop.provider.why.revenueDefault', { account: propose.account }) : '')
              : propose?.name ? t('drop.provider.why.newAccount', { account: propose.account, name: propose.name, provider: ask.name })
                : propose ? t('drop.provider.why.chartAccount', { account: propose.account, provider: ask.name }) : ''}</small>
          <span className="dpw">
            <AccountField key="account" name="account" prefer={ask.missing === 'revenue' ? 'revenue' : ask.missing === 'fees' ? 'expense' : 'asset'} label={t(ask.missing === 'fees' ? 'drop.provider.label.fees' : ask.missing === 'revenue' ? 'drop.provider.label.revenue' : 'drop.provider.label.clearing')} defaultValue={answer.account ?? propose?.account ?? ''} offer={propose?.name ? { number: propose.account, name: propose.name } : undefined} />
            {ask.missing === 'fees' && !propose?.vat ? <input value={vat} onChange={(e) => setVat(e.target.value)} placeholder={t('drop.provider.vat')} aria-label={t('drop.provider.vat')} /> : null}
            <button type="submit" className="btn">{last ? t('drop.provider.keep') : t('drop.provider.next')}</button>
          </span>
        </>
      ) : step === 'since' ? (
        <>
          <b>{t('drop.provider.q.since', { provider: ask.name })}</b>
          <small>{t('drop.provider.why.since', { date: ask.since ? formatDate(ask.since) : '' })}</small>
          <span className="dpw">
            <label className="acf">{t('drop.provider.sinceLabel')}<input name="since" value={answer.since} placeholder={t('period.dateFormat')} onChange={(e) => setAnswer({ ...answer, since: e.target.value })} aria-invalid={!day} /></label>
            <button type="submit" className="btn" disabled={!ready}>{last ? t('drop.provider.keep') : t('drop.provider.next')}</button>
          </span>
          {!day && answer.since ? <small className="wn">{t('period.invalidDate')}</small> : null}
        </>
      ) : (
        <>
          <b>{t('drop.provider.q.revenue', { provider: ask.name })}</b>
          <small>{sells ? t('drop.provider.why.revenue', { account: ask.revenue!.account, sells }) : t('drop.provider.why.revenueDefault', { account: ask.revenue!.account })}</small>
          <span className="dpw">
            <AccountField key="revenue" name="revenue" label={t('drop.provider.label.revenue')} prefer="revenue" defaultValue={answer.revenue ?? ask.revenue!.account} />
            <button type="submit" className="btn">{t('drop.provider.keep')}</button>
          </span>
        </>
      )}
    </form>
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

/** A provider's other export (its payouts list, #406): what it is, which reports the app books from, and where the provider's admin exports them when its file says. */
function otherExportText(o: OtherExportOf): string {
  return [
    t(`drop.otherExport.text.${o.what}`, { provider: o.name }),
    ...o.reports.map((k) => (o.where[k] ? t(`drop.otherExport.reportAt.${k}`, { where: o.where[k]! }) : t(`drop.otherExport.report.${k}`))),
  ].filter(Boolean).join(' ');
}

/** A row with an open question, or one not taken: what it is and its small action. */
function Waiting({ r, session, go }: { r: DropRow; session: DropSession; go(route: Route): void }) {
  const [password, setPassword] = useState('');
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const there = accountThere(r, useWorkspace()?.bankAccounts);
  const asked = r.state === 'duplicate' && r.reason === 'possible-duplicate';
  const chip = r.state === 'take' ? t('drop.taking') : asked ? t('drop.state.possible') : r.otherExport && r.state === 'duplicate' ? t('drop.state.otherExport') : r.readAs ? t('drop.state.read') : t(`drop.state.${r.state}` as 'drop.state.duplicate');
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
          {r.askProvider ? <ProviderAccount key={r.askProvider.missing} r={r} session={session} /> : r.payoutUnseen ? <PayoutUnseenRow r={r} session={session} go={go} /> : r.chooseAccount ? <ChooseAccount r={r} session={session} /> : r.unknownAccount ? (
            <>
              <small>{t(r.unknownAccount.owner ? 'drop.unknownAccountOf' : r.unknownAccount.bankName ? 'drop.unknownAccountAt' : 'drop.unknownAccount', { iban: groupIban(r.unknownAccount.iban), currency: r.unknownAccount.currency, bank: r.unknownAccount.bankName ?? '', owner: r.unknownAccount.owner ?? '' })}</small>
              {adding || there ? <AddAccount r={r} session={session} onCancel={() => setAdding(false)} /> : (
                <>
                  <button type="button" className="linkbtn" data-testid="drop-firm-account" onClick={() => setAdding(true)}>{t('drop.firmAccount')}</button>
                  <button type="button" className="linkbtn" onClick={() => void act(session, r, { kind: 'private' })}>{t('drop.privateAccount')}</button>
                </>
              )}
            </>
          ) : r.readAs ? (
            <>
              <small>{t('drop.readAs', { file: r.readAs.file })}</small>
              {r.readAs.ref ? <button type="button" className="linkbtn" data-testid="drop-open-statement" onClick={() => go({ area: 'bank', payment: r.readAs!.ref })}>{t('drop.openStatement')}</button> : null}
            </>
          ) : r.asked ? <small data-testid="drop-asked">{t('drop.read.asked', { month: monthName(`${r.asked.month}-01`) })}</small>
          : r.otherExport ? <small data-testid="drop-other-export">{otherExportText(r.otherExport)}</small>
          : r.message ? <small>{r.message}</small> : r.reason ? <small>{t(`drop.reason.${r.reason}` as 'drop.reason.duplicate')}</small> : null}
          {asked ? (
            <span className="dacts">
              <button type="button" className="linkbtn" data-testid="drop-twin-same" onClick={() => void act(session, r, { kind: 'twin', answer: 'same' })}>{t('drop.twin.same')}</button>
              <button type="button" className="linkbtn" data-testid="drop-twin-distinct" onClick={() => void act(session, r, { kind: 'twin', answer: 'distinct' })}>{t('drop.twin.distinct')}</button>
            </span>
          ) : r.kind === 'statement-pdf' && r.reason === 'not-imported' && !r.chooseAccount && !r.unknownAccount && !r.read
            ? <button type="button" className="linkbtn" onClick={() => void act(session, r, { kind: 'as', as: 'receipt' })}>{t('drop.isReceipt')}</button>
          : (r.state === 'duplicate' || r.state === 'quarantine') && r.kind !== 'camt' && r.kind !== 'statement-pdf' && (r.kind !== 'statement-csv' || r.reason === 'csv-known' || r.reason === 'provider-export') && r.reason !== 'unreadable'
            ? <button type="button" className="linkbtn" data-testid={r.otherExport ? 'drop-read-anyway' : undefined} onClick={() => void act(session, r, { kind: 'take' })}>{r.state === 'quarantine' && r.reason === 'not-receipt' ? t('drop.isReceipt') : r.otherExport ? t('drop.otherExport.readAnyway') : t('drop.takeAnyway')}</button> : null}
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
  const links = books.mappings.filter((m) => m.receiptId === id);
  // A provider's fee bill booked by code without a payment (src/booking/vat-corrections.ts): its VAT, no payment (#406).
  if (linkedAs(links) === 'feeBill') {
    const bill = books.receipts.find((x) => x.id === id);
    return { kind: 'feeBill', provider: bill?.title?.vendor ?? bill?.vatId ?? '' };
  }
  if (links.length) return { kind: 'matched' };
  if (isWorking(run)) return working;
  if (proc?.kind === 'stuck') return { kind: 'stuck', run: proc.run };
  const receipt = books.receipts.find((x) => x.id === id);
  // At rest but not in the books the page holds: they are being loaded again, unless the run stopped.
  if (!receipt) return run?.status === 'stuck' ? { kind: 'stuck', run: run.id } : working;
  // An order page of the provider way (#253): the provider's order export brings its order, no payment comes for it.
  const ledger = ledgerFor(books);
  const v = ledger.byId.get(id);
  if (v?.orderPage) return { kind: 'orderPage', provider: v.orderPage.name };
  // What Belege says of it, the row says too, as the closing sentence counts it (receiptStateOf, #361): no receipt
  // at all (a holiday photo), a possible copy of a receipt the books hold («schon da?»), not read yet (a photo no AI
  // read, #344), read, or read with its date or amount missing, waiting for her.
  const twin = v?.twin?.relation === 'duplicate' ? ledger.byId.get(v.twin.of) : undefined;
  const st = receiptStateOf(receipt, 0, !!twin);
  // A document beside an invoice (#384): what it is, and the invoice it belongs to when the books show which.
  if (st === 'supporting') {
    const of = v?.twin?.relation === 'companion' ? ledger.byId.get(v.twin.of) : undefined;
    return { kind: 'supporting', ...(v ? { why: noneText(v) } : {}), ...(of ? { of: { id: of.r.id, name: of.vendor ? `${of.vendor}${of.desc ? ` ${of.desc}` : ''}` : of.r.filename } } : {}) };
  }
  if (st === 'none') return { kind: 'none', why: v ? noneText(v) : '' };
  if (st === 'copy') return { kind: 'twin', of: twin!.r.id, name: twin!.vendor || twin!.r.filename, why: v!.twin!.why };
  if (st === 'unread') return { kind: 'unread' };
  return st === 'read' ? { kind: 'read' } : { kind: 'waits' };
}

/**
 * How much of a taken file is done, 0–1 (#341): at rest, all of it; while the inbox's run works on
 * it, the steps the run has behind it and the part of its step that is done (the step's own count,
 * RunSummary.progress). Files of one run share it, so the bar moves while the run reads them.
 */
function doneOf(r: DropRow, x: FileState, view: View): number {
  if (x.kind !== 'working') return 1;
  const run = r.run ? view?.runs.find((y) => y.id === r.run) : undefined;
  if (!run || run.workflow !== INTAKE_WORKFLOW) return 0;
  const step = Math.max(0, (INTAKE_STEPS as readonly string[]).indexOf(run.at ?? ''));
  const within = run.status === 'running' && run.progress?.total ? run.progress.done / run.progress.total : 0;
  return (step + within) / INTAKE_STEPS.length;
}

/**
 * What came of the drop, once nothing of it is worked on any more (#341): the payments read and
 * from when to when, how many are booked and how many wait for what; the receipts read and linked;
 * each line with a link to them in the period they landed in.
 */
function Summary({ sum, rows, books, go, receiptOf, feeBillsOf }: { sum: DropSummary; rows: readonly DropRow[]; books: Index; go(loc: Location): void; receiptOf(r: DropRow): { date?: string; dateSource?: 'captured' } | undefined; feeBillsOf: string }) {
  const today = localToday();
  const dates = datesIn(books, receiptOf);
  const periodOf = (of: readonly DropRow[]) => majorityPeriod(of, dates, today, filing().length);
  const pays = sum.payments;
  const paid = pays ? periodOf(rows.filter((r) => r.statement)) : undefined;
  const files = sum.files;
  const noAi = useNoAi();
  const filed = files ? periodOf(rows.filter((r) => !r.statement)) : undefined;
  // What is open is listed in the period of the oldest payment not booked, which need not be the one most payments are in.
  const open = pays?.openFrom ? parsePeriod(filingKeyOf(pays.openFrom, filing().length), today) ?? undefined : undefined;
  if (!pays && !files) return null;
  const receipts = files ? receiptLines(files, noAi, feeBillsOf) : '';
  const others = files ? otherLines(files) : '';
  return (
    <div className="dsum" data-testid="drop-summary">
      {files?.statement || pays ? (
        <p>
          {pays ? t('drop.sum.line', {
            head: t('drop.sum.payments', { files: t('drop.sum.statements', { n: files?.statement ?? 0 }), n: pays.n, from: formatDate(pays.from), to: formatDate(pays.to) }),
            parts: [
              t('drop.sum.booked', { n: pays.booked }),
              pays.waitReceipt ? t('drop.sum.waitReceipt', { n: pays.waitReceipt }) : '',
              pays.asked ? t('drop.sum.asked', { n: pays.asked }) : '',
              pays.unbooked ? t('drop.sum.unbooked', { n: pays.unbooked }) : '',
            ].filter(Boolean).join(', '),
          }) : t('drop.sum.statementsOnly', { n: files!.statement })}{' '}
          {paid ? <button type="button" className="linkbtn" data-testid="drop-to-payments" onClick={() => go({ route: { area: 'bank' }, query: { period: paid } })}>{t('drop.sum.toPayments', { period: periodName(paid) })}</button> : null}
          {open && chargesVat() ? <>{' · '}<button type="button" className="linkbtn" data-testid="drop-to-open" onClick={() => go({ route: { area: 'vat', ziffer: OPEN_ITEMS }, query: { period: open } })}>{t('drop.sum.toOpen', { period: periodName(open) })}</button></> : null}
        </p>
      ) : null}
      {receipts ? (
        <p>
          {receipts}{' '}
          {files!.unread && noAi ? <><button type="button" className="linkbtn" data-act="ai-set-up" onClick={() => go({ route: { area: 'company', section: 'ai' }, query: {} })}>{t('aiSetup.line.setUp')}</button>{' · '}</> : null}
          {filed ? <button type="button" className="linkbtn" data-testid="drop-to-receipts" onClick={() => go({ route: { area: 'receipts' }, query: { period: filed } })}>{t('drop.sum.toReceipts', { period: periodName(filed) })}</button> : null}
        </p>
      ) : null}
      {others ? <p data-testid="drop-sum-others">{others}</p> : null}
    </div>
  );
}

/**
 * The sentence of each closing group, in the words its rows use (#384). A record over every group:
 * a new group without its sentence does not compile, so no row is left out of the closing lines.
 */
/** A closing group's sentence (CLOSING_SENTENCE); a photo no AI read says why on a Mac without one. */
const sentence = (g: keyof typeof CLOSING_SENTENCE, n: number, noAi: boolean, providers = '') =>
  t(g === 'unread' && noAi ? 'drop.sum.unreadNoAi' : g === 'feeBill' && !providers ? 'drop.sum.feeBillsUnnamed' : CLOSING_SENTENCE[g], { n, provider: providers });

/** The receipts' sentences: read (linked or not), beside an invoice, a possible copy, incomplete, waiting for their reading, order pages, stopped. */
function receiptLines(f: ClosingCounts, noAi: boolean, feeBillsOf: string): string {
  const { read, matched, unmatched } = readOf(f);
  return [
    read ? t('drop.sum.line', {
      head: t('drop.sum.receipts', { n: read }),
      parts: [matched ? t('drop.sum.matched', { n: matched }) : '', unmatched ? t('drop.sum.unmatched', { n: unmatched }) : ''].filter(Boolean).join(', '),
    }) : '',
    ...RECEIPT_SENTENCES.map((g) => (f[g] ? sentence(g, f[g], noAi, g === 'feeBill' ? feeBillsOf : '') : '')),
  ].filter(Boolean).join(' ');
}

/** The files that brought nothing new or wait in their row: no receipt, already there, a question, set aside, not saved, taken back, still worked on. */
function otherLines(f: ClosingCounts): string {
  return OTHER_SENTENCES.map((g) => (f[g] ? sentence(g, f[g], false) : '')).filter(Boolean).join(' ');
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
function Taken({ r, session, books, go, onGo, refresh }: { r: DropRow; session: DropSession; books: Index; go(route: Route, date?: string): void; onGo(loc: Location): void; refresh(): void }) {
  const { view } = useAutomation();
  const { rates } = useFx();
  const noAi = useNoAi();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const x = fileState(r, books, view);
  const receipt = books.receipts.find((y) => y.id === receiptIdOf(r, view));
  // A document beside an invoice shows no amount of its own: an order confirmation is no amount of 0.00 (#384).
  const amount = x.kind === 'supporting' ? undefined : receipt?.amount;
  const facts = !r.report && receipt && (receipt.date || amount !== undefined)
    ? [receipt.date && formatDate(receipt.date), amount !== undefined && `${receipt.currency ?? ''} ${fmt(amount)}`.trim()].filter(Boolean).join(' · ') : '';
  const running = view?.runs.find((y) => y.id === r.run)?.status === 'running';
  const lacks = (x.kind === 'waits' || x.kind === 'stuck') && receipt ? [!receipt.date && t('drop.p.date'), receipt.amount === undefined && t('drop.p.amount')].filter(Boolean).join(', ') : '';
  // «Zahlung bestätigen» only when Belege has a payment to propose for it (r8k-5).
  const ledger = ledgerFor(books);
  const proposed = x.kind === 'waits' && receipt && ledger.byId.has(receipt.id) ? !!suggestion(ledger.byId.get(receipt.id)!, ledger, chfOf(rates)) : false;
  // A payment that may fit without any rule linking it (#397): named in the row, the receipt's page offers it with what differs.
  const maybe = (x.kind === 'read' || x.kind === 'waits') && receipt && !lacks && !proposed
    ? offersInBooks(books, { receipt: receipt.id }, ledger.firm).find((o) => !o.filed) : undefined;
  const maybeTx = maybe && ledger.txByRef.get(maybe.payment);
  const missing = maybeTx ? t('near.dropMaybe', { what: txLine(maybeTx) }) : x.kind !== 'waits' && x.kind !== 'stuck' ? '' : lacks ? t('drop.p.missing', { what: lacks }) : proposed ? t('drop.p.payment') : t('drop.p.noPayment');
  const shown = !!receipt && open;
  // The books changed under the page: Belege must not show the receipt any more.
  const undo = () => { setBusy(true); void act(session, r, { kind: 'undo' }).then(refresh).finally(() => setBusy(false)); };
  // «schon da?» of a photo the run read (#361): answered as Belege answers it, the copy then set aside, or the pair not asked again.
  const twin = (answer: 'same' | 'distinct', of: string) => {
    setBusy(true);
    api.answerTwin(receipt!.id, answer, of).then(refresh, (e) => set({ error: errorText(e) })).finally(() => setBusy(false));
  };
  // A statement PDF kept as the statement, its movements not read in (#254): «Aktionen» reads them.
  const keptPdf = r.kind === 'statement-pdf' && !!r.statement?.file.toLowerCase().endsWith('.pdf');
  // Taken onto the one account of the bank it names (#273): said in the row, with «ändern».
  const byBank = r.byBank?.accounts.find((a) => a.account === r.statement?.account);
  const [menu, setMenu] = useState<DOMRect | null>(null);
  const readPdf = () => { setBusy(true); void act(session, r, { kind: 'readPdf' }).then(refresh).finally(() => setBusy(false)); };
  const statementAt = statementLocation(r);
  // A card statement taken as a receipt (#401): what the app did with it, in its row.
  const card = receipt && !r.report ? cardStatementOf(receipt, books) : undefined;
  // «Ist doch ein Beleg» (#361): the person's word, as Belege takes it; the run then reads the file again, never asking whether it is one.
  const isReceipt = () => {
    setBusy(true);
    api.patchReceipt(receipt!.id, { kind: 'invoice' }).then(() => { refresh(); void startIntake(); }, (e) => set({ error: errorText(e) })).finally(() => setBusy(false));
  };
  return (
    <>
      <div className={`droprow s-taken${shown ? ' open' : ''}`} data-testid="drop-row" data-file={r.name} data-state={x.kind}>
        <div className="dn"><b className="mono">{r.name}</b><small>{r.report ? `${t(`drop.report.${r.report.kind}`, { provider: r.report.name })} · ${reportLine(r.report)}` : r.statement ? [r.read && t(`drop.read.by.${r.read.by}`), r.facts?.from && r.facts.to && `${formatDate(r.facts.from)} – ${formatDate(r.facts.to)}`, keptPdf ? t('drop.kept') : t('drop.entries', { n: r.statement.refs.length })].filter(Boolean).join(' · ') : receipt && receipt.filename !== r.name ? receipt.filename : t(`drop.kind.${r.kind ?? 'receipt'}` as 'drop.kind.receipt')}{facts ? ` · ${facts}` : ''}{r.twin?.relation === 'companion' ? ` · ${t('drop.twin.companion', { name: r.twin.name })}` : r.document ? ` · ${t(`drop.doc.${r.document}` as 'drop.doc.newsletter')}` : ''}</small>
          {r.payouts ? <small data-testid="drop-payouts" data-waits={r.payouts.waits ?? ''}>{payoutsBookedText(r.payouts, r.payouts.provider)}</small> : null}
          {r.payouts?.waits ? <button type="button" className="linkbtn dfold" data-testid="drop-payouts-switch-on" onClick={() => go(BOOKING_SWITCH_ON)}>{t('marks.goSwitchOn')}</button> : null}</div>
        <div className="dgo">
          <span className={`dchip p-${x.kind}`}>{x.kind === 'working' ? (x.step ?? t('drop.p.working')) : t(`drop.p.${x.kind}` as 'drop.p.read')}</span>
          {x.kind === 'unread' ? (
            <small className="dwhy" data-testid="drop-unread">
              {t(noAi ? 'drop.p.unreadNoAi' : 'drop.p.unreadFailed')}{' '}
              {noAi ? <button type="button" className="linkbtn" data-act="ai-set-up" onClick={() => go({ area: 'company', section: 'ai' })}>{t('aiSetup.line.setUp')}</button> : null}
            </small>
          ) : null}
          {missing ? <small className="dwhy" {...(maybeTx && { 'data-testid': 'drop-near' })}>{missing}</small> : x.kind === 'orderPage' ? <small className="dwhy" data-testid="drop-order-page">{t('drop.p.orderPageWhy', { provider: x.provider })}</small> : x.kind === 'refused' ? <small className="dwhy">{reasonText(x.reason)}</small>
            : x.kind === 'none' ? <small className="dwhy" data-testid="drop-none">{x.why}</small>
            : x.kind === 'supporting' ? <small className="dwhy" data-testid="drop-supporting">{x.of ? t('drop.p.supportingOf', { what: x.why || t('receipts.why.supporting'), name: x.of.name }) : t('drop.p.supportingAlone', { what: x.why || t('receipts.why.supporting') })}</small>
            : x.kind === 'twin' ? <small className="dwhy" data-testid="drop-twin">{t('drop.twin.duplicate', { name: x.name })} · {t(`drop.twin.why.${x.why}`)}</small> : null}
          {card ? <small className="dwhy" data-testid="drop-card-statement">{cardStatementLine(card)}</small> : null}
          {emptyRefsLine(r.statement?.emptyRefs) ? <small className="dwhy" data-testid="drop-empty-refs">{emptyRefsLine(r.statement?.emptyRefs)}</small> : null}
          {byBank ? <small className="dwhy" data-testid="drop-by-bank">{t('drop.byBank', { label: byBank.label })}</small> : null}
          <span className="dacts">
            {x.kind === 'twin' && receipt ? (
              <>
                <button type="button" className="linkbtn" data-testid="drop-twin-same" disabled={busy} onClick={() => twin('same', x.of)}>{t('drop.twin.same')}</button>
                <button type="button" className="linkbtn" data-testid="drop-twin-distinct" disabled={busy} onClick={() => twin('distinct', x.of)}>{t('drop.twin.distinct')}</button>
              </>
            ) : null}
            {byBank ? <button type="button" className="linkbtn" data-testid="drop-other-account" disabled={running || busy} data-tip={t('drop.byBankChangeTip')} onClick={() => { setBusy(true); void act(session, r, { kind: 'otherAccount' }).then(refresh).finally(() => setBusy(false)); }}>{t('drop.byBankChange')}</button> : null}
            {statementAt ? <button type="button" className="linkbtn" data-testid="drop-open-file" onClick={() => { closeDrop(); onGo(statementAt); }}>{t('drop.openStatement')}</button> : null}
            {x.kind === 'supporting' && x.of ? <button type="button" className="linkbtn" data-testid="drop-open-invoice" onClick={() => go({ area: 'receipts', id: x.of!.id }, books.receipts.find((y) => y.id === x.of!.id)?.date)}>{t('drop.p.openInvoice')}</button> : null}
            {(x.kind === 'none' || x.kind === 'supporting') && receipt && receipt.kind !== 'statement' && receipt.kind !== 'duplicate' ? <button type="button" className="linkbtn" data-testid="drop-is-receipt" disabled={busy} onClick={isReceipt}>{t(markLabel(receipt))}</button> : null}
            {x.kind === 'stuck' ? <button type="button" className="linkbtn" data-testid="drop-stuck-run" onClick={() => go({ area: 'automation', view: 'run', run: x.run })}>{t('processing.toRun')}</button> : null}
            {receipt ? <button type="button" className="linkbtn" onClick={() => go({ area: 'receipts', id: receipt.id }, receipt.date)}>{t(x.kind === 'unread' ? 'drop.p.typeIn' : 'drop.openReceipt')}</button> : null}
            {/* A file that could be a statement (#384): not read, read as one, or read without a total or with a statement's signs; never a receipt read with its total, nor one linked to its payment, nor a card statement (#401). */}
            {(r.kind === 'receipt' || r.kind === 'photo') && !r.report && !card && (x.kind === 'unread' || (x.kind === 'none' && receipt?.kind === 'statement')
              || ((x.kind === 'read' || x.kind === 'waits') && !!receipt && (receipt.amount == null || statementSigns(receipt.extractedText ?? '')))) ? <button type="button" className="linkbtn" data-testid="drop-as-statement" disabled={busy} onClick={() => { setBusy(true); void act(session, r, { kind: 'statement' }).then(refresh).finally(() => setBusy(false)); }}>{t('drop.asStatement')}</button> : null}
            {keptPdf ? <button type="button" className="linkbtn" data-act="actions" data-testid="drop-actions" aria-haspopup="menu" aria-expanded={!!menu} disabled={busy} onClick={(e) => setMenu(e.currentTarget.getBoundingClientRect())}>{t('actions.label')}</button> : null}
            {r.statement?.again ? null : <button type="button" className="linkbtn" disabled={running || busy} data-tip={running ? t('drop.undoBusy') : undefined} onClick={undo}>{t('drop.undo')}</button>}
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

/**
 * `period`: the one on screen. While the window is open, the page behind it moves to the period
 * most of the dropped files landed in (`onLanded`, drop-summary.ts), once per new period, so the
 * person sees them on closing it; at its end the window says what came of the drop.
 */
export function DropDialog({ onGo, onLanded, onStatement, period, books, refresh }: { onGo(loc: Location): void; onLanded(p: Period): void; onStatement(loc: Location): void; period: Period; books: Index; refresh(): void }) {
  const s = useDrop();
  const { view } = useAutomation();
  const [tab, setTab] = useState<DropTab>('all');
  const accounts = useWorkspace()?.bankAccounts;
  const { questions, me } = useQuestions();
  const receiptOf = (r: DropRow) => books.receipts.find((y) => y.id === receiptIdOf(r, view));
  const landed = s.open && s.session ? landedPeriod(s.session.rows, datesIn(books, receiptOf), period, localToday(), filing().length) : undefined;
  useEffect(() => { if (landed) onLanded(landed); }, [landed?.token]);
  if (!s.open) { finishing = undefined; return <Lost />; }
  const rows = s.session?.rows ?? [];
  const tabs: DropTab[] = ['all', 'statements', 'receipts', ...(rows.some((r) => tabOf(r) === 'unclear') ? ['unclear' as const] : []), 'out'];
  const shown = tab === 'all' ? rows : rows.filter((r) => tabOf(r) === tab);
  const taken = rows.filter((r) => r.state === 'taken');
  const states = taken.map((r) => fileState(r, books, view));
  const working = s.adding > 0 || rows.some((r) => r.state === 'take') || states.some((x) => x.kind === 'working');
  const finished = states.filter((x) => x.kind !== 'working').length;
  // Files still uploading or being taken count as not begun, so the bar does not fall back when they join.
  const coming = s.adding + rows.filter((r) => r.state === 'take').length;
  const pct = dropProgress([...taken.map((r, i) => doneOf(r, states[i], view)), ...Array<number>(coming).fill(0)]);
  // Every row in one group of the closing lines, by the state its own row shows (#384).
  const stateOf = new Map(taken.map((r, i) => [r, states[i]]));
  const sum = !working && rows.length ? dropSummary(rows, books, isUnbooked(books, accounts ?? []), receiptWaits(books, accounts ?? []), questions, (r) => closingGroupOf(r, stateOf.get(r))) : undefined;
  // Only files the books hold already (#341): the window says that nothing new came in.
  const nothingNew = !working && !taken.length && rows.length > 0 && rows.every((r) => (r.state === 'duplicate' && r.reason !== 'possible-duplicate') || !!r.readAs);
  // What waits for her, named where it is (#398): the receipts of this drop under Belege, every open task under Automatisierung › Aufgaben, as the dock counts them.
  const left = waitsAfterDrop(states, tasksWaiting(view, forMe(questions, me).length));
  const receiptsWait = working ? 0 : left.receipts;
  const tasksWait = working || !taken.length ? 0 : left.tasks;
  // A receipt of a sealed quarter opens in that quarter, not in the open one (r9k-8).
  const go = (route: Route, date?: string) => { closeDrop(); onGo(date ? at(route, date) : { route, query: {} }); };
  // The last statement the drop read in: closing the window by hand opens it (Kontoauszüge does, #361).
  const statement = [...rows].reverse().map((r) => (r.state === 'taken' ? statementLocation(r) : undefined)).find(Boolean);
  finishing = () => { closeDrop(); if (statement) onStatement(statement); };
  return (
    <>
      <div className="scrim" style={{ background: 'color-mix(in srgb, var(--bg) 45%, transparent)' }} onClick={finishDrop} />
      <div className="palette dropdlg" role="dialog" aria-label={t('drop.dialog')} data-testid="drop-dialog" data-working={working}>
        <div className="dhd">
          <b>{!taken.length ? t('drop.dialog') : working ? t('drop.titleWorking') : t('drop.titleDone')}</b>
          {s.adding ? <span className="wfpill st-running">{t('drop.reading', { n: s.adding })}</span> : null}
          <button type="button" className="chip" aria-label={t('common.close')} onClick={finishDrop}>×</button>
        </div>
        {taken.length && !sum ? (
          <div className="dprog">
            <div className="dbar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}><i style={{ width: `${pct}%` }} /></div>
            <p className="m">{t('drop.overall', { pct, done: finished, n: taken.length + coming })}</p>
          </div>
        ) : null}
        {nothingNew ? <div className="dsum" data-testid="drop-nothing-new"><p>{t('drop.sum.nothing')}</p></div> : null}
        {sum && !nothingNew ? <Summary sum={sum} rows={taken} books={books} receiptOf={receiptOf} feeBillsOf={[...new Set(states.flatMap((x) => (x.kind === 'feeBill' && x.provider ? [x.provider] : [])))].join(', ')} go={(loc) => { closeDrop(); onGo(loc); }} /> : null}
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
            ? <Taken key={r.key} r={r} session={s.session!} books={books} go={go} onGo={onGo} refresh={refresh} />
            : <Waiting key={r.key} r={r} session={s.session!} go={go} />)) : <p className="m">{rows.length ? t('drop.emptyTab') : t('drop.empty')}</p>}
        </div>
        {s.note ? <p className="warnline" data-testid="drop-note">{s.note}</p> : null}
        {s.error ? <p className="warnline">{s.error}</p> : null}
        <Lost inDialog />
        {receiptsWait || tasksWait ? (
          <p className="m" data-testid="waits-where">
            {receiptsWait ? <button type="button" className="linkbtn" onClick={() => go({ area: 'receipts' })}>{t('drop.waitsReceipts', { n: receiptsWait })}</button> : null}
            {receiptsWait && tasksWait ? ' · ' : null}
            {tasksWait ? <button type="button" className="linkbtn" onClick={() => go({ area: 'automation', view: 'tasks' })}>{t('drop.waitsTasks', { n: tasksWait })}</button> : null}
          </p>
        ) : null}
        {rows.some((r) => (r.state === 'duplicate' && r.reason === 'possible-duplicate') || r.state === 'locked' || r.state === 'unclear') ? <p className="m" data-testid="close-hint">{t('drop.closeHint')}</p> : null}
        {rows.some((r) => r.state === 'asks' && !r.asked) ? <p className="m" data-testid="read-hint">{t('drop.read.closeHint')}</p> : null}
        {rows.some((r) => r.state === 'asks' && r.asked) ? <p className="m" data-testid="asked-hint">{t('drop.read.askedHint')}</p> : null}
        <div className="dfoot">
          <span className="m">{taken.length ? <button type="button" className="linkbtn" onClick={() => go({ area: 'automation', view: 'runs' })}>{t('drop.toRuns')}</button> : t('drop.moreHint')}</span>
          <button type="button" className="btn primary" data-testid="drop-close" onClick={finishDrop}>{working ? t('drop.background') : t('common.close')}</button>
        </div>
      </div>
    </>
  );
}
