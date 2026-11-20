/**
 * The iPhone app that sends receipt photos to the Mac (ios/): its name as the app's texts say it, and
 * where it is downloaded. The name is a placeholder until the owner picks one (20.11.2026); the iOS
 * project's bundle id and folders keep theirs. Until the app is in the App Store there is no link:
 * «Belege vom Handy» then pairs through the scan page in the phone's browser, which works today, and
 * shows nothing that leads nowhere. VANILLA_PHONE_APP_URL names the link for a build that has one.
 */
export const PHONE_APP_NAME = 'Vanilla Scanner';

/** The App Store page, once the app is published (docs/releasing.md, «The iPhone app's download link»); absent until then. */
export const PHONE_APP_STORE_URL: string | undefined = undefined;

export const phoneAppUrl = (): string | undefined => (typeof process === 'undefined' ? undefined : process.env.VANILLA_PHONE_APP_URL) || PHONE_APP_STORE_URL;
