/**
 * Where an address's mail lives, for «Weg hinzufügen» (Belege): the provider and its IMAP server,
 * known from the domain (gmail.com) or from the domain's MX records (a company domain hosted at
 * Infomaniak). A guess the person can still change in the mailbox form; nothing here logs in.
 * No Node import: Belege checks an address with `domainOf` in the browser; the route passes the DNS lookup.
 */
export interface MailHost {
  domain: string;
  /** The provider's name, when the domain or its MX records name one the app knows. */
  provider?: string;
  /** Its IMAP server, when known. */
  host?: string;
  /** The domain's mail exchangers, best first: what the guess rests on. */
  mx: string[];
  /** What the provider asks before IMAP works: an app password, or IMAP switched on in its settings. */
  needs?: 'app-password' | 'imap-on';
  /** A free mail domain (gmail.com): no own address like belege@ can be made there. */
  public: boolean;
}

interface Provider { name: string; domains?: RegExp; mx: RegExp; host?: string; needs?: MailHost['needs'] }

const PROVIDERS: Provider[] = [
  { name: 'Google', domains: /^(gmail|googlemail)\.com$/, mx: /(^|\.)google(mail)?\.com$/, host: 'imap.gmail.com', needs: 'app-password' },
  { name: 'Microsoft', domains: /^(outlook|hotmail|live|msn)\.(com|ch|de|fr|it)$/, mx: /(^|\.)outlook\.com$/, host: 'outlook.office365.com', needs: 'app-password' },
  { name: 'iCloud', domains: /^(icloud|me|mac)\.com$/, mx: /(^|\.)icloud\.com$/, host: 'imap.mail.me.com', needs: 'app-password' },
  { name: 'Yahoo', domains: /^(yahoo|ymail)\.(com|de|fr|it)$/, mx: /(^|\.)yahoodns\.net$/, host: 'imap.mail.yahoo.com', needs: 'app-password' },
  { name: 'GMX', domains: /^gmx\.(ch|de|net|at)$/, mx: /(^|\.)gmx\.net$/, host: 'imap.gmx.net', needs: 'imap-on' },
  { name: 'WEB.DE', domains: /^web\.de$/, mx: /(^|\.)web\.de$/, host: 'imap.web.de', needs: 'imap-on' },
  { name: 'Swisscom (bluewin)', domains: /^bluewin\.ch$/, mx: /(^|\.)bluewin\.ch$/, host: 'imaps.bluewin.ch' },
  { name: 'Infomaniak', mx: /(^|\.)infomaniak\.(com|ch)$/, host: 'mail.infomaniak.com' },
  { name: 'Hostpoint', mx: /(^|\.)hostpoint\.ch$/, host: 'imap.mail.hostpoint.ch' },
  { name: 'Proton', domains: /^(proton\.me|protonmail\.(com|ch)|pm\.me)$/, mx: /(^|\.)protonmail\.ch$/ },
];

/** The domain of an address, lower case; undefined when it is no address. */
export function domainOf(address: string): string | undefined {
  const m = /^[^@\s]+@([a-z0-9.-]+\.[a-z]{2,})$/i.exec(address.trim());
  return m?.[1].toLowerCase();
}

/** The provider of a domain with these MX records (best first): the domain itself wins over its records. */
export function mailHostOf(domain: string, mx: string[]): MailHost {
  const own = PROVIDERS.find((p) => p.domains?.test(domain));
  const p = own ?? PROVIDERS.find((x) => mx.some((m) => x.mx.test(m.toLowerCase())));
  return { domain, mx, public: !!own, ...(p ? { provider: p.name } : {}), ...(p?.host ? { host: p.host } : {}), ...(p?.needs ? { needs: p.needs } : {}) };
}

/** Looks the domain's MX records up with `lookup` (node:dns resolveMx), 3 s at most: an unknown or unreachable name has none. */
export async function lookupMailHost(domain: string, lookup: (d: string) => Promise<Array<{ exchange: string; priority: number }>>): Promise<MailHost> {
  const timeout = new Promise<never>((_, no) => setTimeout(() => no(new Error('timeout')), 3000).unref());
  const records = await Promise.race([lookup(domain), timeout]).catch(() => []);
  return mailHostOf(domain, [...records].sort((a, b) => a.priority - b.priority).map((r) => r.exchange));
}
