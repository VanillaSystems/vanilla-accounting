/**
 * One statement file read in, whole (Kontoauszüge › Dateien, #208): what it says about itself, as
 * the drop dialog shows a file that asks for its account, and every movement it holds, each a link
 * to its payment. The books give its days, movements and balances; the file's own words (the bank,
 * its BIC, the owner, the balances as stated) and the day it was read in come from the API, and a
 * snapshot without one shows what the books know.
 */
import { useEffect, useState } from 'react';
import type { StatementDetails } from '../../../types/drop.js';
import { api } from '../../lib/api.js';
import { fmt, formatDate } from '../../lib/utils.js';
import { hrefOf } from '../../shell/history.js';
import { t } from '../../i18n/index.js';
import { FileDetails } from '../../shell/FileDetails.js';
import { at } from '../receipts/view.js';
import type { Nav } from '../index.js';
import { fileFacts, payText, signed, type StatementFile } from './model.js';

export function FileDetail({ f, nav }: { f: StatementFile; nav: Nav }) {
  const [own, setOwn] = useState<{ details?: StatementDetails; importedAt?: string }>();
  useEffect(() => {
    let live = true;
    api.statementFileDetails(`${f.file.bank}/${f.file.filename}`).then((r) => { if (live) setOwn(r); }, () => { if (live) setOwn({}); });
    return () => { live = false; };
  }, [f.key]);
  const books = fileFacts(f);
  // The file's own words where it has them; the movements always as the books hold them.
  const d: StatementDetails = own?.details ? { ...own.details, movements: books.movements, booked: books.booked ?? own.details.booked } : books;
  return (
    <div className="detail-in" data-for={f.key} data-testid="bank-file">
      <div className="head">
        <h2 className="who">{f.file.filename}<small>{f.account.label} · {formatDate(f.file.fromDate)} – {formatDate(f.file.toDate)}</small></h2>
        {f.closing ? <div className="amount"><small>{d.currency}</small>{fmt(f.closing.amount)}</div> : null}
      </div>
      <FileDetails d={d} name={`${f.file.bank}/${f.file.filename}`} {...(own?.importedAt ? { importedAt: own.importedAt } : {})}>
        <dt>{t('bank.fileMoves')}</dt>
        <dd className="dmoves" data-testid="bank-file-moves">
          {f.payments.length ? f.payments.map((p) => {
            const loc = at({ area: 'bank', payment: p.ref }, p.date);
            return (
              <a key={p.ref} className="dmove" href={hrefOf(loc)} onClick={(e) => { e.preventDefault(); nav.go(loc); }}>
                <span className="mono">{formatDate(p.date)}</span>
                <span className={`mono ${signed(p) < 0 ? 'neg' : ''}`}>{fmt(signed(p))}</span>
                <span>{[payText(p).name, payText(p).note].filter(Boolean).join(' · ') || '–'}</span>
              </a>
            );
          }) : <span className="m">{t('bank.fileNone')}</span>}
        </dd>
      </FileDetails>
    </div>
  );
}
