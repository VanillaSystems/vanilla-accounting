/**
 * The phone's way in (docs/usecases/employee.md EM-01, docs/desktop.md «Receipts from the phone»):
 * the receipt app and the scan page reach four paths from the local network, and the two that
 * answer with data or write the inbox only with the pairing token. Everything else stays on this
 * computer. The token travels as `Authorization: Bearer <token>`; the QR code the Mac shows
 * carries it in the URL's fragment, which a browser never sends.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import express from 'express';
import type { ApiErrorBody } from '../types/api-error.js';

/** The paths a phone uses, with their method; the pages need no token, they hold nothing. */
export const PHONE_ROUTES: ReadonlyArray<{ method: 'GET' | 'POST'; path: string; token: boolean }> = [
  { method: 'GET', path: '/scan', token: false },
  { method: 'GET', path: '/scan/manifest.json', token: false },
  { method: 'GET', path: '/api/status', token: true },
  { method: 'POST', path: '/api/upload', token: true },
];

/** The paths the API answers from another device (src/server/api.ts). */
export const NETWORK_PATHS: ReadonlySet<string> = new Set(PHONE_ROUTES.map((r) => r.path));

const LOOPBACK = /^(127\.|::1$|::ffff:127\.)/;
export const fromThisComputer = (req: express.Request) => LOOPBACK.test(req.socket.remoteAddress ?? '');

export const newPhoneToken = (): string => randomBytes(32).toString('base64url');

/** Compared in constant time: both sides hashed first, so neither the length nor a prefix shows in the timing. */
export function tokenMatches(given: string | undefined, token: string): boolean {
  if (!given) return false;
  const h = (s: string) => createHash('sha256').update(s).digest();
  return timingSafeEqual(h(given), h(token));
}

const bearer = (req: express.Request) => /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '')?.[1];

/** `npm start` takes the token from VANILLA_PHONE_TOKEN (.env); the desktop app sets its own. */
let configured: () => string | undefined = () => process.env.VANILLA_PHONE_TOKEN?.trim() || undefined;
export function usePhoneToken(get: () => string | undefined): void { configured = get; }
export const phoneToken = (): string | undefined => configured();

const refuseToken = (res: express.Response) =>
  res.setHeader('Connection', 'close').status(401).json({ error: 'Dieses Handy ist nicht gekoppelt: den Code am Mac neu scannen.', code: 'phoneToken' } satisfies ApiErrorBody);

/**
 * For the API: a request from another device to a path that needs the token is refused without
 * it, once a token is configured. Without one (`npm start` with no VANILLA_PHONE_TOKEN) the paths
 * stay open to the network as before. Requests from this computer never need it.
 */
export function phoneGate(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const token = phoneToken();
  const route = PHONE_ROUTES.find((r) => r.path === req.path);
  if (!token || !route?.token || fromThisComputer(req) || tokenMatches(bearer(req), token)) return next();
  refuseToken(res);
}

/**
 * The desktop app's listener on the local network: the phone routes and nothing else, the token
 * checked before a body is read, then handed to `books` (the books API, which checks again). With
 * no token every token route is refused: the listener never runs open.
 */
export function phoneApp(books: express.RequestHandler, token: () => string | undefined): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    const route = PHONE_ROUTES.find((r) => r.path === req.path && (r.method === req.method || (r.method === 'GET' && req.method === 'HEAD')));
    if (!route) { res.setHeader('Connection', 'close').status(404).json({ error: 'Not found' }); return; }
    const t = token();
    if (route.token && (!t || !tokenMatches(bearer(req), t))) { refuseToken(res); return; }
    // No connection is kept open: switched off, the listener is gone at once, with nothing left to reuse.
    res.setHeader('Connection', 'close');
    books(req, res, next);
  });
  return app;
}

/**
 * Where the receipt app («Vanilla Belege», ios/) is downloaded: the first step of «Handy koppeln».
 * A placeholder until the app is published (docs/releasing.md, «The iPhone app's download link»).
 */
export const APP_STORE_URL = 'https://apps.apple.com/ch/app/vanilla-belege';

/** The URL the QR code carries: the scan page, with the token in the fragment. The receipt app reads host, port and token from it. */
export const pairingUrl = (address: string, port: number, token: string) => `http://${address}:${port}/scan#token=${token}`;

/**
 * This Mac's IPv4 addresses a phone can reach, Wi-Fi and Ethernet (en*) first; the iPhone's USB
 * hotspot (172.20.10.x) last.
 */
export function lanAddresses(): string[] {
  const found = Object.entries(networkInterfaces()).flatMap(([name, addrs]) =>
    (addrs ?? []).filter((a) => a.family === 'IPv4' && !a.internal).map((a) => ({ name, address: a.address })));
  const rank = (x: { name: string; address: string }) => (x.address.startsWith('172.20.10.') ? 2 : x.name.startsWith('en') ? 0 : 1);
  return found.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name)).map((x) => x.address);
}
