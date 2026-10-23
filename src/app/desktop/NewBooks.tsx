/**
 * «Neue Buchhaltung anlegen» (#139): only the folder and the books' language; «Weiter» starts the
 * setup conversation in that folder (src/onboarding/draft.ts), or continues the one broken off
 * there. A folder that already holds books opens them. «Ohne KI einrichten» leads to the form.
 */
import { useState } from 'react';
import type { DesktopInfo } from '../../types/desktop.js';
import { LOCALES, t } from '../i18n/index.js';
import { api, errorText } from '../lib/api.js';
import { desktop } from './bridge.js';

export function NewBooks({ info, language, onCancel, onSetup, onForm }: {
  info: DesktopInfo | null; language: string; onCancel(): void; onSetup(root: string): void; onForm(): void;
}) {
  const [root, setRoot] = useState('');
  const [lang, setLang] = useState(language);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const folder = root || (info ? `${info.booksHome}/${t('desktop.flow.folderName', { year: new Date().getFullYear() }).replace(/[/:]/g, '-')}` : '');

  const choose = async () => {
    const dir = await desktop?.chooseFolder(t('desktop.chooseNew'));
    if (dir) setRoot(dir);
  };
  const next = async () => {
    setBusy(true);
    setError('');
    try {
      const begun = await api.desktop.setupBegin(folder, lang);
      if (begun.kind === 'books') location.assign('/');
      else onSetup(begun.view.root);
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  return (
    <div className="st-main st-create">
      <h1>{t('desktop.new')}</h1>
      <p className="st-sub">{t('desktop.flow.intro')}</p>
      <form className="st-form" noValidate onSubmit={(e) => { e.preventDefault(); void next(); }}>
        <section className="st-grid">
          <label className="cf s4"><span>{t('desktop.folder')}</span>
            <span className="st-row">
              <input name="root" className="mono" value={folder} onChange={(e) => setRoot(e.target.value)} autoFocus />
              {desktop && <button type="button" className="btn ghost" onClick={() => void choose()}>{t('desktop.chooseButton')}</button>}
            </span>
          </label>
          <div className="cf s4"><span>{t('desktop.flow.language')}</span>
            <span className="seg2" role="radiogroup" aria-label={t('desktop.flow.language')}>
              {LOCALES.map((l) => (
                <button key={l.code} type="button" role="radio" aria-checked={lang === l.code} className={lang === l.code ? 'on' : ''} title={l.name} onClick={() => setLang(l.code)}>{l.code.toUpperCase()}</button>
              ))}
            </span>
          </div>
        </section>
        {error && <p className="warnline" role="alert">{error}</p>}
        <div className="st-foot">
          <button type="button" className="linkbtn st-byhand" data-act="by-hand" onClick={onForm}>{t('desktop.flow.byHand')}</button>
          <button type="button" className="btn ghost" onClick={onCancel}>{t('common.cancel')}</button>
          <button type="submit" className="btn primary" data-act="setup-next" disabled={busy || !folder.trim()}>{t('desktop.flow.next')}</button>
        </div>
      </form>
    </div>
  );
}
