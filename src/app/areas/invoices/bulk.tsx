/**
 * The bulk bar's dialogs (docs/specs/invoicing.md 4.8): «Senden» sends each ticked issued document by
 * e-mail through the send route, one after the other; «PDF» saves the ticked documents' PDFs. Each
 * names what it leaves out and why, and the limit per run when it is hit.
 */
import { invoicingOnDay } from '../../../invoices/dated-values.js';
import { useEffect, useState } from 'react';
import type { Invoice, Issued } from '../../../invoices/model.js';
import { mailText } from '../../../invoices/documents.js';
import { wasSent } from '../../../invoices/lists.js';
import type { MailStatus } from '../../../types/api-error.js';
import { api, errorText, sources, type InvoiceList } from '../../lib/api.js';
import { useWorkspace } from '../../hooks/use-workspace.js';
import { t } from '../../i18n/index.js';
import type { Nav } from '../index.js';
import { AsyncButton } from '../../shell/AsyncButton.js';
import { download } from './actions.js';
import { reloadInvoices } from './data.js';
import { routeId } from './model.js';
import { setUi } from './state.js';
import { Frame, close } from './frame.js';
import { PDF_LIMIT, SEND_LIMIT, bulkPdfPlan, bulkSendPlan, type LeftOut } from './bulk-plan.js';

const name = (inv: Invoice) => (inv.status === 'issued' ? inv.number : t('invoices.draft'));

function LeftOutList({ left, limit }: { left: Array<{ inv: Invoice; why: LeftOut }>; limit: number }) {
  if (!left.length) return null;
  const by = (why: LeftOut) => left.filter((x) => x.why === why);
  return (
    <div className="notice warn ivleft" role="note" data-testid="left-out">
      <span>
        {(['noEmail', 'draft', 'cancelled', 'limit'] as const).filter((w) => by(w).length).map((w) => (
          <span key={w} className="l">{t(`sales.bulk.left.${w}`, { n: by(w).length, list: by(w).map((x) => (w === 'noEmail' && x.inv.status === 'issued' ? `${name(x.inv)} (${x.inv.customer.name})` : name(x.inv))).join(', '), limit })}</span>
        ))}
      </span>
    </div>
  );
}

export function BulkDialogs({ d, nav, ids, kind }: { d: InvoiceList; nav: Nav; ids: string[]; kind: 'bulk-send' | 'bulk-pdf' }) {
  const docs = ids.flatMap((id) => d.invoices.filter((i) => i.id === id));
  return kind === 'bulk-send' ? <BulkSend d={d} nav={nav} docs={docs} /> : <BulkPdf docs={docs} />;
}

function BulkSend({ d, nav, docs }: { d: InvoiceList; nav: Nav; docs: Invoice[] }) {
  const ws = useWorkspace();
  const [status, setStatus] = useState<MailStatus>();
  const [done, setDone] = useState<{ sent: string[]; failed: Array<{ number: string; why: string }> } | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  useEffect(() => { api.mailStatus().then(setStatus, () => setStatus(undefined)); }, []);
  const ready = !!status?.configured && status.password !== 'missing';
  const { take, left } = bulkSendPlan(docs);
  const again = take.filter((inv) => wasSent(d.sent, inv)).length;

  async function run() {
    const sent: string[] = [];
    const failed: Array<{ number: string; why: string }> = [];
    for (const [i, inv] of take.entries()) {
      setBusy(i + 1);
      const text = mailText(invoicingOnDay(ws?.invoicing, inv.date), inv, { kind: 'invoice' }, ws?.company.name ?? '');
      try {
        await api.recordSend(inv.id, { email: { to: inv.customer.email!, ...text } });
        sent.push(inv.number);
      } catch (e) {
        failed.push({ number: inv.number, why: errorText(e) });
      }
    }
    setBusy(null);
    setDone({ sent, failed });
    setUi({ ticked: new Set() });
    await reloadInvoices();
    if (sent.length) nav.toast(t('sales.bulk.mailed', { n: sent.length }));
  }

  const label = t('sales.bulk.sendTitle');
  if (done) {
    return (
      <Frame label={label} title={t('sales.bulk.mailed', { n: done.sent.length })} foot={<button type="button" className="btn primary" onClick={close}>{t('common.close')}</button>}>
        <div className="ibody" data-testid="bulk-done">
          {done.sent.length > 0 && <p>{done.sent.join(', ')}</p>}
          {done.failed.map((f) => <p key={f.number} className="notice warn">{f.number}: {f.why}</p>)}
        </div>
      </Frame>
    );
  }
  return (
    <Frame label={label} title={t('sales.bulk.sendCount', { n: take.length })}
      foot={<>
        <button type="button" className="btn ghost" onClick={close}>{t('common.cancel')}</button>
        <AsyncButton type="button" className="btn primary" data-act="bulk-send-ok" disabled={!ready || !take.length || busy !== null} onClick={run}>
          {busy !== null ? t('sales.bulk.sending', { i: busy, n: take.length }) : t('sales.bulk.sendOk', { n: take.length })}
        </AsyncButton>
      </>}>
      <div className="ibody">
        {status && !ready && (
          <p className="m ivhint">{status.configured ? t('mail.passwordMissing', { where: status.where }) : t('sales.bulk.mailNotSetUp')}{' '}
            <button type="button" className="quiet2" onClick={() => { close(); nav.go({ route: { area: 'company', section: 'mail' }, query: {} }); }}>{t('invoices.toMail')}</button>
          </p>
        )}
        {take.length > 0 && <div className="ivtake" data-testid="bulk-take">{take.map((inv) => <div key={inv.id}><span className="mono">{inv.number}</span> → {inv.customer.email}</div>)}</div>}
        {again > 0 && <p className="m">{t('sales.bulk.again', { n: again })}</p>}
        <LeftOutList left={left} limit={SEND_LIMIT} />
        <p className="m ivhint">{t('sales.bulk.sendHint')}</p>
      </div>
    </Frame>
  );
}

function BulkPdf({ docs }: { docs: Invoice[] }) {
  const { take, left } = bulkPdfPlan(docs);
  const run = async () => {
    for (const inv of take) {
      download(sources.invoicePdf(inv.number), `${routeId(inv)}.pdf`);
      // A browser takes several downloads from one click only with a pause between them.
      await new Promise((r) => setTimeout(r, 350));
    }
    close();
  };
  return (
    <Frame label={t('sales.bulk.pdfTitle')} title={t('sales.bulk.pdfCount', { n: take.length })}
      foot={<><button type="button" className="btn ghost" onClick={close}>{t('common.cancel')}</button><AsyncButton type="button" className="btn primary" data-act="bulk-pdf-ok" disabled={!take.length} onClick={run}>{t('sales.bulk.pdfOk', { n: take.length })}</AsyncButton></>}>
      <div className="ibody">
        {take.length > 0 && <p>{take.map((inv) => inv.number).join(', ')}</p>}
        <LeftOutList left={left} limit={PDF_LIMIT} />
        <p className="m ivhint">{t('sales.bulk.pdfHint')}</p>
      </div>
    </Frame>
  );
}
