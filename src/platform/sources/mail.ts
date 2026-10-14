/**
 * mail.yaml as sources (ADR 0014): one source folder per mailbox, bound to the app's IMAP code,
 * its reach the mailbox's host, account and senders. `mailFromSources` reads them back, so the
 * conversion is checked to lose nothing before the workspace's mail.yaml gives way to it.
 */
import { stringify } from 'yaml';
import type { MailConfig, Mailbox } from '../../collect/mail-config.js';
import type { SourceDecl } from './model.js';

const idOf = (m: Mailbox) => m.env.toLowerCase().replace(/_/g, '-');
const envOf = (id: string) => id.toUpperCase().replace(/-/g, '_');
/** A list entry that is a domain, as a sender pattern; anything else (a stray word) is no sender a mail can have. */
const isDomain = (d: string) => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(d);
const senders = (domains: Iterable<string>) => [...domains].filter(isDomain).sort().map((d) => `*@${d}`);

/**
 * One source.yaml per login: mailboxes that share a login (one `env`, told apart by the address
 * mail is sent to) are one place outside, so one source with each of them in `settings.boxes`. The
 * login name comes from the app's .env as before (`<ENV>_IMAP_USER`), else the first address.
 */
export function sourcesFromMail(cfg: MailConfig, env: NodeJS.ProcessEnv): Array<{ id: string; yaml: string }> {
  const logins = new Map<string, Mailbox[]>();
  for (const m of cfg.mailboxes) logins.set(idOf(m), [...(logins.get(idOf(m)) ?? []), m]);
  return [...logins].map(([id, boxes]) => {
    const [first] = boxes;
    const mixed = boxes.some((m) => m.mixed);
    const decl = {
      label: boxes.map((m) => m.label).join(' · '),
      code: 'app:imap',
      settings: {
        boxes: boxes.map((m) => ({ label: m.label, address: m.address, ...(m.filterTo ? { to: m.filterTo } : {}), mixed: m.mixed })),
        skip: [...cfg.skipDomains].sort(),
        include: [...cfg.includeDomains].sort(),
        links: [...cfg.linkReceiptDomains].sort(),
      },
      reach: { mail: { host: first.host, account: env[`${first.env}_IMAP_USER`] || first.address, folders: ['INBOX'], from: ['*'], skip: mixed ? senders(cfg.skipDomains) : [] } },
      feeds: { attachments: { output: 'document', every: 'daily' } },
    };
    const stray = [...cfg.skipDomains].filter((d) => !isDomain(d)).sort();
    const note = mixed && stray.length ? `# Not a sender domain, so left out of reach.mail.skip (kept in settings.skip): ${stray.join(', ')}\n` : '';
    return { id, yaml: `# ${boxes.map((m) => `The mailbox ${m.label} (${m.address})`).join('; ')}, from mail.yaml. The password is the secret source:${id}:mail.\n${note}${stringify(decl)}` };
  });
}

/** The mailboxes of the sources bound to the app's IMAP code, as mail.yaml held them. */
export function mailFromSources(decls: SourceDecl[]): MailConfig {
  const mail = decls.filter((d) => d.code.kind === 'app' && d.code.id === 'imap' && d.reach.mail);
  const list = (d: SourceDecl, k: string) => (Array.isArray(d.settings[k]) ? (d.settings[k] as string[]) : []);
  type Box = { label: string; address: string; to?: string; mixed?: boolean };
  return {
    mailboxes: mail.flatMap((d) => ((d.settings.boxes ?? []) as Box[]).map((b): Mailbox => ({
      label: b.label, address: b.address, env: envOf(d.id), host: d.reach.mail!.host, ...(b.to ? { filterTo: b.to } : {}), mixed: b.mixed === true,
    }))),
    skipDomains: new Set(mail.flatMap((d) => list(d, 'skip'))),
    includeDomains: new Set(mail.flatMap((d) => list(d, 'include'))),
    linkReceiptDomains: new Set(mail.flatMap((d) => list(d, 'links'))),
  };
}
