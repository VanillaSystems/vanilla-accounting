/**
 * The reach grammar (ADR 0014): parsed at load, matched before anything leaves the machine. The
 * only place that knows the patterns; the loader parses with it and the channels match with it.
 */
import type { Channel, HostPath, Reach, ReachDiff, SenderPattern } from './model.js';

export type Parsed<T> = { ok: true; value: T } | { ok: false; message: string };

const LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const SEGMENT = /^[A-Za-z0-9._~%+=,:@!$&'()-]+$/;

/** `host/seg/*\/seg/*`. Refuses a scheme other than https, a wildcard inside a label or segment, `**`, an empty host and IP literals. */
export function parseHostPath(text: string): Parsed<HostPath> {
  const raw = text.trim().replace(/^https:\/\//, '');
  if (/^[a-z]+:\/\//i.test(raw)) return { ok: false, message: `${text}: only https addresses` };
  const [host, ...path] = raw.split('/');
  const labels = host.toLowerCase().split('.');
  if (!host || labels.length < 2) return { ok: false, message: `${text}: a host such as shop.example.com` };
  if (/^\d+(\.\d+){3}$/.test(host) || host.includes(':')) return { ok: false, message: `${text}: a name, not an IP address or port` };
  if (!labels.every((l, i) => LABEL.test(l) || (i === 0 && l === '*' && labels.length > 2))) return { ok: false, message: `${text}: "*." may only stand for the first label` };
  const segments = path.filter((s, i) => s !== '' || i < path.length - 1);
  if (segments.some((s) => s === '**' || (s.includes('*') && s !== '*'))) return { ok: false, message: `${text}: "*" stands for a whole segment` };
  if (segments.some((s) => s !== '*' && !SEGMENT.test(s))) return { ok: false, message: `${text}: a path segment with characters an address cannot hold` };
  const rest = segments.at(-1) === '*' && raw.endsWith('*');
  return { ok: true, value: { host: host.toLowerCase(), segments: rest ? segments.slice(0, -1) : segments, rest, text: text.trim() } as HostPath };
}

/** `*@example.com`, `billing@example.com`, or `*`. */
export function parseSender(text: string): Parsed<SenderPattern> {
  const t = text.trim().toLowerCase();
  if (t === '*') return { ok: true, value: { local: '*', domain: '*', text: t } as SenderPattern };
  const m = /^([^@\s]+)@([a-z0-9.-]+\.[a-z]{2,})$/.exec(t);
  if (!m || (m[1].includes('*') && m[1] !== '*')) return { ok: false, message: `${text}: a sender such as *@example.com or billing@example.com` };
  return { ok: true, value: { local: m[1], domain: m[2], text: t } as SenderPattern };
}

/** https only; the host equal (or one label under `*.`); the path by its segments; query and fragment ignored. */
export function matches(p: HostPath, url: string): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== 'https:' || u.port) return false;
  const host = u.hostname.toLowerCase();
  const ok = p.host.startsWith('*.') ? host.endsWith(p.host.slice(1)) && host.split('.').length === p.host.split('.').length : host === p.host;
  if (!ok) return false;
  const segs = u.pathname.split('/').filter(Boolean).map((s) => decodeURIComponent(s));
  // A trailing `*` stands for at least one more segment.
  if (p.rest ? segs.length <= p.segments.length : segs.length !== p.segments.length) return false;
  return p.segments.every((s, i) => s === '*' || s === segs[i]);
}

export const matchesAny = (ps: readonly HostPath[], url: string): boolean => ps.some((p) => matches(p, url));

const senderMatches = (p: SenderPattern, address: string) => {
  const [local, domain] = address.toLowerCase().split('@');
  return p.domain === '*' || (domain === p.domain && (p.local === '*' || p.local === local));
};

/** Whether the host lets a mail of this sender through: a sender the reach names, and none it skips. */
export const senderAllowed = (r: { from: SenderPattern[]; skip: SenderPattern[] }, address: string): boolean =>
  r.from.some((p) => senderMatches(p, address)) && !r.skip.some((p) => senderMatches(p, address));

/** Every place of a reach, one line each: what an approval reads. */
export function reachLines(r: Reach): Array<{ channel: Channel; what: string }> {
  const out: Array<{ channel: Channel; what: string }> = [];
  if (r.mail) {
    out.push({ channel: 'mail', what: `${r.mail.account} @ ${r.mail.host} · ${r.mail.folders.join(', ')}` });
    for (const f of r.mail.from) out.push({ channel: 'mail', what: `from ${f.text}` });
    for (const s of r.mail.skip) out.push({ channel: 'mail', what: `not from ${s.text}` });
  }
  if (r.macMail) {
    out.push({ channel: 'mail', what: `${r.macMail.account} in the Mail app of this Mac · ${r.macMail.folders.join(', ')}` });
    for (const f of r.macMail.from) out.push({ channel: 'mail', what: `from ${f.text}` });
    for (const s of r.macMail.skip) out.push({ channel: 'mail', what: `not from ${s.text}` });
  }
  if (r.web) for (const [k, ps] of [['sign-in', r.web.signIn], ['open', r.web.open], ['download', r.web.download]] as const) for (const p of ps) out.push({ channel: 'web', what: `${k} ${p.text}` });
  if (r.api) for (const a of r.api.allow) out.push({ channel: 'api', what: `${a.method} ${r.api.base}${a.path.text}` });
  return out;
}

/** What this version may reach that the switched-on one could not, and what it no longer reaches. */
export function reachDiff(before: Reach | undefined, next: Reach): ReachDiff {
  const key = (l: { channel: Channel; what: string }) => `${l.channel} ${l.what}`;
  const [a, b] = [reachLines(before ?? {}), reachLines(next)];
  const had = new Set(a.map(key)), has = new Set(b.map(key));
  return { added: b.filter((l) => !had.has(key(l))), removed: a.filter((l) => !has.has(key(l))) };
}

/** Thrown by a channel before anything leaves the machine; it becomes the `over-reach` outcome. */
export class ReachError extends Error {
  constructor(readonly channel: Channel, readonly attempted: string) { super(`${channel}: ${attempted} is outside the declared reach`); }
}
