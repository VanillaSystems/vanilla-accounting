/**
 * Belege › «Aussortiert» (data/quarantine/, src/server/routes/quarantine.ts): what came in and does
 * not enter the books, grouped by why (aside-groups.ts): a group of a sender's files a mailbox keeps
 * aside, duplicates of receipts, newsletters, terms … Each group and each file says why, and what a
 * mailbox set aside the day it is deleted by itself. «Doch behalten» takes a file, or a whole group,
 * back into the inbox, whose run reads it; for a group kept aside it also switches the group off.
 * «Löschen» deletes for good once confirmed.
 */
import { useEffect, useState } from 'react';
import type { QuarantinedFile, QuarantineReason } from '../../../types/drop.js';
import { api, errorText } from '../../lib/api.js';
import { formatDate } from '../../lib/utils.js';
import { shapeText } from '../../lib/name-shape.js';
import { t } from '../../i18n/index.js';
import type { AreaProps } from '../index.js';
import { ConfirmDiscard, askDiscard } from './Discard.js';
import { asideGroups } from './aside-groups.js';

/** What a group is, in words: its header. */
function groupTitle(r: QuarantineReason): string {
  if (r.kind === 'held') return t('receipts.quarantineHeld');
  if (r.kind === 'unreadable') return t('receipts.quarantineUnreadable');
  if (r.kind === 'duplicate') return t('receipts.asideDuplicates');
  if (r.why === 'group') return t('receipts.asideGroup', { shape: shapeText(r.shape ?? '#'), from: r.from ?? '' });
  return t(`receipts.why.${r.why ?? 'no-receipt'}`);
}

/** What a file's line adds to its group's words: its sender, the receipt it repeats. */
function fileWhy(q: QuarantinedFile): string {
  const r = q.reason;
  return [
    r.kind === 'duplicate' && r.ofFile ? t('receipts.asideDuplicateOf', { file: r.ofFile }) : '',
    (r.kind === 'not-receipt' && r.why !== 'group') || r.kind === 'duplicate' ? (r.from ? t('receipts.quarantineFrom', { from: r.from }) : '') : '',
    formatDate(q.at.slice(0, 10)),
    q.deleteOn ? t('receipts.asideDeleteOn', { date: formatDate(q.deleteOn) }) : '',
  ].filter(Boolean).join(' · ');
}

export function Quarantine({ nav, canEdit, asked }: { nav: AreaProps['nav']; canEdit: boolean; asked: boolean }) {
  const [files, setFiles] = useState<QuarantinedFile[] | undefined>();
  const [shown, setOpen] = useState(false);
  const load = () => { api.quarantine().then(setFiles, () => setFiles([])); };
  useEffect(load, []);
  // The state chip opens the list, and says when it is empty (#211).
  const open = shown || asked;
  if (!files?.length) return asked && files ? <div className="empty"><h2>{t('chips.quarantineEmpty')}</h2></div> : null;
  async function take(names: string[]) {
    try {
      if (names.length === 1) await api.takeFromQuarantine(names[0]);
      else await api.takeAllFromQuarantine(names);
      nav.toast(names.length === 1 ? t('receipts.quarantineTaken', { file: names[0] }) : t('receipts.asideTakenAll', { n: names.length }));
      load();
      nav.refresh();
    } catch (e) { nav.toast(errorText(e)); }
  }
  return (
    <div className="quarantine" data-testid="quarantine">
      <div className="hidden-note">
        {t('receipts.quarantineNote', { n: files.length })} · <button type="button" onClick={() => setOpen(!shown)}>{open ? t('receipts.hideAgain') : t('receipts.show')}</button>
      </div>
      {open && (
        <>
          <p className="m qlead">{t('receipts.quarantineLead')}</p>
          {asideGroups(files).map((g) => (
            <section key={g.key} className="qgroup" data-testid="aside-group" data-group={g.key}>
              <div className="qghead">
                <b>{groupTitle(g.reason)}</b> <span className="m">{t('receipts.asideCount', { n: g.files.length })}</span>
                {canEdit && g.files.length > 1 && (
                  <button type="button" className="linkbtn" data-testid="aside-keep-group" onClick={() => void take(g.files.map((q) => q.file))}>{t('receipts.asideKeepAll', { n: g.files.length })}</button>
                )}
              </div>
              <ul className="qlist">
                {g.files.map((q) => (
                  <li key={q.file} data-file={q.file}>
                    <span className="mono qfile">{q.file}</span>
                    <span className="m">{fileWhy(q)}</span>
                    <span className="qacts">
                      <a href={`/api/quarantine/${encodeURIComponent(q.file)}`} target="_blank" rel="noreferrer">{t('receipts.quarantineOpen')}</a>
                      {canEdit && <button type="button" className="linkbtn" onClick={() => void take([q.file])}>{t('receipts.quarantineTake')}</button>}
                      {canEdit && <button type="button" className="linkbtn danger" data-testid="quarantine-delete" onClick={() => askDiscard({ from: 'quarantine', files: [{ id: q.file, file: q.file }] })}>{t('receipts.discard')}</button>}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
          {canEdit && files.length > 1 && (
            <button type="button" className="linkbtn danger qall" data-testid="quarantine-delete-all" onClick={() => askDiscard({ from: 'quarantine', all: true, files: files.map((q) => ({ id: q.file, file: q.file })) })}>
              {t('receipts.discardAll', { n: files.length })}
            </button>
          )}
        </>
      )}
      <ConfirmDiscard from="quarantine" nav={nav} done={load} />
    </div>
  );
}
