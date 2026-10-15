/**
 * Firma › Handy (docs/desktop.md, «Receipts from the phone»): the desktop app's phone access,
 * off until switched on here. On, it shows the QR code a phone pairs with (the scan page's
 * address and the token) and the Mac's addresses; a new code locks out every phone paired so far.
 */
import { useEffect, useState } from 'react';
import { t } from '../../i18n/index.js';
import { api, errorText } from '../../lib/api.js';
import { desktop } from '../../desktop/bridge.js';
import type { PhoneInfo } from '../../../types/desktop.js';
import type { Nav } from '../index.js';

export function PhoneSection({ nav }: { nav: Nav }) {
  const [info, setInfo] = useState<PhoneInfo>();
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (desktop) api.desktop.phone().then(setInfo, (e) => nav.toast(errorText(e))); }, []);
  if (!desktop) return <p className="m">{t('phone.notDesktop')}</p>;
  if (!info) return <p className="m">{t('changes.loading')}</p>;

  const act = async (call: () => Promise<PhoneInfo>, done?: string) => {
    setBusy(true);
    try {
      setInfo(await call());
      if (done) nav.toast(done);
    } catch (e) {
      nav.toast(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const [first, ...others] = info.addresses;
  return (
    <>
      <p>{t('phone.intro')}</p>
      <dl className="kv2 wide">
        <dt>{t('phone.state')}</dt>
        <dd>
          {info.on ? t('phone.isOn', { port: info.port ?? '' }) : <span className="m">{t('phone.isOff')}</span>}{' '}
          <button type="button" className="btn" disabled={busy} onClick={() => act(() => api.desktop.setPhone(!info.on))}>{t(info.on ? 'phone.switchOff' : 'phone.switchOn')}</button>
        </dd>
        {info.on && first ? <><dt>{t('phone.address')}</dt><dd className="mono">{first}:{info.port}</dd></> : null}
        {info.on && others.length ? <><dt>{t('phone.others')}</dt><dd className="mono">{others.map((a) => `${a}:${info.port}`).join(', ')}</dd></> : null}
      </dl>
      {info.error ? <p className="warnline">{t('phone.failed', { detail: info.error })}</p> : null}
      {info.on && !first ? <p className="warnline">{t('phone.noNetwork')}</p> : null}
      {info.on && info.qr ? (
        <div className="phonepair">
          {/* The SVG is the server's own (src/desktop/qr.ts), dark modules on white like paper. */}
          <div className="phoneqr" role="img" aria-label={info.url} dangerouslySetInnerHTML={{ __html: info.qr }} />
          <div>
            <p>{t('phone.scan')}</p>
            <p className="m">{t('phone.firewall')}</p>
          </div>
        </div>
      ) : null}
      {info.on ? <p className="m">{t('phone.offWhy')}</p> : null}
      <p>
        <button type="button" className="btn" disabled={busy} onClick={() => act(api.desktop.renewPhone, t('phone.renewed'))}>{t('phone.renew')}</button>{' '}
        <span className="m">{t('phone.renewWhy')}</span>
      </p>
    </>
  );
}
