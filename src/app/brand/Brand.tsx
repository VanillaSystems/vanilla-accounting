/**
 * Where the brand shows in the app (the brand's "Vanilla Accounting in the app"): the lockup and the
 * endorsement on the start screen, the app icon in About and while loading, the muted seal at the
 * bottom of both. The workspace shows none of it. Light and dark take the brand's own files.
 */
import { t } from '../i18n/index.js';
import { ENDORSEMENT, PRODUCT, SEAL_NAME } from './names.js';
import lockup from './assets/lockup.svg?url';
import lockupOnDark from './assets/lockup-on-dark.svg?url';
import icon from './assets/icon.svg?url';
import seal from './assets/seal-muted.svg?url';
import sealOnDark from './assets/seal-muted-on-dark.svg?url';
import './brand.css';

/** One image for light, one for dark; the hidden one is left out of the accessibility tree. */
function Themed({ light, dark, alt, className, height }: { light: string; dark: string; alt: string; className: string; height: number }) {
  return (
    <span className={`themed ${className}`}>
      <img className="on-light" src={light} alt={alt} height={height} />
      <img className="on-dark" src={dark} alt={alt} height={height} />
    </span>
  );
}

export const Lockup = ({ height = 52 }: { height?: number }) =>
  <Themed className="lockup" light={lockup} dark={lockupOnDark} alt={PRODUCT} height={height} />;

export const Seal = () => <Themed className="seal" light={seal} dark={sealOnDark} alt={SEAL_NAME} height={12} />;

export const Endorsement = () => <p className="endorse">{ENDORSEMENT}</p>;

export const AppIcon = ({ size }: { size: number }) => <img className="appicon" src={icon} alt="" width={size} height={size} />;

/** Loading: the app icon, gently pulsing (still under prefers-reduced-motion, tokens.css). */
export const Splash = () => (
  <div className="splash" role="status"><AppIcon size={84} /><span className="sr">{t('app.loading')}</span></div>
);

/** About: icon, full name, version, subtitle, endorsement and licence, and the seal last. */
export function About({ version }: { version: string }) {
  return (
    <div className="about-card">
      <AppIcon size={72} />
      <h2>{PRODUCT}</h2>
      <p className="mono">{t('about.version', { version })}</p>
      <p>{t('about.subtitle')}</p>
      <p>{ENDORSEMENT} · {t('about.license')}</p>
      <div className="about-seal"><Seal /></div>
    </div>
  );
}
