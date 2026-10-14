/**
 * Sources (ADR 0014), as data: the parsed declaration, its reach, its verdict. Browser-safe: the
 * Quellen page and the server share it. A source is a folder `sources/<id>/` in the app or the
 * company workspace with `source.yaml` and code; one place outside is one source, what it delivers
 * are its feeds, how far it may go is its reach.
 */

declare const brand: unique symbol;
type Brand<T, B> = T & { readonly [brand]: B };

/** A text in the languages it is written in; `en` is the fallback. */
export type Text = { en: string } & Record<string, string>;

export type Channel = 'mail' | 'web' | 'api';

/**
 * `shop.example.com/admin/orders/*`: a host (exact, or `*.example.com` for one label under it) and
 * path segments, where `*` is exactly one segment and a trailing `*` the rest. https only; query
 * and fragment are ignored. Parsed once at load, never a regular expression.
 */
export type HostPath = Brand<{ host: string; segments: string[]; rest: boolean; text: string }, 'HostPath'>;

/** `*@example.com`, `billing@example.com`, or `*` for anyone. */
export type SenderPattern = Brand<{ local: string; domain: string; text: string }, 'SenderPattern'>;

export interface MailReach { host: string; account: string; folders: string[]; from: SenderPattern[]; skip: SenderPattern[] }
export interface WebReach { start?: string; signIn: HostPath[]; open: HostPath[]; download: HostPath[] }
export interface ApiReach { base: string; scopes: string[]; auth: { bearer: true } | { header: string }; allow: Array<{ method: 'GET'; path: HostPath }> }
export interface Reach { mail?: MailReach; web?: WebReach; api?: ApiReach }

export type Cadence = 'hourly' | 'daily' | 'weekly' | 'monthly' | 'on-demand';
export const CADENCES: readonly Cadence[] = ['hourly', 'daily', 'weekly', 'monthly', 'on-demand'];
export type OutputDecl = { kind: 'document' } | { kind: 'rebuilt' } | { kind: 'records'; record: string };

export interface FeedDecl { id: string; output: OutputDecl; every: Cadence }

export interface SourceDecl {
  id: string;
  label: Text;
  origin: 'app' | 'company';
  /** Own code in the folder, or code the app ships, bound by its id. */
  code: { kind: 'own'; entry: string } | { kind: 'app'; id: string };
  settings: Record<string, unknown>;
  reach: Reach;
  feeds: FeedDecl[];
  /** sha16 over source.yaml and every file its code can load: what an approval pins. */
  version: string;
}

export interface Problem { file: string; line?: number; message: string }

export type SourceVerdict =
  | { kind: 'ready'; decl: SourceDecl }
  /** Loads and checks, but this version is not switched on: dry runs only. */
  | { kind: 'pending'; decl: SourceDecl; reachDiff: ReachDiff }
  | { kind: 'invalid'; id: string; origin: 'app' | 'company'; problems: Problem[] };

export interface ReachDiff { added: Array<{ channel: Channel; what: string }>; removed: Array<{ channel: Channel; what: string }> }

/** A source as the Quellen page shows it: its verdict, and whether each channel's secret is there (never its value). */
export interface SourceRow { verdict: SourceVerdict; secrets: Array<{ channel: 'mail' | 'api'; present: boolean }> }

/** The keychain name of a channel's secret: derived, never listed. */
export const secretKey = (source: string, channel: 'mail' | 'api') => `source:${source}:${channel}` as const;
