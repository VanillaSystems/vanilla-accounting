/**
 * The dialogs of the ways in (docs/0.4.0/mockups/receipt-inflow): «Handy koppeln» in two steps (the
 * app, then the Mac app's pairing code of Firma › Handy), «Weg hinzufügen» by hand (the address,
 * where its mail is read, a proposal among what the app can do today), the forwarding steps, and
 * «Alle Wege», where what comes later is shown faded. A mailbox ends in Firma › Quellen's form,
 * filled in; a password never goes anywhere else.
 */
import { useEffect, useState, type FormEvent, type MouseEvent, type ReactNode } from 'react';
import { api, errorText } from '../../lib/api.js';
import { t } from '../../i18n/index.js';
import { desktop } from '../../desktop/bridge.js';
import { BotIcon } from '../automation/Graph.js';
import { statementAdd } from '../bank/actions.js';
import { setMailDraft } from '../company/mail-draft.js';
import type { AreaProps, Nav } from '../index.js';
import { domainOf, type MailHost } from '../../../platform/sources/mail-host.js';
import { MAIL_CLIENTS, mailWays, type MailClient, type MailWay } from './inflow.js';
import { closeInflow, openInflow, switchPhone, useInflow, type InflowDialog } from './inflow-state.js';
import { askSetup, W } from './InflowStrip.js';
import { intakeAdd } from './intake.js';

/** The search a forwarding filter starts from: the words receipts carry, in the four languages. */
const FILTER_QUERY = 'rechnung OR invoice OR facture OR fattura OR beleg OR quittung OR receipt';

export function InflowDialogs(props: AreaProps) {
  const { dialog } = useInflow();
  if (!dialog || !props.canEdit) return null;
  switch (dialog.kind) {
    case 'pair': return <Pair step={dialog.step} />;
    case 'add': return <AddWay {...props} />;
    case 'all': return <AllWays {...props} />;
    case 'forward': return <Forward nav={props.nav} address={dialog.address} host={dialog.host} />;
  }
}

function Frame({ title, extra, children, wide }: { title: string; extra?: ReactNode; children: ReactNode; wide?: boolean }) {
  return (
    <>
      <div className="scrim inflowscrim" onClick={closeInflow} />
      <div className={`palette inflowdlg${wide ? ' wide' : ''}`} role="dialog" aria-label={title} onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') closeInflow(); }}>
        <header><b>{title}</b>{extra}<button type="button" className="aiact icon" aria-label={t('common.close')} onClick={closeInflow}>×</button></header>
        <div className="dbody">{children}</div>
      </div>
    </>
  );
}

function Tile({ icon, title, text, onClick, later, rec }: { icon: ReactNode; title: string; text: string; onClick?: () => void; later?: boolean; rec?: boolean }) {
  return (
    <button type="button" className={`tile${later ? ' later' : ''}${rec ? ' rec' : ''}`} disabled={later} onClick={onClick}>
      {icon}<b>{title}{later ? <small>{t('inflow.later')}</small> : null}</b><span>{text}</span>
    </button>
  );
}

/** A QR code the server drew (src/desktop/qr.ts): dark modules on white, like paper, in both themes. */
const Qr = ({ svg, label }: { svg: string; label: string }) => <div className="qr" role="img" aria-label={label} dangerouslySetInnerHTML={{ __html: svg }} />;

function Steps({ on }: { on: 1 | 2 }) {
  return <div className="steps2"><span className={on === 1 ? 'on' : ''}>{t('inflow.pair.step1')}</span><span className={on === 2 ? 'on' : ''}>{t('inflow.pair.step2')}</span></div>;
}

/** «Handy koppeln»: the receipt app first, then the pairing code, which needs the Mac app's phone access switched on. */
function Pair({ step }: { step: 'install' | 'pair' }) {
  return (
    <Frame title={t('inflow.pair')}>
      <Steps on={step === 'install' ? 1 : 2} />
      {step === 'install' ? <Install /> : <PairCode />}
    </Frame>
  );
}

function Install() {
  const [app, setApp] = useState<{ url: string; qr: string }>();
  const [copied, setCopied] = useState(false);
  useEffect(() => { api.phoneApp().then(setApp, () => undefined); }, []);
  const copy = () => { if (app) void navigator.clipboard?.writeText(app.url).then(() => setCopied(true), () => undefined); };
  return (
    <>
      <div className="pair">
        {app ? <Qr svg={app.qr} label={app.url} /> : <div className="qr" />}
        <div className="form">
          <p><b>{t('inflow.pair.scanStore')}</b> {t('inflow.pair.opensStore')}</p>
          <p className="hint">{t('inflow.pair.orBrowser')}</p>
          {app ? <div className="url"><code>{app.url.replace(/^https:\/\//, '')}</code><button type="button" className="aiact" onClick={copy}>{t(copied ? 'inflow.pair.copied' : 'inflow.pair.copy')}</button></div> : null}
          <p className="hint">{t('inflow.pair.free')}</p>
        </div>
      </div>
      <div className="acts">
        <button type="button" className="aiact" onClick={closeInflow}>{t('inflow.pair.later')}</button>
        <button type="button" className="aiact primary" data-testid="pair-next" onClick={() => openInflow({ kind: 'pair', step: 'pair' })}>{t('inflow.pair.next')}</button>
      </div>
    </>
  );
}

function PairCode() {
  const { phone } = useInflow();
  const [error, setError] = useState<string>();
  // Clicking «Koppeln» is the person's wish to pair: the access opens, as «Einschalten» in Firma › Handy.
  useEffect(() => { if (desktop && !phone?.on) switchPhone(true).catch((e) => setError(errorText(e))); }, []);
  const back = <button type="button" className="aiact back" onClick={() => openInflow({ kind: 'pair', step: 'install' })}>{t('inflow.pair.back')}</button>;
  if (!desktop) {
    return (
      <>
        <p className="hint">{t('phone.notDesktop')}</p>
        <div className="acts">{back}<button type="button" className="aiact primary" onClick={closeInflow}>{t('inflow.pair.done')}</button></div>
      </>
    );
  }
  const problem = error ?? (phone?.error ? t('phone.failed', { detail: phone.error }) : phone?.on && !phone.addresses.length ? t('phone.noNetwork') : undefined);
  return (
    <>
      {problem ? <p className="err">{problem}</p> : null}
      <div className="pair">
        {phone?.qr ? <Qr svg={phone.qr} label={phone.url ?? ''} /> : <div className="qr"><span className="spin" /></div>}
        <ol>
          <li><b>{t('inflow.pair.openApp')}</b><div>{t('phone.scan')}</div></li>
          <li><b>{t('inflow.pair.allow')}</b><div>{t('phone.firewall')}</div></li>
        </ol>
      </div>
      <p className="hint">{t('inflow.pair.onNow')}</p>
      <div className="acts">{back}<button type="button" className="aiact primary" data-testid="pair-done" onClick={closeInflow}>{t('inflow.pair.done')}</button></div>
    </>
  );
}

type AddStep =
  | { at: 'address' }
  | { at: 'client'; address: string; host?: MailHost }
  | { at: 'suggest'; address: string; host?: MailHost; client: MailClient };

/** The known facts about an address, in one line: where its mail lives and what that rests on. */
function Known({ address, host, client }: { address: string; host?: MailHost; client?: MailClient }) {
  const at = host?.provider ? t('inflow.add.at', { provider: host.provider }) : t('inflow.add.atUnknown');
  const why = host?.mx.length ? t('inflow.add.mx', { mx: host.mx[0] }) : t('inflow.add.noMx');
  return (
    <p className="known">{W.check}<span><b>{address}</b> · {at}{client ? ` · ${t(`inflow.where.${client}` as 'inflow.where.apple')}` : ''}{client ? null : <small>{host?.public ? host.domain : why}</small>}</span></p>
  );
}

const CLIENT_ICON: Record<MailClient, ReactNode> = { apple: W.laptop, outlook: W.laptop, browser: W.globe, phone: W.phone };

function AddWay(props: AreaProps) {
  const { nav } = props;
  const [step, setStep] = useState<AddStep>({ at: 'address' });
  const [address, setAddress] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  async function next(e: FormEvent) {
    e.preventDefault();
    const a = address.trim();
    if (!domainOf(a)) { setErr(t('inflow.add.badAddress')); return; }
    setBusy(true);
    const host = await api.mailHost(a).catch(() => undefined);
    setBusy(false);
    setErr('');
    setStep({ at: 'client', address: a, host });
  }
  const withAi = (e: MouseEvent<HTMLElement>) => { closeInflow(); askSetup(e); };
  const back = <button type="button" className="aiact back" onClick={() => setStep({ at: 'address' })}>{t('inflow.back')}</button>;
  const extra = <button type="button" className="aiact" onClick={withAi}><BotIcon />{t('inflow.withAi')}</button>;

  if (step.at === 'address') {
    return (
      <Frame title={t('inflow.addWay')} extra={extra}>
        <form className="form" noValidate onSubmit={(e) => void next(e)}>
          <label>{t('inflow.add.askAddress')}<input type="email" name="address" autoFocus autoComplete="email" placeholder={t('inflow.add.addressExample')} value={address} onChange={(e) => setAddress(e.target.value)} /></label>
          {err ? <p className="err" role="alert">{err}</p> : null}
          <div className="acts"><button type="submit" className="aiact primary" disabled={busy} data-testid="add-next">{busy ? <span className="spin small" /> : null}{busy ? t('inflow.add.looking') : t('inflow.add.next')}</button></div>
        </form>
        <h3>{t('inflow.add.noMail')}</h3>
        <div className="tiles">
          <Tile icon={W.phone} title={t('inflow.way.phone')} text={t('inflow.way.phoneText')} onClick={() => openInflow({ kind: 'pair', step: 'install' })} />
          <Tile icon={W.bank} title={t('inflow.way.bank')} text={t('inflow.way.bankText')} onClick={() => { closeInflow(); statementAdd.run(props); }} />
          <Tile icon={W.plus} title={t('inflow.allWays')} text={t('inflow.way.allText')} onClick={() => openInflow({ kind: 'all' })} />
        </div>
      </Frame>
    );
  }
  if (step.at === 'client') {
    const provider = step.host?.provider ?? t('inflow.client.webmail');
    return (
      <Frame title={t('inflow.addWay')} extra={extra}>
        <Known address={step.address} host={step.host} />
        <h3>{t('inflow.add.where')}</h3>
        <div className="tiles">
          {MAIL_CLIENTS.map((c) => (
            <Tile key={c} icon={CLIENT_ICON[c]} title={t(`inflow.client.${c}` as 'inflow.client.apple')} text={c === 'browser' ? provider : t(`inflow.client.${c}Text` as 'inflow.client.appleText')} onClick={() => setStep({ ...step, at: 'suggest', client: c })} />
          ))}
        </div>
        <div className="acts">{back}</div>
      </Frame>
    );
  }
  const ways = mailWays(step.client);
  const take = (w: MailWay) => {
    if (w === 'forward') { openInflow({ kind: 'forward', address: step.address, host: step.host }); return; }
    setMailDraft({ address: step.address, host: step.host?.host ?? '' });
    closeInflow();
    nav.go({ route: { area: 'company', section: 'sources' }, query: {} });
  };
  const row = (w: MailWay, first: boolean) => (
    <div key={w} className={`sug${first ? ' rec' : ''}${w === 'client' ? ' later' : ''}`} data-way={w}>
      {w === 'imap' ? W.mail : w === 'forward' ? W.fwd : W.laptop}
      <b>{w === 'client' ? t('inflow.way.client', { where: t(`inflow.client.${step.client}` as 'inflow.client.apple') }) : t(`inflow.way.${w}` as 'inflow.way.imap')}</b>
      <span>{wayText(w, step.host)}</span>
      {w === 'client' ? <small>{t('inflow.later')}</small> : <button type="button" className={`aiact${first ? ' primary' : ''}`} onClick={() => take(w)}>{t(first ? 'inflow.add.doRec' : 'inflow.add.doAlt')}</button>}
    </div>
  );
  return (
    <Frame title={t('inflow.addWay')} extra={extra}>
      <Known address={step.address} host={step.host} client={step.client} />
      <h3>{t('inflow.add.rec')}</h3>
      {row(ways[0], true)}
      <h3>{t('inflow.add.alt')}</h3>
      {ways.slice(1).map((w) => row(w, false))}
      <p className="foot">{t('inflow.add.foot')}</p>
      <div className="acts"><button type="button" className="aiact back" onClick={() => setStep({ at: 'client', address: step.address, host: step.host })}>{t('inflow.back')}</button></div>
    </Frame>
  );
}

function wayText(w: MailWay, host: MailHost | undefined): string {
  if (w === 'forward') return t('inflow.way.forwardText');
  if (w === 'client') return t('inflow.way.clientText');
  const provider = host?.provider ?? '';
  return host?.needs === 'app-password' ? t('inflow.way.imapAppPassword', { provider })
    : host?.needs === 'imap-on' ? t('inflow.way.imapOn', { provider })
      : t('inflow.way.imapText');
}

/** Forwarding: an address of its own for receipts, a filter that sends them there, and that address connected by IMAP. */
function Forward({ nav, address, host }: { nav: Nav; address: string; host?: MailHost }) {
  const own = host && !host.public ? host.domain : undefined;
  const [target, setTarget] = useState(own ? `belege@${own}` : '');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  async function connect(e: FormEvent) {
    e.preventDefault();
    const domain = domainOf(target);
    if (!domain) { setErr(t('inflow.add.badAddress')); return; }
    setBusy(true);
    const h = domain === host?.domain ? host : await api.mailHost(target).catch(() => undefined);
    setBusy(false);
    setMailDraft({ address: target.trim(), host: h?.host ?? '' });
    closeInflow();
    nav.go({ route: { area: 'company', section: 'sources' }, query: {} });
  }
  const provider = host?.provider ?? t('inflow.fwd.yourProvider');
  return (
    <Frame title={t('inflow.fwd.title')}>
      {address ? <Known address={address} host={host} /> : null}
      <ol>
        <li><b>{t('inflow.fwd.step1')}</b><div>{own ? t('inflow.fwd.step1Own', { provider, target: `belege@${own}` }) : t('inflow.fwd.step1Any')}</div></li>
        <li><b>{t('inflow.fwd.step2')}</b><div>{t('inflow.fwd.step2Text')}<pre>{FILTER_QUERY}</pre>{t('inflow.fwd.check')}</div></li>
        <li><b>{t('inflow.fwd.step3')}</b><div>{t('inflow.fwd.step3Text')}</div></li>
      </ol>
      <form className="form" noValidate onSubmit={(e) => void connect(e)}>
        <label>{t('inflow.fwd.target')}<input type="email" name="target" value={target} placeholder={t('inflow.add.addressExample')} onChange={(e) => setTarget(e.target.value)} /></label>
        {err ? <p className="err" role="alert">{err}</p> : null}
        <div className="acts">
          <button type="button" className="aiact back" onClick={() => openInflow({ kind: 'add' })}>{t('inflow.back')}</button>
          <button type="submit" className="aiact primary" disabled={busy}>{t('inflow.fwd.connect')}</button>
        </div>
      </form>
    </Frame>
  );
}

/** Every way in, grouped by how much it asks of the person; what the app cannot do yet is faded. */
function AllWays(props: AreaProps) {
  const { nav } = props;
  const go = (d: InflowDialog) => () => openInflow(d);
  const toSources = () => { setMailDraft({ address: '', host: '' }); closeInflow(); nav.go({ route: { area: 'company', section: 'sources' }, query: {} }); };
  return (
    <Frame title={t('inflow.allWays')} wide>
      <h3>{t('inflow.all.auto')}</h3>
      <div className="tiles">
        <Tile icon={W.fwd} title={t('inflow.all.forward')} text={t('inflow.all.forwardText')} onClick={go({ kind: 'forward', address: '' })} />
        <Tile icon={W.mail} title={t('inflow.all.imap')} text={t('inflow.all.imapText')} onClick={toSources} />
        <Tile icon={W.laptop} title={t('inflow.all.client')} text={t('inflow.all.clientText')} later />
        <Tile icon={W.folder} title={t('inflow.all.folder')} text={t('inflow.all.folderText')} later />
        <Tile icon={W.link} title={t('inflow.all.links')} text={t('inflow.all.linksText')} later />
      </div>
      <h3>{t('inflow.all.login')}</h3>
      <div className="tiles">
        <Tile icon={W.key} title={t('inflow.all.signin')} text={t('inflow.all.signinText')} later />
        <Tile icon={W.globe} title={t('inflow.all.webmail')} text={t('inflow.all.webmailText')} later />
        <Tile icon={W.shop} title={t('inflow.all.portal')} text={t('inflow.all.portalText')} later />
      </div>
      <h3>{t('inflow.all.hand')}</h3>
      <div className="tiles">
        <Tile icon={W.phone} title={t('inflow.way.phone')} text={t('inflow.way.phoneText')} onClick={go({ kind: 'pair', step: 'install' })} />
        <Tile icon={W.bank} title={t('inflow.way.bank')} text={t('inflow.way.bankText')} onClick={() => { closeInflow(); statementAdd.run(props); }} />
        <Tile icon={W.down} title={t('inflow.drop')} text={t('inflow.all.dropText')} onClick={() => { closeInflow(); intakeAdd.run(props); }} />
        <Tile icon={W.print} title={t('inflow.all.print')} text={t('inflow.all.printText')} later />
        <Tile icon={W.archive} title={t('inflow.all.mbox')} text={t('inflow.all.mboxText')} later />
      </div>
      <p className="foot">{t('inflow.all.foot')}</p>
    </Frame>
  );
}
