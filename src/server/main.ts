import 'dotenv/config';
import type { AddressInfo } from 'node:net';
import { networkInterfaces } from 'node:os';
import { app, READONLY } from './api.js';
import { closeBrowser } from '../invoices/pdf.js';
import { startBackground } from './background.js';
import { pairingUrl, phoneToken } from './phone.js';
import { readBooks, WS } from './books.js';
import { hasBooks } from '../books/store.js';
import { locateWorkspace } from '../workspace/workspace.js';
import { bundledDemo } from '../workspace/demo-copy.js';
import { useKeychain } from '../secrets/keychain-store.js';

// npm start keeps its secrets in the Mac's keychain (the desktop app sets its own store).
useKeychain(() => WS.paths.root);

// PORT=0 lets the system choose. Without VANILLA_API_HOST the server listens on every interface,
// so the phone app reaches it on the LAN, with the token of src/server/phone.ts and only its paths.
const PORT = process.env.PORT ? Number(process.env.PORT) : 3456;
const HOST = process.env.VANILLA_API_HOST;

const server = HOST ? app.listen(PORT, HOST, listening) : app.listen(PORT, listening);

function listening() {
  const { port } = server.address() as AddressInfo;
  // The first load logs the books' dangling references (#126), before any request comes, and
  // before the port is named: whoever waits for that line may write the books at once (#122).
  if (hasBooks(WS)) readBooks();

  // Every IPv4 address with the token, so the phone can be pointed at the right one. Printed before
  // the port is named, so whoever waits for that line has the pairing links already.
  const token = phoneToken()!;
  console.log('\nPhone: open one of these links on the phone; from the network only the phone upload answers, with this code.');
  for (const [iface, addrs] of Object.entries(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      const label = addr.address.startsWith('172.20.10.') ? 'USB  ' : 'LAN  ';
      console.log(`  ${label}  ${pairingUrl(addr.address, port, token)}  (${iface})`);
    }
  }
  if (!process.env.VANILLA_PHONE_TOKEN?.trim()) console.log('  The code is new at every start: set VANILLA_PHONE_TOKEN in .env to keep one.');

  if (READONLY) console.log('🔒 READ-ONLY mode — all writes are blocked');
  if (bundledDemo(locateWorkspace())) console.log(`Demo: working on a copy in ${WS.paths.repository} (npm run demo:reset starts it afresh)`);
  console.log(`\nAPI server running on port ${port}\n`);
}

startBackground();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => { void closeBrowser().finally(() => process.exit(0)); });
}
