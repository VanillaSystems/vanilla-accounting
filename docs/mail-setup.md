# Set up a mailbox for receipt collection

Many receipts arrive by email: software subscriptions, online shops, shipping invoices.
Vanilla Accounting can fetch them for you. `npm run collect` logs in to your mailboxes over
IMAP, reads the mail of one quarter, and saves every PDF attachment into the import folder
(`beleg-import/`) of your workspace. From there the receipts go through the usual steps
(see [The quarter, step by step](quarter-workflow.md)).

The setup takes about ten minutes per mailbox. You do it once. You need:

- a workspace, made with `npm run init` (see [Getting started](getting-started.md));
- for each mailbox, its IMAP server and a password that IMAP accepts. With most providers
  this is an **app-specific password**, not the password you use in the browser.

The setup has two parts, kept apart on purpose:

| What | Where | Why there |
|---|---|---|
| Which mailboxes, and how their senders are sorted | `mail.yaml` in your **workspace** | It describes your company, so it lives with your books. |
| User names and passwords | `.env` in the **app** folder | Secrets never go into the books, which are a git repository you may share with your Treuhand. |

The app reads `.env` from its own folder, the folder you run `npm` commands in. A `.env` in
the workspace is not read.

## 1. Describe your mailboxes in `mail.yaml`

`npm run init` puts a commented `mail.yaml` into your workspace. Open it and replace it with
your mailboxes. Each mailbox has these fields:

| Field | Required | Meaning |
|---|---|---|
| `label` | yes | A short name, shown in the output: `office`, `gmail`. |
| `address` | yes | The mail address, shown in the output and in `npm run doctor`. |
| `env` | yes | The prefix of this mailbox's keys in `.env`, in capitals. `OFFICE` means `OFFICE_IMAP_USER` and `OFFICE_IMAP_PASSWORD`. |
| `host` | yes | The IMAP server, for example `imap.gmail.com`. |
| `filterTo` | no | Collect only mail sent to this address. Use it when several addresses share one login (an alias). |
| `mixed` | no | `true` when business and private mail share the mailbox. Then `skipDomains` decides which senders to ignore. Default `false`. |

Three lists apply to all mailboxes. Each is a list of sender domains, such as `newsletter.example.com`:

| List | Meaning |
|---|---|
| `skipDomains` | Senders of a mixed mailbox that never send receipts: newsletters, private shops, social media. |
| `includeDomains` | Senders whose mail is always business: your software vendors, suppliers, shipping companies. |
| `linkReceiptDomains` | Senders that send a link to the receipt instead of an attachment (`npm run collect-links`). |

You can start with three empty lists. Fill them in when the first collection shows you which
senders write to you.

The examples below each show one provider. A `mail.yaml` can list several mailboxes, from
different providers.

### Gmail (and Google Workspace)

```yaml
mailboxes:
  - label: gmail
    address: you@gmail.com
    env: GMAIL
    host: imap.gmail.com
    mixed: true          # a personal address that also gets business mail
skipDomains: []
includeDomains: []
linkReceiptDomains: []
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
mailboxes:
  - label: office
    address: info@example.ch
    env: ICLOUD
    host: imap.mail.me.com
    filterTo: info@example.ch   # your own domain on iCloud: collect only mail to this address
```

**Password.** Apple requires two-factor authentication for app-specific passwords.

1. Open <https://account.apple.com> and sign in.
2. Open **Sign-In and Security**, then **App-Specific Passwords**.
3. Select **+**, enter a name such as `vanilla-accounting`, and copy the password.

The IMAP user name is your iCloud Mail address (`name@icloud.com`), also when you collect the
mail of a custom domain address. `filterTo` then picks the mail sent to the business address.

### Infomaniak

```yaml
mailboxes:
  - label: office
    address: info@example.ch
    env: INFOMANIAK
    host: mail.infomaniak.com
```

**Password.** At Infomaniak, a mail address has its own password, apart from the login to your
Infomaniak account. Set or reset it in the Infomaniak Manager, under **Mail Service**, on the
address. If you use Infomaniak's two-factor login with the Infomaniak Mail app, create an app
password there instead. The user name is the full mail address.

### Hostpoint, or any other provider with IMAP

```yaml
mailboxes:
  - label: office
    address: info@example.ch
    env: OFFICE
    host: imap.mail.hostpoint.ch
```

For another provider, look for its help page on setting up a mail program ("E-Mail-Programm
einrichten"). It names the IMAP server (incoming server). Use port 993 with SSL/TLS: that is
the default, so you set no port unless the provider names another one.

**Password.** With Hostpoint and most smaller providers, the IMAP password is the mailbox
password. If the provider offers two-factor login, it usually also offers app passwords: use
one. The user name is almost always the full mail address.

### Microsoft 365, Outlook.com and Hotmail

Not supported. Microsoft no longer accepts a password over IMAP for these mailboxes (business
tenants since 2022, Outlook.com and Hotmail since 2024). It requires a sign-in through
Microsoft (OAuth), which Vanilla Accounting does not do yet. See
[When IMAP is not possible](#when-imap-is-not-possible).

## 2. Put the credentials into the app's `.env`

Open `.env` in the **app** folder (the one with `package.json`; `npm run init` created it).
Add two lines per mailbox, with the `env` prefix of that mailbox:

```sh
GMAIL_IMAP_USER=you@gmail.com
GMAIL_IMAP_PASSWORD=abcdabcdabcdabcd
```

Two more keys are optional:

| Key | When |
|---|---|
| `<ENV>_IMAP_HOST` | Overrides `host` from `mail.yaml`, for example to test another server. |
| `<ENV>_IMAP_PORT` | The provider uses a port other than 993. |

`.env` is in `.gitignore`, so the passwords never get into git. Do not copy them into
`mail.yaml` or into any file of the workspace.

## 3. Check the setup

```sh
npm run doctor
```

For each mailbox in `mail.yaml`, `doctor` shows whether its keys are in `.env`. A missing key
is a ✗ line that names the exact key to add.

To test the login itself:

```sh
npm run doctor -- --mail
```

This logs in to each mailbox and logs out again. It reads no mail. Each mailbox gets one line:

| Line | Meaning | What to do |
|---|---|---|
| ✓ … logs in to imap.gmail.com:993 | The setup works. | Go on to step 4. |
| ✗ … refused the login | The server is reached, but the user name or password is wrong. | Create a new app password and replace `<ENV>_IMAP_PASSWORD`. Check that `<ENV>_IMAP_USER` is the full address. |
| ✗ … cannot reach | The server does not answer. | Check `host` in `mail.yaml` and your network. Check that IMAP is turned on for the mailbox. |

Signed in to the mailbox in the browser is not the same as IMAP access. A mailbox can work in
the browser and still refuse the IMAP login.

## 4. Do a test fetch

```sh
npx tsx src/collect/test-imap.ts 2026-Q3
```

This reads the envelopes (sender, subject, date) of the quarter's mail, with 14 days before
and after, and downloads nothing. It prints every sender domain with its number of mails, most
first, and saves the list as `email-summaries-2026-Q3.json` in `beleg-import/`. Use it to
fill in `skipDomains` and `includeDomains` of a mixed mailbox. Delete the JSON file when you
are done.

## 5. Collect

```sh
npm run collect -- 2026-Q3
```

This saves every PDF attachment of the quarter's mail (again with 14 days on each side, because
an invoice often arrives after the payment) into `beleg-import/`. In a mixed mailbox it skips
the senders in `skipDomains`. A journal (`download-journal.json` in the workspace) remembers
what it saved, so you can run it again: it only adds what is new.

To collect from one mailbox only: `COLLECT_ACCOUNTS=gmail npm run collect -- 2026-Q3`.

Not every receipt comes as an attachment. Some vendors send a link, some show the invoice
only in their web portal. The [receipt collection runbook](runbooks/receipt-collection.md)
lists the known vendors and what to do for each.

## 6. After collecting: revoke the app password

An app password gives full access to the mailbox. Create it before you collect and revoke it
after:

1. Open the same page where you created it, and delete the password.
2. Remove the password from `.env`, or leave the value empty.

`npm run doctor` then shows a ✗ for that mailbox until the next collection. That is expected.

## When IMAP is not possible

If your provider does not allow IMAP with a password (Microsoft 365, Outlook.com, a Google
Workspace without app passwords), you still have these ways in:

- **Forward.** Set up a rule in the mailbox that forwards receipts to a mailbox that works with
  IMAP, and collect that one.
- **Save by hand.** Save the PDFs from your mail program into `beleg-import/` of the workspace.
- **Phone.** Photograph paper receipts with the phone app; they arrive in `beleg-import/` too.

All three end in the same folder, so the next steps are the same.
