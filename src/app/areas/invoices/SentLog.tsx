/**
 * Versendet (docs/specs/invoicing.md 4.4.12): the sent log as a table, newest first: date and time,
 * document, kind, contact, recipient, channel, checksum; filtered by contact, kind and channel. The
 * document links to its page; a row opens the PDF exactly as it went out.
 */
import { SENT_KINDS } from '../../../invoices/model.js';
import { channelOf } from '../../../invoices/lists.js';
import type { RouteOf } from '../../shell/route.js';
import { ListHead } from '../../shell/ListHead.js';
import { hrefOf } from '../../shell/history.js';
import type { InvoiceList } from '../../lib/api.js';
import { formatDate } from '../../lib/utils.js';
import { t } from '../../i18n/index.js';
import type { AreaProps } from '../index.js';
import { customerOf, sentRows } from './model.js';
import { invoiceAt } from './actions.js';
import { listed, setUi, useUi } from './state.js';
import { channelText, recipientOf, rowTab, timeOf } from './Sent.js';
import { Search, Views } from './views.js';

type Props = AreaProps<RouteOf<'invoices'>>;

export function SentLog(props: Props & { d: InvoiceList }) {
  const { route, query, nav, d } = props;
  const s = useUi();
  const f = s.sentFilter;
  const rows = sentRows(d, query.q, f);
  listed.ids = rows.map((x) => x.id);
  const contacts = [...new Map(d.sent.flatMap((x) => { const inv = d.invoices.find((i) => i.id === x.invoiceId); return inv ? [[inv.customerId, customerOf(d, inv)?.name ?? ''] as const] : []; })).entries()].sort((a, b) => a[1].localeCompare(b[1]));
  const set = (patch: Partial<typeof f>) => setUi({ sentFilter: { ...f, ...patch } });

  return (
    <div className="page ivtable" data-view="sent">
      <ListHead {...props} noPeriod>
        <div className="counts">
          <Views on="sent" props={props} />
          <Search props={props} />
        </div>
      </ListHead>
      <div className="ivfacts ivfilters">
        <span>{t('invoices.nSent', { n: rows.length })}</span>
        <label>{t('sales.col.contact')}
          <select value={f.customer ?? ''} data-filter="customer" onChange={(e) => set({ customer: e.target.value || undefined })}>
            <option value="">{t('sales.filterAll')}</option>
            {contacts.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
        </label>
        <label>{t('sales.col.kind')}
          <select value={f.kind ?? ''} data-filter="kind" onChange={(e) => set({ kind: e.target.value || undefined })}>
            <option value="">{t('sales.filterAll')}</option>
            {SENT_KINDS.map((k) => <option key={k} value={k}>{t(`invoices.docKind.${k}`)}</option>)}
          </select>
        </label>
        <label>{t('sales.col.channel')}
          <select value={f.channel ?? ''} data-filter="channel" onChange={(e) => set({ channel: e.target.value || undefined })}>
            <option value="">{t('sales.filterAll')}</option>
            <option value="email">{t('sales.channel.email')}</option>
            <option value="download">{t('sales.channel.download')}</option>
          </select>
        </label>
      </div>
      {rows.length === 0 ? <div className="empty"><h2>{t('invoices.nothingSent')}</h2><p>{t('invoices.nothingSentText')}</p></div> : (
        <div className="ivscroll">
          <table className="ivt" aria-label={t('invoices.view.sent')}>
            <thead>
              <tr>
                <th>{t('sales.col.sentAt')}</th><th>{t('sales.col.document')}</th><th>{t('sales.col.kind')}</th><th>{t('sales.col.contact')}</th>
                <th>{t('sales.col.recipient')}</th><th>{t('sales.col.channel')}</th><th>{t('sales.col.checksum')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((doc, i) => {
                const sel = doc.id === route.id;
                const inv = d.invoices.find((i) => i.id === doc.invoiceId);
                return (
                  <tr key={doc.id} className={`trow${sel ? ' sel' : ''}`} data-id={doc.id} data-channel={channelOf(doc)} aria-selected={sel} tabIndex={rowTab(sel, i, rows.some((x) => x.id === route.id))}
                    onClick={() => nav.select({ area: 'invoices', view: 'sent', id: doc.id })} onKeyDown={(e) => { if (e.key === 'Enter' && e.target === e.currentTarget) nav.select({ area: 'invoices', view: 'sent', id: doc.id }); }}>
                    <td className="mono">{formatDate(doc.sentAt.slice(0, 10))} {timeOf(doc.sentAt)}</td>
                    <td>{inv ? <a className="golink" href={hrefOf(invoiceAt(inv))} data-act="to-document" onClick={(e) => { e.stopPropagation(); if (e.metaKey || e.ctrlKey) return; e.preventDefault(); nav.go(invoiceAt(inv)); }}>{doc.title}</a> : doc.title}</td>
                    <td>{t(`invoices.docKind.${doc.kind}`)}</td>
                    <td>{inv ? customerOf(d, inv)?.name : ''}</td>
                    <td className="tt">{recipientOf(doc)}</td>
                    <td>{channelText(doc)}</td>
                    <td className="mono" data-tip={t('sales.shaFull', { sha: doc.sha256 })}>{doc.sha256.slice(0, 12)}…</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
