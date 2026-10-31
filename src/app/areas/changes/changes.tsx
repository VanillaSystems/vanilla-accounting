/**
 * Änderungen (the mockup's screen 7): left the sync state and Verlauf, every save with who and
 * when; right what changed since the last save, without AI: the books by the runs that wrote them,
 * and each file of how the app works with who changed it. «Speichern vorbereiten» lets the AI
 * group all of it into saves; the person talks to it and saves. Workflows and the AI write; they
 * do not save.
 */
import { Fragment, useState } from 'react';
import './changes.css';
import { aiIsOff, useAiOff } from '../../ai/ai-off.js';
import type { RouteOf } from '../../shell/route.js';
import { moveKey } from '../../shell/keyboard.js';
import { formatDate } from '../../lib/utils.js';
import { localToday, parsePeriod } from '../../../accounting/periods.js';
import { t } from '../../i18n/index.js';
import { changesCommand, changesNow as lastView, pollChanges, useChanges, useDiff, useSave } from '../../changes/store.js';
import { api, errorText } from '../../lib/api.js';
import { BotIcon } from '../automation/Graph.js';
import { BOOKS, diffLines, hunks, type ChangesView, type FileChange, type ReceiptChange, type RecordChange, type SaveSummary, type SavingCommand, type SavingResult } from '../../../saving/model.js';
import { ICONS } from '../icons.js';
import { RuleDraft } from '../company/RulesSection.js';
import { at } from '../receipts/view.js';
import type { Area, AreaProps, LegendItem, Nav } from '../index.js';

type Props = AreaProps<RouteOf<'changes'>>;
type R = RouteOf<'changes'>;

/** A save's moment in the viewer's own time zone: git stores it as an instant. */
const local = (iso: string) => { const d = new Date(iso); const p = (n: number) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };
const when = (iso: string) => local(iso).slice(11, 16);
const dayOf = (iso: string) => local(iso).slice(0, 10);
const kindLabel = (k: SaveSummary['kind']) => t(`changes.kind.${k}` as 'changes.kind.books');
const stateLabel = (s: FileChange['state']) => t(`changes.state.${s}` as 'changes.state.added');

/** A file of the company's rules: a guide of knowledge/rules/ or a business's file (src/booking/rule-book.ts holdsRules). */
const isRulesFile = (path: string) => path.startsWith('knowledge/') && path.endsWith('.yaml') && !path.split('/').pop()!.startsWith('_');

/** The rows of the list: Verlauf. */
function rowsOf(view: ChangesView | undefined): R[] {
  return (view?.history ?? []).map((s): R => ({ area: 'changes', commit: s.oid }));
}

const PERSON = <svg className="i" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></svg>;
const FLOW = <svg className="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg>;
/** Who a save or a change is from: a run (the books), the AI's draft, a person. */
const whoIcon = (k: SaveSummary['kind'] | 'draft' | 'outside') => (k === 'books' ? FLOW : k === 'draft' ? <BotIcon /> : PERSON);
/** «heute 11:40», «gestern 17:30», else the date and time. */
function sayWhen(iso: string): string {
  const day = dayOf(iso), today = local(new Date().toISOString()).slice(0, 10), y = new Date(); y.setDate(y.getDate() - 1);
  return day === today ? t('changes.today', { time: when(iso) }) : day === local(y.toISOString()).slice(0, 10) ? t('changes.yesterday', { time: when(iso) }) : `${formatDate(day)} ${when(iso)}`;
}

function List({ route, nav }: Props) {
  const { view, error } = useChanges();
  return (
    <>
      <h1>{t('area.changes')}</h1>
      {view?.repository ? <SyncLine view={view} nav={nav} /> : null}
      {error ? <p className="warnline">{error}</p> : null}
      {view && !view.repository ? <p className="m">{t('changes.noRepository')}</p> : null}
      <div className="rows" role="listbox" aria-label={t('area.changes')}>
        {view?.history.length ? <div className="group"><span>{t('changes.history')}</span></div> : null}
        {(view?.history ?? []).map((s) => {
          const on = route.commit === s.oid;
          return (
            <div key={s.oid} className={`row chrow chsave-row${on ? ' sel' : ''}`} role="option" aria-selected={on} tabIndex={on ? 0 : -1} onClick={() => nav.select({ area: 'changes', commit: s.oid })}>
              <span className="t"><span className="chwho">{whoIcon(s.kind)}</span>{s.subject}</span>
              <small className="chsub">{sayWhen(s.at)} · {s.author}{s.locked ? ` · ${t('changes.locked')}` : ''}</small>
            </div>
          );
        })}
      </div>
    </>
  );
}

function Detail({ route, nav }: Props) {
  const { view, error } = useChanges();
  if (!view) return <div className="detail-empty">{error ? null : <div>{t('changes.loading')}</div>}</div>;
  if (!route.commit) return <SavePanel view={view} nav={nav} />;
  const back = <button type="button" className="linkbtn chback" onClick={() => nav.select(route.file && route.commit !== 'draft' && route.commit !== 'outside' ? { area: 'changes', commit: route.commit } : { area: 'changes' })}>{t('changes.back')}</button>;
  if (route.file) return <>{back}<FileView source={route.commit} path={route.file} rev={view.rev} /></>;
  return <>{back}<SaveView oid={route.commit} nav={nav} /></>;
}

function SaveView({ oid, nav }: { oid: string; nav: Nav }) {
  const { data, error } = useSave(oid);
  if (error) return <div className="detail-empty"><div>{error}</div></div>;
  if (!data) return <div className="detail-empty"><div>{t('changes.loading')}</div></div>;
  const body = data.body.split('\n').slice(1).filter((l) => l.trim() && !/^Vanilla-[A-Za-z]+: /.test(l)).join('\n');
  return (
    <div className="detail-in chpage" key={oid}>
      <div className="head"><h2 className="who">{data.subject}<small>{formatDate(dayOf(data.at))} {when(data.at)} · {t('changes.by', { author: data.author })} · <span className="mono">{data.short}</span></small></h2></div>
      <p className="lead"><span className={`chkind k-${data.kind}`}>{kindLabel(data.kind)}</span>{data.run ? <button type="button" className="linkbtn" onClick={() => nav.go({ route: { area: 'automation', view: 'run', run: data.run! }, query: {} })}>{t('automation.run', { id: data.run })}</button> : null}</p>
      {body ? <pre className="chbody">{body}</pre> : null}
      {data.undo ? <UndoButton oid={oid} kind={data.undo} nav={nav} /> : data.undoBlocked ? <p className="chundo"><span className="m">{t(`changes.undoBlocked.${data.undoBlocked}`)}</span></p> : null}
      <h3 className="chh3">{t('changes.files')}</h3>
      <div className="chfiles">
        {data.files.map((f) => (
          <button key={f.path} type="button" className="chfile" onClick={() => nav.select({ area: 'changes', commit: oid, file: f.path })}>
            <span className="mono">{f.path}</span><span className="chcount"><span className="plus">+{f.added}</span> <span className="minus">−{f.removed}</span></span>
          </button>
        ))}
      </div>
    </div>
  );
}

function FileView({ source, path, rev }: { source: string; path: string; rev: string | undefined }) {
  const { data, error } = useDiff(source, path, rev);
  const [whole, setWhole] = useState(false);
  if (error) return <div className="detail-empty"><div>{error}</div></div>;
  if (!data) return <div className="detail-empty"><div>{t('changes.loading')}</div></div>;
  const lines = diffLines(data.before, data.after);
  const shown = whole ? lines : hunks(lines);
  return (
    <div className="detail-in chpage" key={source + path}>
      <div className="head"><h2 className="who mono chpath">{path}<small>{source === 'draft' ? t('changes.draft') : source === 'outside' ? t('changes.outside') : source.slice(0, 7)}</small></h2></div>
      <div className="wftabs" role="tablist">
        <button type="button" role="tab" aria-selected={!whole} className={whole ? '' : 'on'} onClick={() => setWhole(false)}>{t('changes.diff')}</button>
        <button type="button" role="tab" aria-selected={whole} className={whole ? 'on' : ''} onClick={() => setWhole(true)}>{t('changes.whole')}</button>
      </div>
      {lines.every((l) => l.kind === ' ') ? <p className="m">{t('changes.same')}</p> : (
        <pre className="chdiff">
          {shown.map((l, i) => (l === null
            ? <span key={i} className="gap">⋯{'\n'}</span>
            : <span key={i} className={`ln k${l.kind === '+' ? 'add' : l.kind === '-' ? 'del' : 'same'}`}><span className="no">{l.old ?? ''}</span><span className="no">{l.new ?? ''}</span>{l.kind}{l.text}{'\n'}</span>))}
        </pre>
      )}
    </div>
  );
}

/** Runs a saving command and says how it went; a refusal is a toast with its reason. */
function useCommand(nav: Nav): [string | undefined, (cmd: SavingCommand) => Promise<SavingResult | undefined>] {
  const [busy, setBusy] = useState<string>();
  const go = async (cmd: SavingCommand) => {
    setBusy(cmd.kind);
    try {
      const r = await changesCommand(cmd);
      if (!r.ok) nav.toast(r.message);
      else if (r.saved !== undefined) nav.toast(t('changes.savedToast', { n: r.saved }));
      else if (r.plain) nav.toast(t(aiIsOff() ? 'changes.preparedPlainOff' : 'changes.preparedPlainToast'));
      else if (cmd.kind === 'sync') nav.toast(t('changes.syncedToast'));
      return r;
    } catch (e) {
      nav.toast(errorText(e));
      return undefined;
    } finally {
      setBusy(undefined);
    }
  };
  return [busy, go];
}

function receiptChangeText(c: ReceiptChange): string {
  const when = sayWhen(c.at);
  switch (c.kind) {
    case 'deleted': return t('changes.receiptDeleted', { when });
    case 'linked': return t('changes.receiptLinked', { when, payment: c.payment });
    case 'unlinked': return t('changes.receiptUnlinked', { when, payment: c.payment });
    case 'edited': return t('changes.receiptEdited', { when });
    case 'privateOutlay': return t('changes.receiptOutlay', { when, payment: c.payment });
  }
}

function receiptUndoTip(c: ReceiptChange): string {
  switch (c.kind) {
    case 'deleted': return t('changes.receiptRestoreTip');
    case 'linked': return t('changes.receiptUnlinkTip');
    case 'unlinked': return t('changes.receiptLinkTip');
    case 'edited': return t('changes.receiptEditTip');
    case 'privateOutlay': return t('changes.outlayUndoTip');
  }
}

/** «Rückgängig» of what a person did to a receipt (r8k-7): the opposite write, an API call with its refusals in the person's language. */
async function undoReceiptChange(c: ReceiptChange, nav: Nav) {
  try {
    switch (c.kind) {
      case 'deleted': await api.restoreReceipt(c.id, c.deletion); break;
      case 'linked': await api.removeMapping({ receiptId: c.id, transactionRef: c.payment }); break;
      case 'unlinked': await api.addMapping({ receiptId: c.id, transactionRef: c.payment }); break;
      case 'edited': await api.patchReceipt(c.id, c.back); break;
      case 'privateOutlay': await api.deleteTransaction(c.payment); break;
    }
    nav.refresh();
    await pollChanges();
  } catch (e) {
    nav.toast(errorText(e));
  }
}

/** «Rückgängig» of a record change (r9c-6): the API call its `undo` names; its refusals in the person's language. */
async function undoRecordChange(c: Extract<RecordChange, { undo: unknown }>, nav: Nav) {
  try {
    const u = c.undo;
    switch (u.kind) {
      case 'deleteDraft': await api.deleteDraft(u.id); break;
      case 'customerBack': await api.patchCustomer(u.id, u.fields); break;
      case 'accountRemove': await api.removeAccount(u.number); break;
      case 'accountRename': await api.setAccountName(u.number, u.name); break;
      case 'templateBack': await api.markYearEndEntry(u.year, u.template, u.state); break;
      case 'releasePayment': await api.releasePayment(u.id, u.transactionRef); break;
      case 'relinkPayment': await api.confirmPayment(u.id, u.transactionRef); break;
    }
    nav.refresh();
    await pollChanges();
  } catch (e) {
    nav.toast(errorText(e));
  }
}

/** Where a record change leads: the invoice, the customers, the statement's bank, the close's step, the chart. */
function recordRoute(c: RecordChange): Parameters<Nav['go']>[0] {
  switch (c.kind) {
    case 'invoice': return at({ area: 'invoices', view: 'list', id: c.number ?? `draft-${c.id}` }, c.date);
    case 'customer': return { route: { area: 'invoices', view: 'customers', id: c.id }, query: {} };
    case 'statement': return at({ area: 'bank' }, c.to);
    case 'yearClose': return { route: { area: 'close', step: 'entries' }, query: { period: parsePeriod(c.year, localToday())! } };
    case 'account': return { route: { area: 'company', section: 'accounts' }, query: {} };
  }
}

/** What a record change says of itself. */
function recordText(c: RecordChange): string {
  const when = sayWhen(c.at);
  switch (c.kind) {
    case 'invoice': return t(`changes.record.invoice.${c.state}`, { when, payment: c.payment ?? '' });
    case 'customer': return t(`changes.record.customer.${c.state}`, { when });
    case 'statement': return t('changes.record.statement', { when, from: formatDate(c.from), to: formatDate(c.to) });
    case 'yearClose': return t(`changes.record.yearClose.${c.state}`, { when, step: tx(`yearClose.template.${c.template}`) });
    case 'account': return t(`changes.record.account.${c.state}`, { when });
  }
}

/** A key built from a code the API sends: its placeholders vary with the code. */
const tx = t as unknown as (key: string, vars?: Record<string, string | number>) => string;

/** «Rückgängig» of a change by hand: the booking back as saved, or gone when it was booked since. */
async function restoreSaved(id: string, nav: Nav) {
  try {
    await api.restoreSavedEntry(id);
    nav.refresh();
    await pollChanges();
  } catch (e) {
    nav.toast(errorText(e));
  }
}

function SyncLine({ view, nav }: { view: ChangesView; nav: Nav }) {
  const [busy, go] = useCommand(nav);
  const last = view.history[0] ? <span className="m">{t('changes.lastSaved', { when: sayWhen(view.history[0].at) })}</span> : null;
  if (!view.sync.remote) return <p className="chsync"><span className="wfpill muted">{t('changes.noRemote')}</span>{last}</p>;
  if (!view.sync.git) return <p className="chsync"><span className="wfpill muted">{t('changes.noGit')}</span>{last}</p>;
  return (
    <p className="chsync">
      {view.sync.ahead ? <span className="wfpill warn">{t('changes.notSynced', { n: view.sync.ahead })}</span> : <><span className="wfpill st-done">{t('changes.synced')}</span>{last}</>}
      {view.sync.ahead ? <button type="button" className="btn ghost" disabled={!!busy} onClick={() => void go({ kind: 'sync' })}>{t('changes.sync')}</button> : null}
    </p>
  );
}

function UndoButton({ oid, kind, nav }: { oid: string; kind: 'draft' | 'reverse'; nav: Nav }) {
  const [busy, go] = useCommand(nav);
  return (
    <p className="chundo">
      <button type="button" className="btn ghost" disabled={!!busy} onClick={() => void go({ kind: 'undo', oid }).then((r) => {
        if (!r?.ok) return;
        nav.toast(kind === 'draft' ? t('changes.undoneToast') : t('changes.reversedToast', { n: r.reversed ?? 0 }));
        if (kind === 'draft') nav.select({ area: 'changes' });
      })}>{t('changes.undo')}</button>
      <span className="m">{kind === 'draft' ? t('changes.undoDraft') : t('changes.undoReverse')}</span>
    </p>
  );
}

/**
 * Bereit zum Speichern (saving.md): without a proposal, the changed files and «Speichern
 * vorbereiten»; with one, the AI's saves, what moved since, the conversation and the save buttons.
 */
function SavePanel({ view, nav }: { view: ChangesView; nav: Nav }) {
  const [busy, go] = useCommand(nav);
  const [text, setText] = useState('');
  const aiOff = useAiOff();
  const p = view.proposal;
  const files = [...view.draft.map((f) => ({ ...f, source: 'draft' as const })), ...view.outside.map((f) => ({ ...f, source: 'outside' as const }))];
  const countOf = (source: string, path: string) => files.find((f) => f.source === source && f.path === path);
  const bookEntries = view.books.runs.reduce((n, r) => n + r.entries + r.links + r.receipts, 0);
  const thinking = busy === 'prepare' || busy === 'refresh' || busy === 'talk';
  if (!p) {
    const nothing = !view.books.files && !files.length;
    // A rule the AI drafted reads as a rule, kept with one click; every other file waits for «Speichern vorbereiten».
    const ruleDrafts = files.filter((f) => f.source === 'draft' && isRulesFile(f.path));
    const others = files.filter((f) => !ruleDrafts.includes(f));
    return (
      <div className="detail-in chpage">
        <div className="head"><h2 className="who">{t('changes.since')}</h2></div>
        {nothing ? <p className="lead">{view.history[0] ? t('changes.nothingSince', { when: sayWhen(view.history[0].at) }) : t('changes.empty')}</p> : (
          <>
            <p className="m chlead">{t('changes.sinceLead')}</p>
            {view.books.files ? (
              <>
                {view.books.runs.length || !view.books.hand.length ? <div className="group"><span>{t('changes.fromRuns')}</span></div> : null}
                <div className="chraw">
                  {view.books.runs.map((r) => (
                    <button key={r.run} type="button" className="chrawrow" onClick={() => nav.go({ route: { area: 'automation', view: 'run', run: r.run }, query: {} })}>
                      <span><span className="chwho">{FLOW}</span>{r.label} · {sayWhen(r.at)}</span>
                      <span className="m mono">{t('changes.entries', { n: r.entries + r.links + r.receipts })}</span>
                    </button>
                  ))}
                  {!view.books.runs.length && !view.books.hand.length ? <div className="chrawrow"><span><span className="chwho">{PERSON}</span>{t('changes.direct')}</span><span className="m mono">{t('changes.fileCount', { n: view.books.files })}</span></div> : null}
                </div>
                {view.books.hand.length ? (
                  <>
                    <div className="group"><span>{t(view.books.hand.some((h) => h.ai) ? 'changes.byHandAndAi' : 'changes.byHand')}</span></div>
                    <div className="chraw" data-testid="hand-edits">
                      {view.books.hand.map((h) => (
                        <div key={h.id} className="chrawrow" data-hand={h.id}>
                          <button type="button" className="golink" onClick={() => nav.go(h.deleted ? at({ area: 'bank', payment: h.ref }, h.date) : at({ area: 'journal', id: h.id }, h.date))}>
                            <span className="chwho">{h.ai ? <BotIcon /> : PERSON}</span>{h.text} · {h.deleted ? t('changes.handDeleted') : t(h.answer ? 'changes.answerBooked' : h.ai ? (h.saved ? 'changes.aiChanged' : 'changes.aiBooked') : h.saved ? 'changes.handChanged' : 'changes.handBooked', { when: sayWhen(h.at) })}
                          </button>
                          <button type="button" className="quiet2" data-tip={t(h.deleted ? 'changes.handRestoreTip' : h.answer ? 'changes.answerUndoTip' : h.saved ? 'changes.handUndoTip' : 'changes.handRemoveTip')} onClick={() => void restoreSaved(h.id, nav)}>{t('changes.handUndo')}</button>
                        </div>
                      ))}
                    </div>
                  </>
                ) : null}
                {view.books.records.length ? (
                  <>
                    <div className="group"><span>{t('changes.records')}</span></div>
                    <div className="chraw" data-testid="record-changes">
                      {view.books.records.map((c) => (
                        <div key={`${c.kind}:${'id' in c ? c.id : 'number' in c ? c.number : 'file' in c ? c.file : `${c.year}-${c.template}`}`} className="chrawrow" data-record={c.kind}>
                          <button type="button" className="golink" onClick={() => nav.go(recordRoute(c))}>
                            <span className="chwho">{PERSON}</span>{c.text} · {recordText(c)}
                          </button>
                          {'undo' in c
                            ? <button type="button" className="quiet2" data-tip={t(`changes.record.undoTip.${c.undo.kind}`)} onClick={() => void undoRecordChange(c, nav)}>{t('changes.handUndo')}</button>
                            : <span className="m">{t(`changes.record.blocked.${c.blocked}`)}</span>}
                        </div>
                      ))}
                    </div>
                  </>
                ) : null}
                {view.books.receipts.length ? (
                  <>
                    <div className="group"><span>{t('changes.receipts')}</span></div>
                    <div className="chraw" data-testid="receipt-changes">
                      {view.books.receipts.map((c) => (
                        <div key={`${c.kind}:${c.id}:${'payment' in c ? c.payment : ''}`} className="chrawrow" data-receipt={c.id}>
                          <button type="button" className="golink" onClick={() => nav.go(at(c.kind === 'deleted' ? { area: 'receipts' } : { area: 'receipts', id: c.id }, c.date))}>
                            <span className="chwho">{PERSON}</span>{c.text} · {receiptChangeText(c)}
                          </button>
                          {c.kind === 'privateOutlay' && c.blocked
                            ? <span className="m">{t('changes.outlayBlocked')}</span>
                            : <button type="button" className="quiet2" data-tip={receiptUndoTip(c)} onClick={() => void undoReceiptChange(c, nav)}>{t('changes.handUndo')}</button>}
                        </div>
                      ))}
                    </div>
                  </>
                ) : null}
              </>
            ) : null}
            {ruleDrafts.length ? (
              <>
                <div className="group"><span>{t('changes.ruleDrafts')}</span></div>
                {ruleDrafts.map((f) => <RuleDraft key={f.path} path={f.path} nav={nav} title={t('rules.draft.titleRule')} onRules={() => nav.go({ route: { area: 'company', section: 'rules' }, query: {} })} />)}
              </>
            ) : null}
            {others.length ? (
              <>
                <div className="group"><span>{t('changes.appFiles')}</span></div>
                <div className="chraw">
                  {others.map((f) => (
                    <button key={f.source + f.path} type="button" className="chrawrow" onClick={() => nav.select({ area: 'changes', commit: f.source, file: f.path })}>
                      <span><span className="chwho">{whoIcon(f.source)}</span><span className="mono">{f.path}</span>{f.effect && f.effect !== 'applies-now' ? <span className={`chkind e-${f.effect}`}>{t(`changes.effect.${f.effect}` as 'changes.effect.applies-now')}</span> : null}</span>
                      <span className="chcount"><span className="plus">+{f.added}</span> <span className="minus">−{f.removed}</span></span>
                    </button>
                  ))}
                </div>
              </>
            ) : null}
            <div className="chsave">
              {thinking ? <span className="wfpill st-running">{t('changes.preparing')}</span> : <button type="button" className="btn primary" disabled={!view.repository} onClick={() => void go({ kind: 'prepare' })}><BotIcon />{t('changes.prepare')}</button>}
              <span className="m">{t('changes.prepareTip')}</span>
            </div>
          </>
        )}
      </div>
    );
  }
  const stale = p.saves.filter((s) => p.stale.includes(s.id));
  const moved = [...stale.flatMap((s) => s.files.map((f) => f.path)), ...p.uncovered];
  const ready = p.saves.filter((s) => !s.held);
  const canSync = view.sync.remote && view.sync.git;
  const send = async () => { if (!text.trim()) return; if ((await go({ kind: 'talk', text }))?.ok) setText(''); };
  return (
    <div className="detail-in chpage">
      <div className="head"><h2 className="who"><BotIcon /> {t('changes.ready')}</h2></div>
      {moved.length ? (
        <div className="chbanner">
          <b>{t('changes.staleBanner', { files: moved.join(', ') })}</b>
          <span>{t('changes.staleLead')}</span>
          <button type="button" className="btn ghost" disabled={thinking} onClick={() => void go({ kind: 'refresh' })}><BotIcon />{t('changes.refresh')}</button>
        </div>
      ) : null}
      <p className="m" data-testid="ready-lead">{t(p.plain ? 'changes.readyPlain' : 'changes.readyLead', { n: p.saves.length })}</p>
      <div className="chpreps">
        {p.saves.map((s) => {
          const books = s.files.some((f) => f.source === 'books');
          const own = s.files.filter((f) => f.source !== 'books');
          const [a, d] = own.reduce(([a, d], f) => { const c = countOf(f.source, f.path); return [a + (c?.added ?? 0), d + (c?.removed ?? 0)]; }, [0, 0]);
          return (
            <div key={s.id} className={`chprep${s.held ? ' held' : ''}${p.stale.includes(s.id) ? ' stale' : ''}`}>
              <div className="pt"><span className={`chkind k-${books ? 'books' : 'customizing'}`}>{t(books ? 'changes.kind.books' : 'changes.kind.customizing')}</span><b>{s.message}</b>{s.held ? <span className="wfpill muted">{t('changes.held')}</span> : null}</div>
              {s.why ? <span className="m">{s.why}</span> : null}
              <div className="pf">
                {books ? <span className="chcount">{t('changes.entries', { n: bookEntries })}</span> : null}
                {own.length ? <span className="chcount">{t('changes.fileCount', { n: own.length })} · <span className="plus">+{a}</span> <span className="minus">−{d}</span></span> : null}
                {own.map((f) => <button key={f.path} type="button" className="linkbtn mono" onClick={() => nav.select({ area: 'changes', commit: f.source, file: f.path })}>{f.path.split('/').pop()}</button>)}
              </div>
            </div>
          );
        })}
      </div>
      <div className="chtalk">
        {p.talk.map((m, i) => <Fragment key={i}><div className="msg me">{m.me}</div><div className="msg ai"><BotIcon /><div>{m.ai}</div></div></Fragment>)}
      </div>
      <div className="chcomposer">
        <textarea rows={2} value={text} placeholder={t(aiOff ? 'changes.askOff' : 'changes.ask')} aria-label={t('changes.ask')} disabled={thinking || aiOff}
          onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }} />
        <button type="button" className="btn" disabled={thinking || aiOff || !text.trim()} onClick={() => void send()}><BotIcon />{t('changes.send')}</button>
      </div>
      <div className="chsave">
        {thinking ? <span className="wfpill st-running">{t('changes.preparing')}</span> : null}
        <button type="button" className={`btn${canSync ? '' : ' primary'}`} disabled={!!busy || !p.ready || !ready.length} onClick={() => void go({ kind: 'save' })}>{t('changes.save')}</button>
        {canSync ? <button type="button" className="btn primary" disabled={!!busy || !p.ready || !ready.length} onClick={() => void go({ kind: 'save', sync: true })}>{t('changes.saveSync')}</button> : null}
        {!p.ready ? <span className="m">{t('changes.firstRefresh')}</span> : p.saves.length > ready.length ? <span className="m">{t('changes.heldNote', { n: p.saves.length - ready.length })}</span> : null}
        <button type="button" className="linkbtn" disabled={!!busy} onClick={() => void go({ kind: 'discard' })}>{t('changes.discard')}</button>
      </div>
    </div>
  );
}

const legend = (): LegendItem[] => [
  [['↑', '↓'], t('keys.select'), t('keys.selectTip')],
  [['⌘', 'K'], t('keys.all'), t('keys.allTip')],
];

export const changes: Area<RouteOf<'changes'>> = {
  id: 'changes',
  label: () => t('area.changes'),
  dock: { key: 'v', icon: ICONS.changes, tip: () => t('area.changes.tip') },
  List,
  Detail,
  legend,
  periodless: true,
  title: (r) => r.file ?? r.commit?.slice(0, 7),
  keys(e, { route, nav }) {
    const d = moveKey(e);
    if (!d) return false;
    const rows = rowsOf(lastView());
    const i = rows.findIndex((r) => (r.commit ?? '') === (route.commit ?? ''));
    const next = rows[Math.min(rows.length - 1, Math.max(0, i + d))];
    if (next) nav.select(next);
    return true;
  },
};

