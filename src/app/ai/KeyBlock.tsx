/**
 * «Erweitert: mit API-Schlüssel» (docs/0.4.0/ai-setup.md, decision 9): folded under the
 * subscription cards. A key is checked by its provider before it is kept in this Mac's keychain
 * store, then one test call answers; a refused key is not kept. What a key cannot serve (the KI
 * column, «Im Terminal») is said in one line.
 */
import { useState, type FormEvent, type ReactNode } from 'react';
import { KEY_PAGES, SETUP_KEYS, type AiSetupView, type KeySaved, type Probation, type SetupKey } from '../../platform/ai-setup.js';
import { t } from '../i18n/index.js';
import { ApiError, errorText } from '../lib/api.js';
import { ICONS } from '../areas/icons.js';

const providerName = (id: SetupKey) => t(`aiSetup.key.${id}`);

/** What a test call with a kept key said. */
export const testLine = (id: SetupKey, test: Probation | undefined): ReactNode => (!test ? null : test.ok
  ? <p className="okline" data-key-state="checked">{ICONS.check}{t('aiSetup.key.checked', { provider: providerName(id) })}</p>
  : <p className="warnline" data-key-state="tested-refused">{ICONS.warn}{t(`aiSetup.refused.${test.why}`, { said: test.said })}</p>);

/** The line on what only a CLI can do. */
export const WithoutCli = () => <p className="aiadvno"><b>{t('aiSetup.key.withoutCli')}</b> {t('aiSetup.key.withoutCliRest')}</p>;

export function KeyBlock({ view, open, onSave, onKept }: {
  view: AiSetupView; open?: boolean;
  onSave(id: SetupKey, key: string | null): Promise<KeySaved>;
  /** A key was kept and its test call answered. */
  onKept?(id: SetupKey): void;
}) {
  const [id, setId] = useState<SetupKey>(() => view.keys.find((k) => k.set)?.id ?? 'anthropic');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string>();
  const [test, setTest] = useState<Probation>();
  const set = view.keys.find((k) => k.id === id)?.set;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!key.trim()) return;
    setBusy(true);
    setRefused(undefined);
    setTest(undefined);
    try {
      const saved = await onSave(id, key);
      setKey('');
      setTest(saved.test);
      if (saved.test?.ok) onKept?.(id);
    } catch (err) {
      setRefused(err instanceof ApiError ? errorText(err) : String(err));
    } finally { setBusy(false); }
  };
  const remove = async () => {
    setBusy(true);
    try { await onSave(id, null); setTest(undefined); } catch (err) { setRefused(errorText(err)); } finally { setBusy(false); }
  };

  return (
    <details className="aiadv" open={open}>
      <summary>{t('aiSetup.key.summary')}</summary>
      <div className="aiadvin">
        <p className="m">{t('aiSetup.key.intro')}</p>
        <span className="seg2" role="radiogroup" aria-label={t('aiSetup.key.provider')}>
          {SETUP_KEYS.map((k) => (
            <button key={k} type="button" role="radio" aria-checked={k === id} className={k === id ? 'on' : ''} onClick={() => { setId(k); setRefused(undefined); setTest(undefined); }}>{providerName(k)}</button>
          ))}
        </span>
        {!view.keysInApp ? <p className="m">{t('aiSetup.key.env')}</p>
          : set ? (
            <>
              {testLine(id, test)}
              <span className="aikey"><span className="mono">{t('aiSetup.key.kept')}</span><button type="button" className="btn ghost" disabled={busy} onClick={() => void remove()}>{t('ai.key.remove')}</button></span>
            </>
          ) : (
            <>
              <form className={refused ? 'aikey bad' : 'aikey'} onSubmit={save}>
                <input type="password" name="api-key" autoComplete="off" spellCheck={false} value={key} aria-label={t('aiSetup.key.placeholder', { provider: providerName(id) })} placeholder={t('aiSetup.key.placeholder', { provider: providerName(id) })} onChange={(e) => setKey(e.target.value)} />
                <button type="submit" className="btn primary" data-act="key-save" disabled={busy || !key.trim()}>{busy ? t('aiSetup.key.checking') : t('aiSetup.key.save')}</button>
              </form>
              {refused ? <p className="warnline" data-key-state="refused">{ICONS.warn}{refused}</p> : null}
            </>
          )}
        <small className="m">{t('aiSetup.key.where')} <a className="linkbtn" href={KEY_PAGES[id]} target="_blank" rel="noopener noreferrer">{t('aiSetup.key.make', { provider: providerName(id) })}{ICONS.external}</a></small>
        <WithoutCli />
      </div>
    </details>
  );
}
