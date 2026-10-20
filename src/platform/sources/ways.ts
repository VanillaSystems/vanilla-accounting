/**
 * The channels a source can reach a company's documents through, most preferred first, and what
 * each needs from the person: a provider's API, the mailbox's server, the mail program on this
 * Mac, a browser session last. Channels, not solutions: the source on top (which account, which
 * pages, what counts as a receipt) is written with the person in their workspace, binding the
 * app's code where it fits as it is (ADR 0015). Which channel fits is found out first
 * (processes/receipt-collection.guide.yaml#setup); among those that fit, the most preferred one
 * available here is proposed. A channel is available when this app serves it here.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { folders } from './load.js';
import { macMailAvailable } from './mac-mail.js';
import { sourcesRunHere } from './launcher.js';
import { findBrowser } from '../../invoices/pdf.js';

/** The reach key a source declares for the channel (model.ts Reach). */
export type ChannelId = 'api' | 'mail' | 'mac-mail' | 'web';

export interface CollectChannel {
  id: ChannelId;
  /** What it reads, in plain words for the model. */
  what: string;
  /** Where it fits. */
  fits: string;
  /** What it asks of the person. */
  needs: string;
  /** The app's code a source binds for it as it is (`code: app:<id>`); without, the source's own code is written in the workspace. */
  bind?: string;
  /** What this machine must have besides the app. */
  requires?: 'mac-mail' | 'own-code' | 'chrome';
}

const CHANNELS: readonly CollectChannel[] = [
  { id: 'api', requires: 'own-code', what: 'reads a provider\'s interface over HTTPS with a token (io.api, reading only)', fits: 'a provider that offers API access (a shop, a payment provider, a mail provider with an API)', needs: 'a token the person makes at the provider (walked through by you) and types into the card' },
  { id: 'mail', bind: 'imap', what: 'connects to the mailbox\'s server (IMAP); it reads the same mail the person reads in a browser, a program or on the phone, also while the Mac is off', fits: 'any mailbox, whatever the person reads it in', needs: 'an app password the person makes at their mail provider (walked through by you) and types into the card; the server is found from the address' },
  { id: 'mac-mail', bind: 'mail-client', requires: 'mac-mail', what: 'reads one account of the Mail app on this Mac while Mail is open', fits: 'a person who reads this mailbox in Apple Mail on this Mac', needs: 'the account\'s name as Mail shows it; the person clicks «OK» once when macOS asks whether the app may control Mail' },
  { id: 'web', requires: 'chrome', what: 'reads pages in a browser window of the app, signed in by the person (io.web: open, read, click, download, every address checked against the source\'s reach)', fits: 'the last resort: a mailbox or portal that no API, server access or mail program reaches', needs: 'the person signs in once in the source\'s window, a second factor included' },
];

export interface Here { macMail: boolean; ownCode: boolean; chrome: boolean }

/** What this machine has: the Mail app's channel, a source's own code (not in the Mac app yet), a Chromium browser. */
export const hereNow = (): Here => ({ macMail: macMailAvailable(), ownCode: sourcesRunHere(), chrome: !!(process.env.CHROME_PATH || findBrowser()) });

const bindable = (dir: string) => {
  try { return (parse(readFileSync(join(dir, 'source.yaml'), 'utf8')) as { bindable?: unknown })?.bindable === true; } catch { return false; }
};

/** Every channel, most preferred first, with whether this app serves it here. */
export function collectChannels(appRoot: string, here: Here = hereNow()): Array<CollectChannel & { available: boolean }> {
  const dir = join(appRoot, 'sources');
  const shipped = new Set(existsSync(dir) ? folders(dir).filter((id) => bindable(join(dir, id))) : []);
  const has = { 'mac-mail': here.macMail, 'own-code': here.ownCode, chrome: here.chrome && here.ownCode };
  return CHANNELS.map((c) => ({ ...c, available: (!c.bind || shipped.has(c.bind)) && (!c.requires || has[c.requires]) }));
}
