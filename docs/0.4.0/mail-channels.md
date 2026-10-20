# Mail channels: the contract a source builds on

**Status: built (0.4.0).** How a source reads mail. The app owns the channel; a source on top
decides only which parts of a mail are documents (ADR 0014, ADR 0015). The app ships one
reference source per channel. A company's own source for one provider starts from it, in the
workspace's `sources/<id>/`.

## Two ways to the same channel

A source declares one way to the mail in `reach` of its `source.yaml`. Its code sees the same
`io.mail` either way.

| Reach | What the app talks to | Secret | Reference source |
|---|---|---|---|
| `mail` | The mailbox's server, over IMAP (`src/platform/sources/mail-channel.ts`) | The password in the keychain, `source:<id>:mail` | `sources/imap/` |
| `mac-mail` | The Mail app on this Mac, through Apple events (`src/platform/sources/mac-mail.ts`) | None. macOS asks the person once whether the app may control Mail | `sources/mail-client/` |

A source with both is refused at load. Firma › Quellen connects either way by hand: «Mail-Programm
auf diesem Mac» lists Mail's accounts and connects one with one click; «Postfach verbinden» takes
an IMAP server and a password.
Neither is the preferred way: which one fits is found out first (docs/personas/README.md).
`macMailAccounts()` says which accounts Mail has, read-only. The AI sets a source up on this
channel with the person (a source binding `app:mail-client`, ADR 0015); when «Prüfen» on its card
finds no account of the name given, it lists the accounts Mail has. Its first call makes macOS
ask the person, so it runs only when the person pressed «Prüfen», never as a silent probe.

```yaml
# sources/mail-app-office/source.yaml: a source over one account of the Mail app
label: { en: Mail app · Office, de: Mail-Programm · Office }
code: app:mail-client          # or ./source.ts: the company's own code
reach:
  mac-mail:
    account: Office            # the account's name in Mail
    folders: [INBOX]           # the mailbox read (the first)
    from: ["*"]                # the senders the code may see
    skip: ["*@news.example"]   # and the ones it never sees
settings: { photos: false }    # read by the code as io.settings
feeds:
  attachments: { output: document, every: daily }
```

## What the code may call

```ts
io.mail.messages(cursor?, limit = 50)
  → { messages: Array<{ uid, from, to, subject, date, messageId }>, cursor, done }
io.mail.attachments(uid)
  → Array<{ file, filename, contentType, size }>   // file: a reference to bytes the host holds
io.out.document(file, { key, date })               // into the inbox, once per key
io.out.checkpoint(cursor)                          // the cursor, into the ledger
io.settings                                        // the source.yaml's settings, frozen
```

The code never holds a connection, a password or the bytes' path. It yields what it decides is
a document by the file reference the host gave it.

## What the host does, for both ways

- **Reach.** Only mail of the declared account and mailbox, from a sender `from` names and `skip`
  does not, reaches the code. `attachments(uid)` refuses a message the code was not shown.
- **Cursor (R5).** A message's id grows as mail arrives: the IMAP UID, or Mail's message id. The
  cursor is `{ validity, uid }`. A changed validity (a new UIDVALIDITY, or Mail numbering its
  messages anew after a mailbox rebuild) starts again from `settings.since`, else 60 days back.
- **No duplicates (R2).** A key delivered before is skipped. Bytes the books, the inbox or the
  ledger hold already are a duplicate. A PDF whose words say it is no receipt goes to
  `data/quarantine/`.
- **Delivery.** Into the inbox (`beleg-import/`), recorded in `collected/<id>.jsonl`. A dry run
  writes nothing. The source never writes the books.
- **Errors to tasks (R7).** A pull that cannot read ends with an outcome, and the collect
  workflow turns it into a person's task:

| Outcome | When | Task |
|---|---|---|
| `missing-secret` | IMAP: no password, or the server refused it | «Passwort für {source} hinterlegen» |
| `mail-app` | Mail app: Mail is not open (`not-running`), the permission is missing (`not-permitted`), the account or mailbox has another name (`no-account`, `no-mailbox`), Mail did not answer (`timeout`) | «{source}: Mail-Programm prüfen» |
| `changed` | The code threw: what it said | «{source}: Seite geändert» |
| `over-reach` | The code asked for something outside its reach | the same |

«Verbindung prüfen» in Firma › Quellen shows the same problem in words before anything is
switched on, and the mails the source would read.

## Where it runs

| | `npm start`, CLI | Mac app |
|---|---|---|
| `mac-mail`, the app's code | yes, on macOS | yes: the app's own code runs in the app's process (`inProcessLauncher`) |
| `mac-mail`, a company's own code | yes, in the fenced child | not yet: the fenced child needs the utility process (ADR 0014, unit 2b) |
| `mail` (IMAP) | yes | not yet: the IMAP client is not packed (docs/desktop.md) |

The Mac app carries the entitlement `com.apple.security.automation.apple-events` and the text
macOS shows when it asks (`NSAppleEventsUsageDescription`). Without macOS or `/usr/bin/osascript`,
Firma › Quellen does not offer the Mail app.

## Limits of the Mail app way

- Mail must be open; Mail fetches new mail only while it runs. The app never starts Mail.
- An attachment Mail has not downloaded (an account set to download recent attachments only) is
  skipped, and the cursor moves past its mail: set the account to download all attachments
  (Mail › Settings › Accounts › Account Information), which iCloud and most IMAP accounts do by
  default.
- A first look over many weeks of a large mailbox takes Mail several seconds; later pulls read
  only what is new.
- Outlook for Mac is not read yet. Its classic version is scriptable the same way; the new
  Outlook is not.
