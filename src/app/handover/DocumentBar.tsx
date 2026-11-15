/**
 * The copy's Freigabe-Datei in the Durchsicht bar (src/handover/document.ts, «the share file is the
 * document»): its name, «ungespeichert» while his changes are not all in it, «Sichern» (⌘S) and
 * «Sichern unter…». Once she saved into the file herself, the app saves by itself when she has
 * been idle a while (and the Mac app when its window closes). A file that went or cannot be written
 * is said, with «Sichern unter…».
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { t } from '../i18n/index.js';
import { errorText, request } from '../lib/api.js';
import { desktop } from '../desktop/bridge.js';
import { postDownload } from '../areas/export/state.js';
import { AsyncButton } from '../shell/AsyncButton.js';
import type { DocumentState } from '../../handover/document.js';

/** How often the bar asks whether his changes are all in the file, and how long he must be idle before the app saves by itself. */
const LOOK_MS = 15_000;
const IDLE_MS = 20_000;

let current: DocumentState | null = null;
const listeners = new Set<(d: DocumentState | null) => void>();
const tell = (d: DocumentState | null) => { current = d; for (const l of listeners) l(d); };

/** Asks the server about the copy's file now (after an edit, a save, on focus). */
export const lookAtDocument = (): Promise<DocumentState | null> =>
  request<{ document: DocumentState | null }>('GET', '/api/handover/document').then((r) => { tell(r.document); return r.document; }, () => current);

/** The copy's file as the bar last saw it: the window's title names it (src/app/shell/Shell.tsx). */
export function useDocument(): DocumentState | null {
  const [d, setD] = useState(current);
  useEffect(() => { listeners.add(setD); return () => { listeners.delete(setD); }; }, []);
  return d;
}

export function DocumentBar() {
  const doc = useDocument();
  const [error, setError] = useState('');
  const idleSince = useRef(Date.now());

  const save = useCallback(async (opts: { auto?: boolean; to?: string } = {}) => {
    try {
      const r = await request<{ document: DocumentState }>('POST', '/api/handover/document/save', opts);
      tell(r.document);
      setError('');
    } catch (e) {
      if (!opts.auto) setError(errorText(e));
      void lookAtDocument();
    }
  }, []);

  const saveAs = useCallback(async () => {
    const name = current?.name ?? 'Buchhaltung.vanillashare';
    if (desktop) {
      const to = await desktop.chooseSavePath(name);
      if (to) await save({ to });
      return;
    }
    // In the browser: the file as it would be saved, downloaded.
    try { await postDownload('/api/handover/document/file', {}, name); } catch (e) { setError(errorText(e)); }
  }, [save]);

  useEffect(() => {
    void lookAtDocument();
    const mark = () => { idleSince.current = Date.now(); };
    const key = (e: KeyboardEvent) => {
      mark();
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (e.shiftKey) void saveAs(); else void save();
      }
    };
    const timer = setInterval(() => {
      void lookAtDocument().then((d) => {
        if (d?.auto && d.dirty && !d.missing && !d.other && Date.now() - idleSince.current > IDLE_MS) void save({ auto: true });
      });
    }, LOOK_MS);
    const focus = () => void lookAtDocument();
    window.addEventListener('keydown', key);
    window.addEventListener('pointerdown', mark);
    window.addEventListener('focus', focus);
    return () => { clearInterval(timer); window.removeEventListener('keydown', key); window.removeEventListener('pointerdown', mark); window.removeEventListener('focus', focus); };
  }, [save, saveAs]);

  if (!doc) return null;
  return (
    <span className="shdoc" data-testid="document-bar">
      <span className="name" data-tip={doc.path}>{doc.name}</span>
      {doc.missing ? <span className="warn">{t('durchsicht.doc.missing')}</span>
        : doc.other ? <span className="warn" data-testid="document-other" data-tip={t('durchsicht.doc.otherWhy', { file: doc.name })}>{t('durchsicht.doc.other')}</span>
        : doc.dirty ? <span className="warn" data-testid="document-unsaved">{t('durchsicht.doc.unsaved')}</span> : <span className="m">{t('durchsicht.doc.saved')}</span>}
      {doc.dirty && !doc.missing && !doc.other ? <AsyncButton type="button" className="linkbtn" onClick={() => save()} data-testid="document-save">{t('durchsicht.doc.save')}</AsyncButton> : null}
      <AsyncButton type="button" className="linkbtn" onClick={() => saveAs()} data-testid="document-save-as">{t('durchsicht.doc.saveAs')}</AsyncButton>
      {error ? <span className="err" role="alert">{error}</span> : doc.other ? <span className="err" role="alert">{t('durchsicht.doc.otherWhy', { file: doc.name })}</span> : null}
    </span>
  );
}
