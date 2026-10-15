import 'dotenv/config';
import type { AddressInfo } from 'node:net';
import { networkInterfaces } from 'node:os';
import { app, READONLY } from './api.js';
import { closeBrowser } from '../invoices/pdf.js';
import { startBackground } from './background.js';
import { pairingUrl, phoneToken } from './phone.js';
import { WS } from './books.js';
import { useKeychain } from '../secrets/keychain-store.js';

// npm start keeps its secrets in the Mac's keychain (the desktop app sets its own store).
useKeychain(() => WS.paths.root);

// PORT=0 lets the system choose. Without VANILLA_API_HOST the server listens on every interface,
// so the phone app reaches it on the LAN; with VANILLA_PHONE_TOKEN set it needs that token.
const PORT = process.env.PORT ? Number(process.env.PORT) : 3456;
const HOST = process.env.VANILLA_API_HOST;

const server = HOST ? app.listen(PORT, HOST, listening) : app.listen(PORT, listening);

function listening() {
  const { port } = server.address() as AddressInfo;
  console.log(`\nAPI server running on port ${port}`);
  if (READONLY) console.log('🔒 READ-ONLY mode — all writes are blocked');

  // Every IPv4 address, so the phone can be pointed at the right one.
  const token = phoneToken();
  const nets = networkInterfaces();
  for (const [iface, addrs] of Object.entries(nets)) {
    for (const addr of addrs ?? []) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      const label = addr.address.startsWith('172.20.10.') ? 'USB  ' : 'LAN  ';
      console.log(`  ${label}  ${token ? pairingUrl(addr.address, port, token) : `http://${addr.address}:${port}`}  (${iface})`);
    }
  }
  if (!token) console.log('  Phone uploads need no token: set VANILLA_PHONE_TOKEN in .env to require one.');
  console.log();
}

startBackground();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => { void closeBrowser().finally(() => process.exit(0)); });
}
