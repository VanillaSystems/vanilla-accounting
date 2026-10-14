/**
 * npm run doctor and the mail sources (ADR 0014): a source without its password in the keychain
 * fails naming the command that sets it; `--mail` logs in to each
 * over IMAP (TLS) and reports the server's refusal. The IMAP server is a local stand-in and a
 * secrets file stands in for the keychain, so no mail leaves the machine and no keychain is touched.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:tls';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempWorkspace } from './support/workspace.js';
import { APP_ROOT } from '../src/workspace/workspace.js';
import { approveSource, sources } from '../src/platform/sources/index.js';

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

const source = (account: string) => `label: ${account}
code: app:imap
settings: { boxes: [{ label: ${account}, address: ${account} }] }
reach:
  mail: { host: 127.0.0.1, account: ${account}, from: ["*"] }
feeds:
  attachments: { output: document, every: daily }
`;

test('doctor: a missing password is named with its fix; --mail logs in and reports a refused password', { skip: !hasOpenssl && 'openssl is needed for the test server certificate' }, async () => {
  const ws = tempWorkspace('doctor-mail-');
  const dir = ws.paths.root;
  for (const [id, account] of [['office', 'office@example.com'], ['shop', 'shop@example.com'], ['private', 'me@example.com']]) {
    mkdirSync(join(dir, 'sources', id), { recursive: true });
    writeFileSync(join(dir, 'sources', id, 'source.yaml'), source(account));
  }
  const approvals = mkdtempSync(join(tmpdir(), 'doctor-approvals-'));
  process.env.VANILLA_APPROVALS_DIR = approvals;
  for (const v of sources(ws, APP_ROOT)) if (v.kind !== 'invalid' && v.decl.id !== 'private') approveSource(ws, v.decl);
  const server = await fakeImap(dir, 'app-password');
  const port = String((server.address() as AddressInfo).port);
  const secretsFile = join(approvals, 'secrets.json');
  writeFileSync(secretsFile, JSON.stringify({ 'source:office:mail': 'app-password', 'source:shop:mail': 'browser-password' }));
  const env = { VANILLA_SECRETS_FILE: secretsFile, VANILLA_APPROVALS_DIR: approvals, OFFICE_IMAP_PORT: port, SHOP_IMAP_PORT: port, PRIVATE_IMAP_PORT: port };
  try {
    const keysOnly = await doctor(dir, env);
    assert.match(keysOnly, /✓ Mail source office \(office@example\.com\): password in the keychain/);
    assert.match(keysOnly, /✗ Mail source private \(me@example\.com\): source:private:mail not set\n {4}fix: Set the password with npm run secret -- source:private:mail/);
    assert.doesNotMatch(keysOnly, /logs in to/, 'no login without --mail');

    const login = await doctor(dir, env, '--mail');
    assert.match(login, new RegExp(`✓ Mail source office \\(office@example\\.com\\): logs in to 127\\.0\\.0\\.1:${port}`));
    assert.match(login, /✗ Mail source shop \(shop@example\.com\): 127\.0\.0\.1 refused the login \(Invalid credentials\)\n {4}fix: Create a new app-specific password and set it with npm run secret -- source:shop:mail/);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
