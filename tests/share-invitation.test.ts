/**
 * The invitation a recipient who never used the app gets (the owner's review of 2026-11-15): who
 * shares what, every step from the download through macOS's «Dennoch öffnen» to the return, the
 * deadline in plain words, nothing needed beyond the app; in the sharer's language, the person's own
 * message marked as hers and escaped. No version number anywhere.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderInvitation } from '../src/share/invitation.js';
import { invitationTexts } from '../src/server/invitation-texts.js';

const LINK = 'https://share.example.ch/abcdefghijklmnopqrstuvwxyz#AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const base = { senderName: 'Sandra Muster', link: LINK, expiresAt: new Date('2026-11-25T09:30:00Z'), company: 'Muster Kaffee GmbH', hoursAfterOpen: 5 };

test('German: every step, the deadline in words, no account, the message marked and escaped', () => {
  const inv = renderInvitation({ ...base, ...invitationTexts('de'), message: 'Bitte Q3 <b>ansehen</b>', download: 'https://example.ch/download' });
  assert.equal(inv.subject, 'Sandra Muster hat dir die Buchhaltung geschickt');
  for (const part of ['Muster Kaffee GmbH', 'kein Konto, kein Passwort, keine PIN', 'https://example.ch/download', 'Datenschutz & Sicherheit', '«Dennoch öffnen»', 'An Sandra Muster zurückschicken', '25. November 2026', '5 Stunden', 'Nachricht von Sandra Muster:', LINK]) {
    assert.ok(inv.text.includes(part), `text: ${part}`);
  }
  assert.match(inv.text, /1\. Lade Vanilla Accounting/);
  assert.match(inv.text, /4\. Die Buchhaltung öffnet sich/);
  assert.ok(inv.html.includes('Bitte Q3 &lt;b&gt;ansehen&lt;/b&gt;') && !inv.html.includes('<b>ansehen'), 'her words are text, never markup');
  assert.ok(inv.html.includes('href="https://example.ch/download"'));
  assert.doesNotMatch(inv.text + inv.html, /Version \d|vollständig/);
});

test('in the sharer\'s language; without a download page the service\'s own page, which offers the app', () => {
  const fr = renderInvitation({ ...base, ...invitationTexts('fr') });
  assert.equal(fr.subject, 'Sandra Muster t’a envoyé la comptabilité');
  assert.ok(fr.text.includes('«Ouvrir quand même»') && fr.text.includes('25 novembre 2026'), fr.text);
  assert.ok(fr.text.includes('https://share.example.ch/'), 'the service\'s start page offers the download');
  for (const lang of ['en', 'it']) {
    const inv = renderInvitation({ ...base, ...invitationTexts(lang) });
    assert.doesNotMatch(inv.text, /\{\w+\}/, `${lang}: every placeholder filled`);
  }
  assert.throws(() => renderInvitation({ ...base, download: 'http://example.ch/x' }), /https/);
});
