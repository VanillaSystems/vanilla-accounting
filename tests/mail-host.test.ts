/**
 * «Weg hinzufügen» guesses where an address's mail lives: a free mail domain by its name, a company
 * domain by its MX records, and nothing when neither names a provider the app knows. The DNS
 * lookup is a stand-in here; a failing or slow one leaves the guess empty, never the request hanging.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { domainOf, lookupMailHost, mailHostOf } from '../src/platform/sources/mail-host.js';

test('a free mail domain is known by its name and is public', () => {
  const h = mailHostOf('gmail.com', []);
  assert.equal(h.provider, 'Google');
  assert.equal(h.host, 'imap.gmail.com');
  assert.equal(h.needs, 'app-password');
  assert.equal(h.public, true);
});

test('a company domain is known by its MX records and is not public', () => {
  assert.deepEqual(mailHostOf('muster-kaffee.ch', ['mx1.mail.infomaniak.com']), { domain: 'muster-kaffee.ch', mx: ['mx1.mail.infomaniak.com'], public: false, provider: 'Infomaniak', host: 'mail.infomaniak.com' });
  assert.equal(mailHostOf('firma.ch', ['firma-ch.mail.protection.outlook.com']).host, 'outlook.office365.com');
  assert.equal(mailHostOf('firma.ch', ['aspmx.l.google.com']).provider, 'Google');
});

test('an unknown provider names none, and a look-alike MX does not pass for a known one', () => {
  assert.deepEqual(mailHostOf('firma.ch', ['mx.notgoogle.com']), { domain: 'firma.ch', mx: ['mx.notgoogle.com'], public: false });
});

test('the lookup orders the records by priority, and a failed lookup has none', async () => {
  const h = await lookupMailHost('firma.ch', async () => [{ exchange: 'mx2.mail.hostpoint.ch', priority: 20 }, { exchange: 'mx1.example.net', priority: 10 }]);
  assert.deepEqual(h.mx, ['mx1.example.net', 'mx2.mail.hostpoint.ch']);
  assert.equal(h.provider, 'Hostpoint');
  const failed = await lookupMailHost('nowhere.invalid', async () => { throw new Error('ENOTFOUND'); });
  assert.deepEqual(failed, { domain: 'nowhere.invalid', mx: [], public: false });
});

test('only an address has a domain', () => {
  assert.equal(domainOf(' Info@Muster-Kaffee.CH '), 'muster-kaffee.ch');
  assert.equal(domainOf('info@'), undefined);
  assert.equal(domainOf('no address'), undefined);
});
