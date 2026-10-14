# Set up a mailbox for receipt collection

Many receipts arrive by email: software subscriptions, online shops, shipping invoices.
Vanilla Accounting can fetch them for you. A mailbox is a **source** (ADR 0014): a folder
`sources/<name>/` in your workspace that says where the app may look. Every day the workflow
«Belege und Daten holen» signs in to each mailbox over IMAP, takes the PDF attachments of the
mail that arrived since it last looked, and puts them into the import folder (`beleg-import/`)
of your workspace. From there they go through the usual steps
(see [The quarter, step by step](quarter-workflow.md)).

The setup takes about ten minutes per mailbox. You do it once. You need:

- a workspace, made with `npm run init` (see [Getting started](getting-started.md));
- for each mailbox, its IMAP server and a password that IMAP accepts. With most providers
  this is an **app-specific password**, not the password you use in the browser.

The setup has two parts, kept apart on purpose:

| What | Where | Why there |
|---|---|---|
| Which mailbox, which senders, which addresses | `sources/<name>/source.yaml` in your **workspace** | It describes your company, so it lives with your books. |
| The password | the Mac's **keychain** (`npm run secret`) | Secrets never go into the books, which are a git repository you may share with your Treuhand, and never into a file. |

A workspace from before sources has a `mail.yaml`: `npm run update` turns each login in it into
a source, keeps a copy in `data/backups/`, and starts each source where the old collector stopped.

## 1. Describe the mailbox in `sources/<name>/source.yaml`

One login is one source. Its fields:

| Field | Meaning |
|---|---|
| `label` | A short name, shown in Firma › Quellen. |
| `code: app:imap` | The app's mailbox code: it takes every PDF attached to a mail. |
| `settings.boxes` | The addresses of this login, each `{ label, address }`; add `to:` when several addresses share one login and only mail to that address counts. Add `mixed: true` to a box where business and private mail share the mailbox. |
| `reach.mail.host` | The IMAP server, for example `imap.gmail.com`. |
| `reach.mail.account` | The login name, mostly the full mail address. |
| `reach.mail.from` | The senders the app may read: `["*"]` for anyone, or a list such as `["*@vendor.example"]`. |
| `reach.mail.skip` | Senders it never reads, for example newsletters in a mixed mailbox: `["*@news.example.com"]`. |
| `feeds.attachments.every` | How often: `daily` (the default), `weekly`, `monthly`. |

The examples below each show one provider. A workspace can have several mail sources, from
different providers.

### Gmail (and Google Workspace)

```yaml
# sources/gmail/source.yaml
label: gmail
code: app:imap
settings:
  boxes: [{ label: gmail, address: you@gmail.com, mixed: true }]
reach:
  mail: { host: imap.gmail.com, account: you@gmail.com, from: ["*"] }
feeds:
  attachments: { output: document, every: daily }
```

**Password.** Google requires 2-Step Verification for app passwords. Turn it on first, then:

1. Open <https://myaccount.google.com/apppasswords>.
2. Enter a name, for example `vanilla-accounting`, and select **Create**.
3. Copy the 16-letter password. Google shows it only once.

With a Google Workspace address, your administrator can turn app passwords off. If the page
says app passwords are not available, ask your administrator, or use another way in (see
[When IMAP is not possible](#when-imap-is-not-possible)).

### iCloud Mail (also with your own domain)

```yaml
# sources/icloud/source.yaml
label: icloud
code: app:imap
settings:
  boxes: [{ label: icloud, address: info@example.ch, to: info@example.ch }]
reach:
  mail: { host: imap.mail.me.com, account: name@icloud.com, from: ["*"] }
feeds:
  attachments: { output: document, every: daily }
```

**Password.** Apple requires two-factor authentication for app-specific passwords.

1. Open <https://account.apple.com> and sign in.
2. Open **Sign-In and Security**, then **App-Specific Passwords**.
3. Select **+**, enter a name such as `vanilla-accounting`, and copy the password.

The login (`account`) is your iCloud Mail address (`name@icloud.com`), also when you collect the
mail of a custom domain address. `to:` then picks the mail sent to the business address.

### Infomaniak

```yaml
# sources/infomaniak/source.yaml
label: infomaniak
code: app:imap
settings:
  boxes: [{ label: infomaniak, address: info@example.ch }]
reach:
  mail: { host: mail.infomaniak.com, account: info@example.ch, from: ["*"] }
feeds:
  attachments: { output: document, every: daily }
```

**Password.** At Infomaniak, a mail address has its own password, apart from the login to your
Infomaniak account. Set or reset it in the Infomaniak Manager, under **Mail Service**, on the
address. If you use Infomaniak's two-factor login with the Infomaniak Mail app, create an app
password there instead.

### Hostpoint, or any other provider with IMAP

```yaml
# sources/office/source.yaml
label: office
code: app:imap
settings:
  boxes: [{ label: office, address: info@example.ch }]
reach:
  mail: { host: imap.mail.hostpoint.ch, account: info@example.ch, from: ["*"] }
feeds:
  attachments: { output: document, every: daily }
```

For another provider, look for its help page on setting up a mail program ("E-Mail-Programm
einrichten"). It names the IMAP server (incoming server). Port 993 with SSL/TLS is used.

**Password.** With Hostpoint and most smaller providers, the IMAP password is the mailbox
password. If the provider offers two-factor login, it usually also offers app passwords: use
one.

### Microsoft 365, Outlook.com and Hotmail

Not supported. Microsoft no longer accepts a password over IMAP for these mailboxes (business
tenants since 2022, Outlook.com and Hotmail since 2024). It requires a sign-in through
Microsoft (OAuth), which Vanilla Accounting does not do yet. See
[When IMAP is not possible](#when-imap-is-not-possible).

## 2. The password into the keychain

The password never goes into a file. Put it into the Mac's keychain, typed without echo, under
the source's name:

```sh
npm run secret -- source:gmail:mail
```

`npm run secret -- source:gmail:mail --delete` removes it again. A password that is still in
the app's `.env` from an earlier version moves into the keychain with `npm run secret -- --import`,
which then deletes its line from `.env`.

## 3. Switch the source on

Open **Firma › Quellen**. The new source shows what it may reach and waits to be switched on.
Read it, then select **Einschalten**. A change to the source later (another sender, another
address) waits to be switched on again, so nothing reaches further than you agreed.

## 4. Check the login

```sh
npm run doctor -- --mail
```

This logs in to each mail source and logs out again. It reads no mail. Each source gets one line:

| Line | Meaning | What to do |
|---|---|---|
| ✓ … logs in to imap.gmail.com:993 | The setup works. | Go on to step 5. |
| ✗ … refused the login | The server is reached, but the login or password is wrong. | Create a new app password and set it with `npm run secret -- source:<name>:mail`. Check that `account` is the full address. |
| ✗ … cannot reach | The server does not answer. | Check `reach.mail.host` and your network. Check that IMAP is turned on for the mailbox. |

Signed in to the mailbox in the browser is not the same as IMAP access. A mailbox can work in
the browser and still refuse the IMAP login.

## 5. Collect

The workflow «Belege und Daten holen» collects every day on its own, and **Automatisierung ›
Belege und Daten holen › Belege holen** starts it now. By hand, one source:

```sh
npm run pull -- gmail          # what arrived since the last time
npm run pull -- gmail --dry    # fetch and count, deliver nothing
```

A first pull reads the mail of the last 60 days; then each pull goes on where the last one
stopped. What a source delivered is written to `collected/<name>.jsonl`, so nothing is taken
twice, and a file the books or the inbox hold already is not taken again. A missing password
becomes a task in **Aufgaben**: set it with `npm run secret`, then mark the task done.

Not every receipt comes as an attachment. Some vendors send a link, some show the invoice
only in their web portal. The [receipt collection runbook](runbooks/receipt-collection.md)
lists the known vendors and what to do for each.

## When IMAP is not possible

If your provider does not allow IMAP with a password (Microsoft 365, Outlook.com, a Google
Workspace without app passwords), you still have these ways in:

- **Forward.** Set up a rule in the mailbox that forwards receipts to a mailbox that works with
  IMAP, and collect that one.
- **Save by hand.** Save the PDFs from your mail program into `beleg-import/` of the workspace.
- **Phone.** Photograph paper receipts with the phone app; they arrive in `beleg-import/` too.

All three end in the same folder, so the next steps are the same.
