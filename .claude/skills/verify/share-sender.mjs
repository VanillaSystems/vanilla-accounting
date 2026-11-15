// This Mac's confirmed share sender for the packed app in a VM (vm.sh sender). The sender is
// { service, email, token } in ~/.vanilla-accounting/e2e/share-sender (mode 600, never in a repo).
//
//   node share-sender.mjs --check SENDER_FILE   asks the service (GET /api/senders/me) whether the
//                                               token is a confirmed sender: prints confirmed,
//                                               unconfirmed or refused (exit 0, 3, 4)
//   node share-sender.mjs SENDER_FILE           prints the app's secrets.json with `share:sender`
//                                               sealed as Electron's safeStorage seals it on macOS
//                                               under Chromium's --use-mock-keychain (OSCrypt «v10»:
//                                               AES-128-CBC, key PBKDF2-SHA1("mock_password",
//                                               "saltysalt", 1003), IV of 16 spaces), which
//                                               src/secrets/sealed-store.ts reads as the app's own
//
// The real keychain key cannot be used: its item admits only the app, and the keychain prompt that
// would let anything else read it takes no keys over VNC. The token goes on no command line and is
// never printed.
import { readFileSync } from 'node:fs';
import { createCipheriv, pbkdf2Sync } from 'node:crypto';

const check = process.argv[2] === '--check';
const senderFile = process.argv[check ? 3 : 2];
if (!senderFile) { console.error('usage: node share-sender.mjs [--check] SENDER_FILE'); process.exit(1); }
const sender = JSON.parse(readFileSync(senderFile, 'utf8'));
for (const k of ['service', 'email', 'token']) if (typeof sender[k] !== 'string' || !sender[k]) { console.error(`${senderFile}: no ${k}`); process.exit(1); }

if (check) {
  const res = await fetch(new URL('/api/senders/me', sender.service), { headers: { Authorization: `Bearer ${sender.token}` } }).catch(() => ({ ok: false, status: 0 }));
  if (!res.ok) { console.log(`refused (HTTP ${res.status}) ${sender.email} at ${sender.service}`); process.exit(4); }
  const me = await res.json();
  console.log(`${me.confirmed ? 'confirmed' : `unconfirmed${me.refusedReason ? ` (${me.refusedReason})` : ''}`} ${sender.email} at ${sender.service}`);
  process.exit(me.confirmed ? 0 : 3);
}

const key = pbkdf2Sync('mock_password', 'saltysalt', 1003, 16, 'sha1');
const cipher = createCipheriv('aes-128-cbc', key, Buffer.alloc(16, ' '));
const plain = JSON.stringify({ service: sender.service, email: sender.email, token: sender.token });
const sealed = Buffer.concat([Buffer.from('v10'), cipher.update(plain, 'utf8'), cipher.final()]);
// MACHINE in src/secrets/secrets.ts: the sender belongs to this computer, not to one books folder.
process.stdout.write(JSON.stringify({ '(this computer)': { 'share:sender': sealed.toString('base64') } }, null, 2));
