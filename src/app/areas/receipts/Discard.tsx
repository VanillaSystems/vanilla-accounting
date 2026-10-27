/**
 * «Löschen» of a file that is no receipt (#228): a quarantined file, or one listed as «keine
 * Belege». The confirmation names the file (or how many), says that it cannot be taken back here,
 * and, where the books' repository keeps a history, that the history still holds a file of the
 * books. The server refuses a file anything in the books refers to; the toast says what does.
 */
import { api, errorText } from '../../lib/api.js';
import { useWorkspace } from '../../hooks/use-workspace.js';
import { t } from '../../i18n/index.js';
import type { Nav } from '../index.js';
import { setUi, useUi, type Discard } from './state.js';

/** Opens the confirmation for `d`. */
export const askDiscard = (d: Discard) => setUi({ overlay: 'discard', discard: d });

/** The confirmation of the open «Löschen» from `from`; `done` runs once the files are gone. */
export function ConfirmDiscard({ from, nav, done }: { from: Discard['from']; nav: Nav; done?: () => void }) {
  const s = useUi();
  const versioned = !!useWorkspace()?.versioned;
  const d = s.discard;
  if (s.overlay !== 'discard' || d?.from !== from) return null;
  const n = d.files.length;
  const close = () => setUi({ overlay: null, discard: undefined });
  const title = d.all ? t('receipts.discardAllTitle', { n }) : n === 1 ? t('receipts.discardTitle', { file: d.files[0].file }) : t('receipts.discardSomeTitle', { n });
  const text = from === 'quarantine' ? t('receipts.discardQuarantineText', { n })
    : `${t('receipts.discardHiddenText', { n })}${versioned ? ` ${t('receipts.discardHistory', { n })}` : ''}`;
  async function run() {
    close();
    try {
      if (from === 'quarantine') await api.deleteFromQuarantine(d!.files.map((f) => f.file));
      else await api.discardReceipts(d!.files.map((f) => f.id));
    } catch (e) { nav.toast(errorText(e)); return; }
    done?.();
    nav.refresh();
    nav.toast(n === 1 ? t('receipts.discarded', { file: d!.files[0].file }) : t('receipts.discardedSome', { n }));
  }
  return (
    <>
      <div className="scrim" onClick={close} />
      <div className="palette confirm discard" role="alertdialog" aria-label={title} data-testid="discard-confirm">
        <h2>{title}</h2>
        <p>{text}</p>
        {n === 1 ? <div className="file">{d.files[0].file}</div> : (
          <ul className="files">{d.files.map((f) => <li key={f.id}>{f.file}</li>)}</ul>
        )}
        <div className="acts">
          <button type="button" className="btn ghost" onClick={close}>{t('common.cancel')} <span className="k">{t('receipts.escKey')}</span></button>
          <button type="button" className="btn danger" autoFocus onClick={() => void run()}>{t('common.delete')} <span className="k">↵</span></button>
        </div>
      </div>
    </>
  );
}
