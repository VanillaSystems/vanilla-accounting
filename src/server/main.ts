import 'dotenv/config';
import type { AddressInfo } from 'node:net';
import { networkInterfaces } from 'node:os';
import { app, READONLY } from './api.js';
import { closeBrowser } from '../invoices/pdf.js';

// PORT=0 lets the system choose. Without VANILLA_API_HOST the server listens on every interface,
// so the phone app reaches it on the LAN.
const PORT = process.env.PORT ? Number(process.env.PORT) : 3456;
const HOST = process.env.VANILLA_API_HOST;

const server = HOST ? app.listen(PORT, HOST, listening) : app.listen(PORT, listening);

function listening() {
  const { port } = server.address() as AddressInfo;
  console.log(`\nAPI server running on port ${port}`);
  if (READONLY) console.log('🔒 READ-ONLY mode — all writes are blocked');

  // Print all IPv4 addresses so user can find the right one for the iOS app
  const nets = networkInterfaces();
  for (const [iface, addrs] of Object.entries(nets)) {
    for (const addr of addrs ?? []) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      const label = addr.address.startsWith('172.20.10.') ? 'USB  ' : 'LAN  ';
      console.log(`  ${label}  http://${addr.address}:${port}  (${iface})`);
    }
  }
  console.log();
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => { void closeBrowser().finally(() => process.exit(0)); });
}
