/**
 * The sent state at a glance (docs/specs/invoicing.md 4.8), everywhere from the sent log, never set
 * by hand: the words for a channel and a send, the «Versand» cell of a table with every send on
 * hover, the fact line above a document's sheet, and the margin's section «Versand».
 */
import type { ReactNode } from 'react';
import type { Invoice, SentDocument } from '../../../invoices/model.js';
import { channelOf, sentFacts, type SentFacts } from '../../../invoices/lists.js';
import { sources } from '../../lib/api.js';
import { formatDate } from '../../lib/utils.js';
import { t } from '../../i18n/index.js';
import { I } from '../receipts/icons.js';
import { hrefOf } from '../../shell/history.js';
import type { Location } from '../../shell/route.js';
import type { Nav } from '../index.js';

/** A sent document's page: its PDF exactly as it went out. */
export const sentAt = (doc: Pick<SentDocument, 'id'>): Location => ({ route: { area: 'invoices', view: 'sent', id: doc.id }, query: {} });

/** Roving focus over a table's rows: the selected row takes Tab, or the first one while none is selected. */
export const rowTab = (sel: boolean, index: number, anySelected: boolean): 0 | -1 => (sel || (!anySelected && index === 0) ? 0 : -1);

export const timeOf = (iso: string): string => new Date(iso).toTimeString().slice(0, 5);
export const channelText = (doc: SentDocument): string => t(`sales.channel.${channelOf(doc)}`);
/** Who it went to: the address of an e-mail; a download went to whoever the person handed it to. */
export const recipientOf = (doc: SentDocument): string => (channelOf(doc) === 'email' ? doc.to : t('sales.byDownload'));

/** One send in a line: «12.11.2026 09:14 · Rechnung 2026-003 · E-Mail an x@y». */
const sendLine = (doc: SentDocument): string =>
  [`${formatDate(doc.sentAt.slice(0, 10))} ${timeOf(doc.sentAt)}`, doc.title, channelOf(doc) === 'email' ? t('sales.mailTo', { to: doc.to }) : t('sales.channel.download')].join(' · ');

/** «18.11.» of a date: the day of a Mahnung beside the last send. */
const dayMonth = (iso: string) => formatDate(iso).slice(0, 6);

/** The «Versand» cell: the last send's date and channel, the last Mahnung sent; on hover every send with time and recipient. */
export function SentCell({ facts }: { facts: SentFacts }) {
  if (!facts.last && !facts.reminder) return <span className="m" data-testid="sent-cell">–</span>;
  const tip = facts.all.map(sendLine).join('\n');
  return (
    <span className="ivsentc" data-testid="sent-cell" data-tip={tip}>
      {facts.last ? <span>{formatDate(facts.last.sentAt.slice(0, 10))} · {channelText(facts.last)}</span> : <span className="m">{t('sales.notSentShort')}</span>}
      {facts.reminder && <small>{t('sales.lastReminder', { title: facts.reminder.title, date: dayMonth(facts.reminder.date) })}</small>}
    </span>
  );
}

/**
 * Above the sheet: «gesendet am … an …» or «noch nicht gesendet» with «Senden». Its own component so the
 * figures of a Rechnung (Betrag · erhalten · gutgeschrieben · offen) can stand beside it.
 */
export function SentLine({ sent, inv, onSend }: { sent: readonly SentDocument[]; inv: Invoice; onSend?: () => void }) {
  if (inv.status !== 'issued') return null;
  const f = sentFacts(sent, inv);
  const last = f.last;
  // A cancelled document never sent is no task: nothing to say above its sheet.
  if (!last && inv.cancelled) return null;
  return (
    <div className={`ivfact${last ? '' : ' unsent'}`} data-testid="sent-line">
      {last ? I.check : I.dot}
      <span>
        {last
          ? channelOf(last) === 'email'
            ? t('sales.sentLineMail', { date: formatDate(last.sentAt.slice(0, 10)), time: timeOf(last.sentAt), to: last.to })
            : t('sales.sentLineDownload', { date: formatDate(last.sentAt.slice(0, 10)), time: timeOf(last.sentAt) })
          : t('sales.notSentYet')}
      </span>
      {!last && onSend && !inv.cancelled && <button type="button" className="btn ghost" data-act="send-line" onClick={onSend}>{t('invoices.send')}</button>}
    </div>
  );
}

/** The margin's «Versand»: every send of the document and of its reminders and notices, each PDF as it went out. */
export function SentList({ sent, inv, nav }: { sent: readonly SentDocument[]; inv: Invoice; nav: Nav }): ReactNode {
  const docs = sentFacts(sent, inv).all.slice().reverse();
  if (!docs.length) return <p className="m">{t('invoices.nothingSentYet')}</p>;
  return (
    <div className="ivsends" data-testid="sent-list">
      {docs.map((x) => (
        <div key={x.id} className="ivsend" data-testid="sent-entry">
          <div className="h">
            <span className="mono">{formatDate(x.sentAt.slice(0, 10))} {timeOf(x.sentAt)}</span>
            <b>{x.title}</b>
          </div>
          <dl className="kv">
            <dt>{t('sales.col.channel')}</dt><dd>{channelText(x)}</dd>
            <dt>{t('sales.col.recipient')}</dt><dd>{recipientOf(x)}</dd>
            {x.messageId ? <><dt>{t('sales.messageId')}</dt><dd className="mono wrap">{x.messageId}</dd></> : null}
            <dt>{t('sales.col.checksum')}</dt><dd className="mono" data-tip={t('sales.shaFull', { sha: x.sha256 })}>{x.sha256.slice(0, 12)}…</dd>
          </dl>
          <span className="lkfoot">
            <a className="quiet2" href={hrefOf(sentAt(x))} data-act="sent-pdf" onClick={(e) => { if (e.metaKey || e.ctrlKey) return; e.preventDefault(); nav.go(sentAt(x)); }}>{t('sales.openAsSent')}</a>
            <a className="quiet2" href={sources.sentPdf(x.id)} download={`${x.title}.pdf`}>{t('invoices.download')}</a>
          </span>
        </div>
      ))}
    </div>
  );
}
