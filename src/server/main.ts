import 'dotenv/config';
import { networkInterfaces } from 'node:os';
import { app, READONLY } from './api.js';

const PORT = Number(process.env.PORT) || 3456;

app.listen(PORT, () => {
  console.log(`\nAPI server running on port ${PORT}`);
  if (READONLY) console.log('🔒 READ-ONLY mode — all writes are blocked');

  // Print all IPv4 addresses so user can find the right one for the iOS app
  const nets = networkInterfaces();
  for (const [iface, addrs] of Object.entries(nets)) {
    for (const addr of addrs ?? []) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      const label = addr.address.startsWith('172.20.10.') ? 'USB  ' : 'LAN  ';
      console.log(`  ${label}  http://${addr.address}:${PORT}  (${iface})`);
    }
  }
  console.log();
});
