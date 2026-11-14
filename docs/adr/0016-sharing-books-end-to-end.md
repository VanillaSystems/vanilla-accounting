# ADR 0016: Sharing books end to end through a host that cannot read them

**Status: accepted (owner, 2026-11-14), not built.** Spec:
[docs/specs/e2e-and-fiduciary.md](../specs/e2e-and-fiduciary.md), Part B. Prototype: PR #530
(`docs/0.4.0/mockups/share/`). The service lives in a private repository (`vanilla-share`); its
protocol is that repository's `docs/protocol.md`.

## Context

An owner books her company and wants a fiduciary to look at it: often a family member, not
technical, without an account anywhere and without git. ADR 0003 keeps the books local-first in
git and plans a cloud instance for outsiders, which needs logins, a server holding the books and
someone to run it. A file sent by hand (a `.vanilla` file, the spec's first draft) works without
any of that, but leaves the person to find a way to send 60 MB, and the sharer never learns
whether it arrived.

The books hold a company's whole finances. Whoever stores them for the trip must not be able to
read them, and must not become a place where twenty years of books pile up.

## Decision

- **A link, not a file.** «Teilen…» in the app encrypts the package end to end (a random 256-bit
  key per share, AES-GCM in chunks) and uploads only ciphertext to `share.<domain>` (the
  publisher's domain, named in README.md). The service e-mails the recipient a link
  `share.<domain>/<id>#<key>`. The key sits in the fragment, which a browser never sends; the page
  hands it to the app (`vanilla-accounting://open?share=<id>#<key>`).
- **The same package both ways.** The first share carries the open years, later ones only what is
  new; the recipient's return carries only his change set. The sharer takes it over through the
  write door, by record, after review.
- **No PIN, no login, no accounts.** Whoever has the e-mail can open the books. The protections
  are time and count: 10 days, then deleted; at most 3 downloads; the sharer sees «geöffnet am …»;
  «Zurückziehen» deletes at once.
- **Cloudflare now** (a Worker and R2 storage), within the free tier, with hard caps. The service
  is free for the person.
- **The `.vanilla` file stays** as the offline way (a USB stick, SwissTransfer), with the same
  format.

## Consequences

- **The host stores nothing it can read.** Moving it is a matter of trust, not of data: a Swiss
  host later takes over `share.<domain>` by a DNS change, and the app does not change. What the
  service does see is named in the spec: addresses, names, the company's name, the optional
  message, sizes and times.
- **Sending the e-mail is the weak point.** The service writes the e-mail, so the link with the
  key passes through it once. It must keep that text in memory only; the spec lists alternatives
  (the key sent another way, or the sharer's own mail program) as an open question.
- **No PIN, no login, on purpose.** A PIN sent in the same e-mail protects nothing, and one sent
  another way is a step a 71-year-old fiduciary fails at; an account is a password he forgets for
  a quarterly visit. The e-mail address is the identity, as it is for every invoice the company
  sends. The short life and the download count bound a forwarded or leaked e-mail.
- **«Zurückziehen» cannot recall a copy.** It deletes what the service holds. A copy the
  recipient has already opened stays on his Mac, as a printed binder would. The app says so on the
  share card and never claims more.
- **The return is a proposal.** Nothing the recipient changes reaches the books until the sharer
  takes it over, and a filed quarter stays as filed on both sides.
- **New things to run:** the service, its e-mail sending, the download page, and the app's URL
  scheme. Until the app is signed with an Apple Developer ID, the page must walk the recipient
  through «Dennoch öffnen» in the system settings.
