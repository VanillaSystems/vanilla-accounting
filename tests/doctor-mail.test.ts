/**
 * npm run doctor and the mailboxes of mail.yaml: a mailbox without its keys in the app's .env
 * fails naming the keys to add; `--mail` logs in to each over IMAP (TLS) and reports the server's
 * refusal. The IMAP server is a local stand-in, so no mail leaves the machine.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:tls';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempWorkspace } from './support/workspace.js';
import { APP_ROOT } from '../src/workspace/workspace.js';

const hasOpenssl = spawnSync('openssl', ['version']).status === 0;

/** An IMAP server that accepts one password and answers OK to everything else it is sent. */
function fakeImap(dir: string, password: string): Promise<Server> {
  const [key, cert] = [join(dir, 'key.pem'), join(dir, 'cert.pem')];
  const made = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=localhost', '-days', '1', '-keyout', key, '-out', cert]);
  assert.equal(made.status, 0, String(made.stderr));
  const server = createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (socket) => {
    socket.write('* OK [CAPABILITY IMAP4rev1] ready\r\n');
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      for (let i = buffer.indexOf('\r\n'); i >= 0; i = buffer.indexOf('\r\n')) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 2);
        const [tag, command] = line.split(' ');
        if (command?.toUpperCase() === 'LOGIN') {
          socket.write(line.endsWith(` "${password}"`) || line.endsWith(` ${password}`)
            ? `${tag} OK logged in\r\n` : `${tag} NO [AUTHENTICATIONFAILED] Invalid credentials\r\n`);
        } else if (command?.toUpperCase() === 'LOGOUT') {
          socket.end(`* BYE\r\n${tag} OK bye\r\n`);
        } else {
          socket.write(`${tag} OK done\r\n`);
        }
      }
    });
    socket.on('error', () => {});
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function doctor(dir: string, env: Record<string, string>, ...args: string[]): Promise<string> {
  const bin = mkdtempSync(join(tmpdir(), 'doctor-bin-'));
  writeFileSync(join(bin, 'claude'), '#!/bin/sh\nif [ "$1" = auth ]; then echo \'{"loggedIn":true}\'; else echo "9.9.9 (Claude Code)"; fi\n');
  chmodSync(join(bin, 'claude'), 0o755);
  return new Promise((resolve) => {
    execFile(process.execPath, ['--import', 'tsx', join(APP_ROOT, 'src/cli/doctor.ts'), '--workspace', dir, ...args], {
      cwd: APP_ROOT, encoding: 'utf8',
      env: { ...process.env, BELEGE_WORKSPACE: '', PATH: `${bin}:${process.env.PATH}`, NODE_TLS_REJECT_UNAUTHORIZED: '0', ...env },
    }, (_err, stdout, stderr) => { rmSync(bin, { recursive: true, force: true }); resolve(stdout + stderr); });
  });
}

const MAIL_YAML = `mailboxes:
  - { label: office, address: office@example.com, env: TESTOFFICE, host: 127.0.0.1 }
  - { label: shop, address: shop@example.com, env: TESTSHOP, host: 127.0.0.1 }
  - { label: private, address: me@example.com, env: TESTPRIVATE, host: 127.0.0.1, mixed: true }
`;

test('doctor: missing mailbox keys are named; --mail logs in and reports a refused password', { skip: !hasOpenssl && 'openssl is needed for the test server certificate' }, async () => {
  const ws = tempWorkspace('doctor-mail-');
  const dir = ws.paths.root;
  writeFileSync(ws.paths.mail, MAIL_YAML);
  const server = await fakeImap(dir, 'app-password');
  const port = String((server.address() as AddressInfo).port);
  const env = {
    TESTOFFICE_IMAP_USER: 'office@example.com', TESTOFFICE_IMAP_PASSWORD: 'app-password', TESTOFFICE_IMAP_PORT: port,
    TESTSHOP_IMAP_USER: 'shop@example.com', TESTSHOP_IMAP_PASSWORD: 'browser-password', TESTSHOP_IMAP_PORT: port,
    TESTPRIVATE_IMAP_USER: 'me@example.com',
  };
  try {
    const keysOnly = await doctor(dir, env);
    assert.match(keysOnly, /✓ Mailbox office \(office@example\.com\): credentials in \.env/);
    assert.match(keysOnly, /✗ Mailbox private \(me@example\.com\): TESTPRIVATE_IMAP_PASSWORD not set\n {4}fix: Add to .*\.env: TESTPRIVATE_IMAP_PASSWORD=…/);
    assert.doesNotMatch(keysOnly, /logs in to/, 'no login without --mail');

    const login = await doctor(dir, env, '--mail');
    assert.match(login, new RegExp(`✓ Mailbox office \\(office@example\\.com\\): logs in to 127\\.0\\.0\\.1:${port}`));
    assert.match(login, /✗ Mailbox shop \(shop@example\.com\): 127\.0\.0\.1 refused the login \(Invalid credentials\)\n {4}fix: Create a new app-specific password and put it in TESTSHOP_IMAP_PASSWORD/);
    assert.match(login, /✗ Mailbox private \(me@example\.com\): TESTPRIVATE_IMAP_PASSWORD not set/);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
