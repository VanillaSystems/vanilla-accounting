# Automated Receipt Collection

Quarterly VAT accounting requires gathering receipts from email and vendor portals.
This document describes the design decisions for automating that process. To set up a
mailbox for the first time (mail.yaml, app passwords, the app's .env), follow
[Set up a mailbox for receipt collection](../mail-setup.md).

## Vendor Quick Index

The company's own mailboxes and its private suppliers are in the workspace runbook,
`docs/company/receipt-collection.md`.

Jump straight to a vendor's procedure under [Vendor-Specific Notes](#vendor-specific-notes):

- [FedEx](#fedex) — billing mail goes to the address on the FedEx account (which inbox: the workspace runbook); Zollrechnung vs Frachtrechnung; Gutschriften (CNCHY…) are the receipts for FedEx refunds; inline PDFs missed by IMAP `bodyStructure`, BillingOnline "Zahlungsreferenz" emails map invoices to Wise charges
- [UPS](#ups) — **no invoice in any mailbox**: a Raiffeisen "Zahlung UPS United Parcel Service" is a paper QR-bill (scan it) or the UPS Billing Center (not kept logged in); tracking mails only tell you which inbound parcel it was
- [DHL Express](#dhl-express) — Zollrechnung splits like FedEx, but carries **two MWST codes on one invoice** (Z = 0% pass-through import VAT, E = 8.1% on DHL's own fees); header `MWST Nummer:` is blank while the real UID sits in the footer; scanned PDF (no pdftotext); some DHL sales mails attach **marketing brochures that are not receipts**
- [Amazon.de](#amazonde) — no email invoices, scrape order history popover; **the "Order Summary" print page is NOT the invoice** — it has no VAT proof
- [AliExpress](#aliexpress) — only the **"Tax Invoice" PDF** (CHE-447.613.666, explicit 8.1%, saved `{orderId}_payment.pdf`) is valid VAT proof, and it's only available for some orders; the "Receipt" button's **"Order Summary"** (`{orderId}.pdf`) has NO VAT — do not file it; else fall back to the 3-page screenshot capture; AliExpress may issue no Tax Invoice for an account at all (check with the invoice API, don't wait for one)
- [Digitec / Galaxus](#digitec--galaxus) — shared SSO login, check both platforms
- [OpenAI / ChatGPT](#openai--chatgpt) — subscription billing vs API billing are separate; must click through to the Stripe "Download invoice" PDF, not screenshot the summary card — charges Swiss MWST 8.1%
- [Anthropic](#anthropic) — captured via Stripe email, no scraping needed
- [Swiss Post](#swiss-post) — skip S/MIME attachments, keep Kundendoppel PDFs; card-paid parcel-label receipts (`Post Billingonline`) are not mailed, download them from the SwissID label service
- [Shopify](#shopify) — order pages, monthly billing statements, and Payments MWST invoices (three separate scrapes) + payout detail pages for payouts with refunds of other orders
- [Stripe (general)](#stripe-general) — invoice+receipt pairs from vendor-prefixed addresses
- [Google Cloud](#google-cloud) — monthly invoices, collect even zero-balance ones
- [Google Ads & other Google services](#google-ads--other-google-services) — **not in any mailbox**: Ads statements live in the Ads account's billing documents (which Google account: the workspace runbook), tax invoices of other Google services in the Google payments centre; a charge on the 1st pays the previous month's ending balance
- [Infomaniak](#infomaniak) — mails go to the account's login address, which a To-filter on an alias can miss; the invoice PDF link in the "receipt of your payment" mail downloads without login
- [VistaPrint](#vistaprint) — the "Rechnung mit Steuerausweis" mail has **no PDF**; portal only, Google SSO
- [EIN Presswire](#ein-presswire) — order confirmation has no PDF; invoice in the portal; the Distribution Report is NOT the invoice
- [DataForSEO](#dataforseo) — billed through FastSpring (`FS *Dataforseo`), no receipt mail at all; portal only. The monthly "SEO keyword report" PDFs are Wincher, not DataForSEO — noise
- [Webshops that attach a return slip](#webshops-that-attach-a-return-slip) — invoice + duplicate Retourenbeleg (dedup handles it)
- [tutti.ch](#tuttich) — private sellers, paid in cash/TWINT by the owner; the chat is the receipt; `npm run tutti`
- [Swiss UID present but 0% charged](#trap-a-che-number-does-not-mean-swiss-mwst-was-charged) — thomann.de shows a CHE number AND 0% MwSt

## Browser Automation via Aside (learned 2026-10-01, Q3 collection)

Webshop scraping runs through the Aside CLI (`aside` on PATH), which drives the real
browser with the user's existing logged-in sessions. `aside exec "<prompt>"` starts an
autonomous browser-agent session; several can run **concurrently**, one per vendor, which is
how a quarter's portals get collected in parallel. Aside and gstack `browse` are the
browser-automation tools used here; any Playwright-style driver with a signed-in profile works
the same way. The vendor notes below describe the pages, not the tool. Three hard-won constraints:

- **Sessions are sandboxed and CANNOT write into this repo.** Under the default Guard
  permission a session may only write inside its own session root. Any attempt to write to
  `beleg-import/` fails with `Path escapes Project and session roots` and `cp` fails with
  `Operation not permitted`. Tell each session to save into **its own session artifacts
  directory**, then copy the files out from the Claude Code side:
  `~/.aside/u/*/sessions/*/artifacts/*.pdf` → `beleg-import/`, skipping
  anything byte-identical to a file already staged or archived (the same file often appears in
  both a parent session and its subagent's session).
- **"The agent said it saved it" is NOT evidence.** A Q3 session reported three invoices as
  "staged … intact" with byte counts; none existed on the real filesystem — they were inside
  its sandbox. Always confirm against the actual path before counting a vendor as collected,
  and re-verify the artifact rules (CHE number, 8.1% line) on the copied file.
- **Ephemeral sessions are cleaned up — `aside session resume <id>` then fails with
  `Session not found`.** So (a) copy artifacts out promptly rather than at the end of a long
  pass, and (b) if a blocked session (e.g. awaiting a login) has since been reaped, start a
  fresh one instead of trying to resume.

**Mail: browser login ≠ IMAP access.** Being signed in to a mailbox in the browser does nothing
for `npm run collect`, which authenticates over IMAP with an app-specific password. If IMAP
LOGIN hangs or fails while the IMAP host is reachable and the other mailboxes work,
the app password is stale — mint a new one. As a fallback when no app password is available,
a webmail's receipts can be collected through an Aside session instead, with
the same artifacts-copy-out dance as any other vendor.

## Interaction Model

Collection is an **interactive Claude Code session**, not a standalone script.
The user starts a conversation and says "collect receipts for Q2 2026".
Claude orchestrates the steps: fetching emails, classifying them, downloading PDFs.
The user is present to handle 2FA, CAPTCHAs, and login prompts as needed.

## Step-by-Step Process (for future quarters)

### 1. Fetch email summaries

Check that every mailbox logs in (`npm run doctor -- --mail`), then run the IMAP fetch across
the workspace's mailboxes (`mail.yaml`) for the target quarter:

```
npx tsx src/collect/test-imap.ts 2026-Q3   # the quarter; default: the current one
```

(Or Claude runs the fetch inline during the session.)

This produces a sender-domain breakdown of all emails in the date range.

### 2. Filter a mixed mailbox by sender domain

A mailbox marked `mixed: true` in the workspace's `mail.yaml` (a personal address, say) holds
business and private mail. Business-only mailboxes need no filtering.

The sender lists are in `mail.yaml` (read by `src/collect/mail-config.ts`):

- **skipDomains** — definitely private/irrelevant (real estate, personal travel, newsletters, social media, etc.)
- **includeDomains** — definitely business (SaaS invoices, suppliers, shipping, banking)
- **Ambiguous** — anything in neither list. Claude classifies per-email using subject + sender,
  against what the company buys (`company.business` in `belege.workspace.yaml`).

When new domains appear, Claude classifies them and the user confirms.
Add newly confirmed domains to `mail.yaml` after each quarter.

### 3. Classify ambiguous emails

For emails from ambiguous domains, Claude reads subject + sender and decides:
- Receipt/invoice/order confirmation → collect
- Marketing/newsletter/notification → skip
- Unclear → ask user

### 4. Download receipts

Three paths depending on email content:

1. **PDF attachment** — save directly to `beleg-import/`
2. **Link to invoice/receipt page** — open in headed browser (gstack `/browse`), download PDF
3. **Email body is the receipt** — render in headed browser, print to PDF, save to `beleg-import/`
   - **Gotcha**: printing before the page finishes loading produces a broken, essentially blank PDF (~1.4-1.9KB, no extractable text, single page). Shopify order, payout and bill pages print this way when rushed. A legitimate minimal text-only receipt is still ~8KB+, so treat anything under ~2KB/page as suspicious — verify with `pdftotext` (should return text) before trusting the file. Wait for full page load before printing.

### 5. Webshop scraping (fill gaps)

After email phase, visit vendor portals one by one to collect receipts
not available via email. Uses gstack headed browser.

Key reasons to scrape webshops:
- AliExpress: VAT amounts only shown in logged-in invoice exports
- Amazon: some invoices not emailed
- Digitec/Galaxus: invoice PDFs in order history

### 6. Run existing pipeline

```
npm run extract    # text extraction + SHA-256 dedup
npm run match      # LLM classification (claude, via src/llm/ask.ts) + rename + move to receipts/
```

### 7. Phone scan PDFs (iOS app)

Receipts scanned via the iOS app and uploaded to `beleg-import/` are large (~2-5MB) — compress with Ghostscript before LLM processing:

```
gs -sDEVICE=pdfwrite -dNOPAUSE -dBATCH -dQUIET -dPDFSETTINGS=/screen -dColorImageResolution=150 -dGrayImageResolution=150 -dMonoImageResolution=150 -sOutputFile=out.pdf in.pdf
```

~57% size reduction; 150 DPI is sufficient for text recognition.

**Warning**: downscaling changes the file's SHA-256, which changes its receipt ID — `extract.ts` will treat it as a new/unknown file and any existing mappings for the old ID get cleaned up. Fix: after downscaling, re-stage the affected receipt (copy back into `beleg-import/`, set `location: 'staged'` in the index) and re-run `npm run match`.

## Two Phases

### Phase 1: Email

Scan every mailbox of `mail.yaml` via IMAP for the requested date range.
Claude classifies each email in-session (no per-call API costs).
This phase discovers receipts across all vendors — no hardcoded vendor list.

### Phase 2: Webshop Scraping

After email, fill gaps by visiting vendor portals one at a time.
Uses gstack headed browser. Claude drives navigation, user handles auth challenges.

Vendors to cover (non-exhaustive; the login of each is in the workspace runbook):
- amazon.de
- digitec.ch, galaxus.ch
- aliexpress.com
- Anthropic billing portal
- OpenAI billing portal

## App-Specific Password Setup (Gmail, iCloud and similar)

**SECURITY: Create before each collection run, revoke immediately after.** Where each
provider's app-password page is: [mail-setup.md](../mail-setup.md).

Before collecting:
1. Open the provider's app-password page (Google: https://myaccount.google.com/apppasswords)
2. Name it "vanilla-accounting-collect"
3. Copy the generated password
4. Put it into the keychain, typed without echo: `npm run secret -- source:<env>:mail` (the
   `env` prefix of that mailbox in mail.yaml, in small letters)
5. `npm run doctor -- --mail`: every mailbox shows ✓ logs in

After collecting:
1. Open the same app-password page
2. Delete the "vanilla-accounting-collect" app password
3. Remove it from the keychain: `npm run secret -- source:<env>:mail --delete`

**Claude: always remind the user to revoke the app password after the collection run completes.**

## Date Range

Explicit date range via `--quarter` shorthand:
- `--quarter 2026-Q2` expands to `--from 2026-04-01 --to 2026-06-30`
- Or explicit: `--from 2026-04-01 --to 2026-06-30`

## Code Location

Utility functions in `src/collect/` within the app repo:
- `imap.ts` — IMAP connection, email fetch, quarter parsing
- `mail-config.ts` — the workspace's `mail.yaml`: mailboxes and sender classification (skip / include / ambiguous)
- Attachment extraction from email
- Email-body-to-PDF conversion
- URL extraction from email HTML body

These are library functions invoked by Claude during interactive sessions,
not CLI entry points in `package.json`.

## Pipeline

```
collect (interactive session)
  -> PDFs land in beleg-import/
    -> npm run extract (text extraction + dedup)
      -> npm run match (LLM classification via src/llm/ask.ts; rename + move to receipts/)
```

## Vendor-Specific Notes

### FedEx
- **Invoice emails** come from `billch@fedex.com` — PDFs are inline attachments NOT detected by IMAP `bodyStructure` (no `disposition: attachment` header). Must fetch full email source to find them.
- Two invoice types: **Zollrechnung** (customs/duties) and **Frachtrechnung** (freight). Freight invoices often bundle multiple shipments.
- `PENDINGEVV@fedex.com` emails are customs clearance documents (CLRE export declarations from BAZG).
- `message.fedex.com` is marketing — skip.
- **Matching to transactions**: each Zollrechnung splits into three journal entries — Zölle (4020), Import-MWST (4030), Vorlageprovision (4040). Frachtrechnungen bundle multiple orders on one invoice, so match by total amount, not per-order.
- FedEx charges hit the Wise EUR account (card default), with the CHF amount converted to EUR. To link the invoice to the correct Wise transaction, cross-reference the original CHF amount shown on the Wise monthly PDF statement (not the converted EUR booking amount).
- **`BillingOnline@fedex.com` emails are the key to grouping invoices per charge** (subject: "FedEx Billing Online - Zahlungsreferenz Nr."). Each one lists the exact invoice number(s) and amount(s) that make up a single automatic payment on a given date, e.g.:
  ```
  Rechnung Nr.    Betrag
  2-xxx-xxxxx     <amount> SFR
  ```
  It also states the payment date and the payment profile used (e.g. "WISE '<nn>" — last two digits of the Wise account/card). Search the mailbox for "Zahlungsreferenz" to find these. Use the invoice number(s) + total amount + date to identify exactly which Zollrechnung/Frachtrechnung PDFs belong to one Wise transaction *before* trying to match by amount alone — this removes the guesswork for bundled Frachtrechnungen.

- **Where**: every FedEx billing mail — invoices, Zahlungsreferenz, Gutschriften, query answers — goes to the e-mail address on the FedEx account, so look in that one mailbox.
- **Invoice arrives after the charge**: the card is charged on the Zahlungsreferenz date, but billch@ can mail the PDF up to two weeks later. Read the invoice number off the Zahlungsreferenz mail (printed with dashes: `2-xxx-xxxxx` is the nine-digit invoice number).
- **Credits**: a FedEx refund (a CRDT card transaction, which on a Wise card lands on the **CHF** account) has a Gutschrift PDF mailed by billch@ as "Ihre FedEx gutschrift <invoice no>" (`CNCHY…_copy.pdf`); stage it as `YYYYMMDD-fedex-gutschrift-<cnchy>-zu-<invoice>.pdf`. It names the invoice it credits — book the refund against that invoice's positions, not a lump 4010. A credit not paid out stays as balance on the FedEx account.

### UPS

Learned 2026-10-08, from a Raiffeisen QR-bill payment to UPS.

- No UPS invoice reaches any mailbox. UPS mails are tracking (`pkginfo@`/`mcinfo@ups.com`), one-time codes, developer-portal and sales-rep mails — all noise for receipts.
- A Raiffeisen "Zahlung UPS United Parcel Service (Schweiz) AG" with a QR reference is a **paper QR-bill**: import duties/VAT on an inbound parcel (UPS delivers, then bills the consignee) or, for a UPS account holder, an account invoice. Scan the paper; otherwise the UPS Billing Center (`billing.ups.com`) — the browser session is not kept logged in there, so the owner must log in (never type credentials).
- Use the tracking mails to pin down which import it was: they name the shipper ("From <SHIPPER>") and the 1Z number.
- "VEREINBARUNG" PDFs are the account contract — supporting, not receipts.

### DHL Express

Structurally the same split as a FedEx Zollrechnung, but with traps of its own. Verified
2026-10-01 against a `DBX…` duty invoice.

- **Two invoice streams, like FedEx**: *Transportrechnungen* (freight) and
  *Zoll-/MWST-Rechnungen* (customs/import VAT + clearance fees) are billed separately and
  come from different addresses. Per DHL's own contact sheet, Zoll-/MWST invoice numbers
  begin with `BSL`, `GVA`, `LUG` or `ZRH`; the one on file is a `DBX…` duty-billing number.
  Invoice queries go to `vatquery.ch@dhl.com`.
- **One invoice, TWO MWST codes — this is the important bit.** The `MWST im Detail` table
  splits the invoice into two tax blocks that must be booked differently:

  | Code | Meaning | Rate | Example |
  |---|---|---|---|
  | `Z` | pass-through: Einfuhrzoll + the import VAT DHL paid for you | 0.0% | `MwSt / TVA / IVA` line |
  | `E` | DHL's own service fees, Swiss MWST charged | 8.1% | fees → 8.1% MWST on them |

  So one invoice reads: Einfuhrzoll, Einfuhr-MWST (code Z), Kosten Zusatzleistungen plus their
  MWST (code E), and the total.
  The `Zusatzleistungen im Detail` block itemises the fees (Gedruckte Rechnung,
  Kontoabwicklungsgebühr, Vorlagegebühr).
- **Paper, not mail**: the DBX Zollrechnung comes by Post with a QR-bill (paid from Raiffeisen); only the scan exists. A second scan of the same DBX number (sometimes with the shipper's invoice stapled behind it) is a duplicate.
- MyDHL+ waybill/transport-label PDFs ("Confirm DHL Express Shipment Pickup" mail) are supporting documents of a shipment we sent; the blank "Letter of Acceptance" form from vatquery.ch@ is noise.
- **Booking** follows the FedEx Zollrechnung pattern — one invoice splits into separate
  journal entries: Zölle (4020), Import-MWST (4030), Vorlageprovision / clearance fees (4040).
  The code-Z Einfuhr-MWST is **Einfuhrsteuer**, not ordinary Vorsteuer — it belongs to the
  import-VAT Ziffer of the return, while the code-E MWST on DHL's fees is ordinary Vorsteuer (8.1%).
  Do not merge the two into one 8.1% entry.
- **Trap: the header `MWST Nummer:` field is EMPTY.** Reading only the header makes the
  invoice look like it carries no Swiss MWST. DHL's UID is in the page footer:
  `DHL Express (Schweiz) AG … UID: CHE-105.901.000, CHE-116.304.564 MWST`. Check the footer
  and the `MWST im Detail` table before assigning a zero VAT code.
- **The PDF is a scan** — it carries no text, so `extract` falls back to
  claude-vision/OCR. Expect it to arrive as an image PDF and budget for the OCR pass.
- **Official customs proof**: page 2 carries the `Deklarationsnummer` and an `EVV Code`
  (access code). The electronic assessment decision (eVV) can be downloaded at
  <https://e-dec-web.ezv.admin.ch/edecZugangscodeGui> with those two values — worth pulling
  for the audit file, since the DHL invoice itself is only DHL's bill, not the BAZG decision.
  Changes/objections are only accepted within 30 days of the clearance date.
- **Trap: some DHL sales mails attach marketing brochures, which are not receipts.** Mails
  from DHL sales (`…@dhl.com`, subject "DHL-Express") can attach a price brochure and a contact
  sheet. They are sales material with no amount and must be given confidence 0 / not filed as
  receipts.

### Amazon.de
- Invoices are NOT emailed as attachments. Must log into amazon.de order history.
- Each order has an "Invoice" popover link → reveals download URLs like `amazon.de/-/en/documents/download/{uuid}/invoice.pdf`.
- Direct `download` via browse fails (503/timeout). **Working method**: `goto` the PDF URL, then `pdf` to save. The browser session cookies handle auth.
- Orders often have multiple invoices (one per seller/shipment within the order).
- Login requires password + potential 2FA. Use headed browser, hand off to user.
- **Invalid-artifact trap: "Order Summary" ≠ invoice.** The order-history "Order Details" page (URL pattern `.../gp/css/summary/print.html?orderID=...`) prints a page starting `Order Summary` / `Order Details` with a line `Estimated VAT: €X.XX` and no Swiss VAT ID anywhere. This is a rough estimate, not proof Swiss MWST was charged — it does **not** justify a VAT refund. The real invoice is the per-seller "Rechnung" PDF from the "Invoice" popover link, which shows `Rechnungsnummer` + `USt-IDNr. CHE-269.567.571 MWST`. A single multi-item order can split into several such invoices (one per seller), so grab all of them, not just one.
  - An order-summary page filed as a receipt is often a harmless duplicate (the real per-seller invoices are archived too and sum exactly to the order total), but it can be a genuine gap: only the order-summary page was captured, no real invoice. Don't assume a flagged file is a harmless duplicate — check whether the real per-seller invoice is actually archived before deleting.
  - `npm run extract` now auto-detects this pattern (`Order Summary` + `Estimated VAT` + no `CHE-...` UID) and sets the receipt's `remarks` to a warning (shown in the UI) plus prints a `⚠ N receipt(s) flagged: no VAT proof` summary at the end of the run — check that list after every extract pass.
- **One card charge per ORDER, at the order date** (learned 2026-10-08, Q3). Group invoices by `Bestellnummer` before matching: the invoices of one order sum exactly to one charge dated on/just after the `Bestelldatum`, even when their Rechnungsdatum is days later; two orders placed the same day can share one charge. Invoices linked by their own date to one charge can, by order number, belong to two or three different charges.
- **Invoice/credit-note links without clicking**: `https://www.amazon.de/your-orders/invoice/popover?orderId=<order>` lists `Invoice 1..n` and `Credit note`. In `aside repl`, `fetch()` the link and `await fs.writeFile('./artifacts/x.pdf', Buffer.from(await r.arrayBuffer()))` (`fs` is the promise API — `fs.mkdirSync` is "not a function"), then copy from `~/.aside/u/0/sessions/<id>/artifacts/`. Each `aside repl "…"` call is a fresh session: open the tab and read it in the same call.
- **One download can hold several invoices.** A download once carried a second, small invoice on its page 3, which was the "missing" rest of a charge. Check every page for another `Rechnungsnummer` and split it out with `pdfseparate`.
- **Refunds**: a customer return of an Amazon-EU-sold item gets a Gutschrift on the popover ("Credit note"). A refund without one (an ordinary refund, or a "Goodwill Refund / Account adjustment" on an already-returned order) is documented only by the `payments-messages@amazon.de` "Refund on order …" mail — print it from Gmail's print view (`/mail/u/0/?view=pt&search=all&permmsgid=msg-f:<id>`). `rueckgabe@amazon.de` "Your refund for …" mails can repeat for one refund; count bank lines.

### AliExpress
**There are TWO different "invoice-like" downloads on AliExpress. Only one is valid VAT proof — do not confuse them.**

- **VALID — the "Tax Invoice" PDF** (what we need): single-page, headed **"Tax Invoice"**, `Marketplace Operator: Alibaba.com Singapore E-Commerce Private Limited / CHE-447.613.666 MWST`, with a per-line **Tax Rate 8.1%**, an explicit **Tax Amount**, and the Art. 20a note. They are ~38 KB, 1 page, saved as `{orderId}_payment.pdf`. This is the only artifact that justifies I81/M81.
- **INVALID — the "Order Summary" PDF from the "Receipt" button** (looks official, is NOT VAT proof): the order-detail "Receipt" button opens the tax-ui iframe (`/p/tax-ui/index.html?orderId=...`) → "Download" → saves `{orderId}.pdf`. Verified 2026-07-03: this PDF is headed **"Order Summary"** and contains **no CHE number, no tax rate, no tax amount** — the underlying API is literally `mtop.global.finance.taxation.nonTax.receipt.downloadReceipt` ("**nonTax**"). Filing it silently loses the VAT deduction. (This confirms the original "Receipt button has no VAT" warning — an earlier edit wrongly claimed the Receipt button now yields a Tax Invoice. It does not.)

**Availability is the catch.** The Tax Invoice is only downloadable for *some* orders and appears to depend on tax-settlement/age, not order status:
- The "Receipt" button itself is present on only some orders and absent on many completed ones, including orders that do have a Tax Invoice.
- Where it is present, it yields the invalid Order Summary. When no order of a quarter offers a downloadable Tax Invoice, the completed orders are collected as the **reconstructed evidence PDFs** described below; an order still Awaiting delivery waits for a later pass.

**Booking (a company decision):** a company can treat a reconstruction as enough to claim the
input tax, M81/I81, exactly as with a Tax Invoice. Page 3, the hover popover with "VAT: … included",
proves that Alibaba (CHE-447.613.666) charged the tax. MWSTG Art. 81 Abs. 3 says input tax may not
depend on one specific kind of document. Private items are still not claimed. Record the decision
as a rule in the workspace's `knowledge/suppliers/aliexpress.yaml`.

**Decision rule — per order:**
1. Try to obtain the **Tax Invoice** PDF. Whatever you download, VERIFY it contains `Tax Invoice` + `CHE-447.613.666` + a tax amount before filing. If it says "Order Summary" / has no CHE number, it is the invalid artifact — discard it, do not file it.
2. If no Tax Invoice is available, build the **3-page reconstructed evidence PDF** (the resilient method, used for the Q2 2026 batch on 2026-07-03). AliExpress states the VAT *amount* on the order page but NOT the rate ("8.1%" appears nowhere in the page source), so the rate is derived from the amount and verified. Per order:
   - **Extract figures from the DOM** (deterministic, no screenshot race): order ID, dates, item, `Subtotal`/`Total`. There are two `.comet-icon-help` icons — index 0 is delivery, index 1 is the VAT one (its `closest('div')` text contains "VAT included"). Dispatch `mouseover`/`mouseenter` on icon 1, wait ~1.3s, then read the VAT amount from `.comet-popover-content` (text `VAT: CHF X.XX`).
   - **Verify 8.1%**: net = total − vat; the stated VAT must equal `round(net * 0.081, 2)` within 1 rappen (compare in integer rappen, not floats — on small amounts the back-computed rate can read below 8% and still IS 8.1%). If it does not match, FLAG the order and do not file — do not silently write a wrong rate.
   - **Capture two element screenshots** (`screenshot --selector`, NOT full-viewport — in the headed GStack browser a full-viewport clip can grab the wrong tab): (a) the order card — hide `.order-recommend` first to drop the "More to love" clutter, then shoot `.order-wrap`; (b) the VAT popover — re-hover, mark the visible `.comet-popover` containing `VAT:` with a `data-shot` attr, shoot `[data-shot='1']`.
   - **Render a 3-page PDF** (`browse load-html` + `pdf --format a4 --print-background`): page 1 = reconstructed summary (figures + `VAT rate 8.1%` + the `8.1% of net = CHF X, matches CHF Y ✓` check line + `CHE-447.613.666` + Art. 20a note, all as real text so `pdftotext` finds "8.1%"); page 2 = order screenshot (items + price paid); page 3 = VAT popover screenshot (explicit amount).
   - **Verify before moving on**: `pdftotext <pdf> | grep 8.1%` must hit. Only then proceed to the next order.
   - The one-off scripts for this batch (`extract-all.js`, `hover.js`, `mark.js`, `gen.js`, `driver.sh`) were in the session scratchpad; the steps above are enough to reproduce them. The generated PDF is clearly labeled "reconstructed … the 8.1% is derived from the VAT amount AliExpress states" — it is weaker proof than a real Tax Invoice, so check the invoice API (below) for a real Tax Invoice and replace the reconstruction if one exists. (An earlier note said Q1 invoices "appeared ~2–5 months after the order" — wrong: the invoice records are dated the payment day; the PDFs were merely downloaded in late May.)
   - Orders **Awaiting delivery** show no finalized CHF total/VAT and cannot be captured this way — leave them for a later pass.
   - **One PDF per order; never file the plain no-VAT order-summary screenshot as a separate receipt.** A Q2 pass left both the valid capture *and* the plain no-VAT "Receipt button" screenshot for the same order — the plain one is the invalid-artifact trap.
**Reconstruction via `aside repl` — the working recipe (Q3 2026).**
No Aside agent credits needed. Driver: a Python script that templates the JS and shells out to
`aside repl`; the repl sandbox cannot write into this repo, so the PDF is written into the
session dir and copied out. Four things that each cost a debugging round:

1. **Orders are NOT all in CHF.** Most orders of a quarter can be USD-denominated — the page shows
   `Subtotal → US $<amount>` and the popover `VAT: US $<amount>`. An extractor that requires `CHF`
   returns null for all of them. Match any of `CHF | US $ | USD | EUR | €`, and note the amount
   usually sits in a **sibling node**, not the label's own element, so a single-element regex
   also fails — walk `nextElementSibling` (up to 3) then fall back to the parent's text.
2. **Verify the rate in the ORIGINAL currency**, in integer cents: `net = total − vat`, and
   `round(net * 0.081)` must equal the stated VAT within 1 cent. Then print an *indicative* CHF
   equivalent at the ESTV daily sell rate, clearly labelled, and state that the authoritative
   booking rate is the one on the **payment** date (MWSTG Art. 24, cash basis) — do not let the
   evidence PDF assert a CHF figure `classify` will legitimately compute differently.
3. **`file://` navigation is blocked** in repl (`Cannot navigate to a file URL without local file
   access`), so the 3-page document cannot be rendered from a local HTML file. Instead
   `openTab('about:blank')` and `page.evaluate(h => { document.open(); document.write(h); document.close(); }, html)`,
   with the screenshots inlined as **base64 data URIs** (`<img src="data:image/png;base64,…">`)
   since file-backed `<img src>` will not load either.
4. **`locator.screenshot()` refuses the VAT popover** (an absolutely-positioned wrapper). Retry
   the hover-and-mark a couple of times, then fall back to reading the popover's
   `getBoundingClientRect()` and taking `page.screenshot({ clip: rect })`. Without that fallback
   page 3 silently goes missing and the evidence is weaker than it needs to be.

Verify every PDF post-hoc for `8.1%` **and** `CHE-447.613.666` in the extracted text. Note that
some items can be private purchases: having the evidence does not mean claiming the Vorsteuer, those want Eigenverbrauch.

**Is there a real Tax Invoice? Ask the invoice API (learned 2026-10-08).** No page shows a
Tax Invoice button any more — not the order list, not the order detail, not the "Beleg" tax-ui
(which only ever offers the "Zusammenfassung"/Order Summary), and the wallet's "Karten
transaktion" tab wants a phone verification first. But the tax-ui bundle
(`assets.aliexpress-media.com/g/ae-dida/tax-ui/…/index.js`) defines read-only mtop calls that
answer the question deterministically. On `https://www.aliexpress.com/p/tax-ui/index.html?orderId=<id>`
run in `page.evaluate`:
`window.lib.mtop.request({needLogin:true, api:'mtop.global.finance.taxation.invoice.getInvoiceInfoListByType', type:'POST', v:'1.0', ecode:1, data:{orderId, shipToCountry:'CH', _lang:'de_DE', timeZone, clientPlatform:'pc', invoiceType:'INVOICE'}})`.
- An order with a Tax Invoice returns `invoiceInfoDTOList[0]` with `invoiceNo` (`CH01223…`),
  `invoiceDate` (= the payment day) and `invoiceStatus: GENERATED_SUCCESS`; an order without one
  returns `data: {}`.
- Older orders can have invoice records while **an account can get none at all** from some
  date on. Waiting does not help: the invoice is issued on the payment
  day or never. The reconstruction is the final
  evidence for those orders.
- Downloading an existing invoice through `getInvoiceFileContent` (with `invoiceId`/`invoiceNo`)
  currently fails with `InvoiceRouteException: zone is empty`.
- `mtop.global.finance.taxation.invoice.queryOrderReceiptInfo` (same data) returns
  `includedTaxDisplay` (e.g. `US $0.21`) — the VAT amount without the hover race; use it to
  cross-check the popover. Never call `applyInvoiceToSeller` / `sendReceiptFileMail` (they write).

**Screenshots in `aside repl`.** `locator('.order-wrap').screenshot()` returned only the viewport-sized top of the
card (no items, no total), and `page.screenshot({clip})` used mismatched coordinates. What worked:
hide `.order-recommend`, set `document.body.style.zoom = '0.6'`, `scrollTo(0,0)` — the whole
order card (address, order date, items, Zwischensumme/Gesamt, "mit MwSt.") then fits the
1440×900 viewport, so a plain `page.screenshot()` is page 2, and the same shot after hovering
the "mit MwSt." help icon (popover `MwSt.: US $0.21`) is page 3. Repl quirks: there is no
`page.waitForTimeout` (use `sleep`), `fs` is the promise API (`await fs.mkdir(pwd+'/artifacts',
{recursive:true})` before writing), `pwd` is a string, and each `aside repl` invocation is a new
session dir.
**Always verify page 3 by LOOKING at the rendered image before filing**
(`pdftoppm -f 3 -l 3 -r 150 -png`, then open it): the order number, "Gesamt" and the popover
"MwSt.: <amount>" must be readable and equal page 1. Text checks (`8.1%`, CHE) pass on a broken
PDF whose page 3 shows only the header bar.

- Cookie consent popup may block interaction — accept cookies first.
- Login: the account's e-mail (workspace runbook), password + verification required. Use headed browser. The header shows only the start of the address and the settings page hides it behind "E-Mail-Adresse ändern"; the logged-in session's login cookie carries the full address.
- **Always drop captured PDFs into `beleg-import/` and run `npm run extract && npm run match`, never save straight into `receipts/`.** `match.ts` only processes receipts whose index entry has `location: 'staged'`, which is set purely from which folder the file physically lives in. Files placed directly in `receipts/` are silently treated as already-archived and never get a transaction mapping attempt, even if perfectly named.

### Digitec / Galaxus
- Same login (digitecgalaxus.ch SSO).
- Order history at `digitec.ch/de/order` and `galaxus.ch/de/order`.
- Check both — orders can be on either platform.

### OpenAI / ChatGPT
- **API billing** (platform.openai.com) is separate from **ChatGPT subscription billing**.
- ChatGPT subscription invoices: `chatgpt.com/#settings/Billing` → "Billing history" list → click the row's date link ("Open invoice from ...") — opens a Stripe-hosted invoice page in a new tab.
- Login via Google OAuth. Hand off to user for Google password.
- `chatgpt.com` is behind Cloudflare bot detection — headless `browse` gets stuck on the "Verification successful, waiting to respond" interstitial forever. Use `browse --headed` and `cookie-import-browser chrome --domain chatgpt.com` (pulls an existing logged-in session from the real Chrome browser) instead of trying to log in headless.
- **Critical: do NOT stop at the Stripe summary card that opens in the new tab** (the one showing just "Invoice paid / CHF <amount> / Download invoice / Download receipt"). That card is a payment-confirmation widget, not the invoice — it has no line items and no VAT breakdown. A prior collection pass filed screenshots of this card as the receipt, which silently dropped the VAT detail (and made a legitimate zero-total invoice look like a broken capture).
- Click the card's **"Download invoice"** button — it fires a request to `invoicedata.stripe.com/invoice_pdf_file_url/...` and triggers a browser download of the real itemized PDF (`Invoice-XXXXXXXX-000N.pdf`), which shows subtotal, VAT line, and total. Grab the pre-signed S3 URL from `browse network` and pull it with `browse download <url> <path>` if the file doesn't land in `~/Downloads` automatically.
- OpenAI Ireland Limited **is** registered for Swiss MWST (its CHE number is on the invoice) and charges 8.1% inclusive on the subscription fee — use I81, not I0, once the real invoice confirms the VAT line.
- A **zero total is not automatically a capture bug** — check for a "1 Month Free Trial (100% off)" discount line on the real invoice before assuming the amount is missing.

### Anthropic
- Invoices arrive via **Stripe email** (from `stripe.com`) as PDF attachments — both Invoice and Receipt PDFs.
- Anthropic bills either through Stripe (Anthropic Ireland) or directly (Anthropic PBC, `mail.anthropic.com`); a company can have both.
- These are reliably captured in the email phase — no webshop scraping needed.

### Swiss Post
- `post.ch` tracking emails have `smime.p7s` attachments (S/MIME signatures), not PDFs — skip these.
- `avzbestaetig@post.ch` sends Kundendoppel (shipping receipts) as PDF attachments.
- `business.international@post.ch` sends compensation vouchers.
- **Card-paid parcel labels** (`Post Billingonline Zollikofen`, a few francs each): the "Quittung Paketetiketten
  Inland" PDF is **not mailed** to any inbox. Download it from "Versandetiketten Pakete Inland"
  (https://service.post.ch/vgkklp2/avgk/secured/Home/, SwissID login, not kept logged in
  in Aside). Match on the receipt's Auftragsdatum, which equals the card charge date; the Auftragsnummer
  (twelve digits, starting with the order date as YYMMDD) is not a date. The receipt shows Swiss Post's CHE number
  with 8.1% MWST included, so the code is I81.

### Shopify
- Monthly platform bills arrive as email attachments from `billing@shopify.com` — collected in email phase.
- **Individual order pages** must be scraped from the Shopify admin: `admin.shopify.com/store/<store>/orders/{id}`.
- These are sales records (revenue), not expenses. Needed for VAT classification (V81 for Swiss, V0 for exports).
- Login persists if the headed browser session is still active (uses Shopify session cookies).
- Orders list at `/admin/orders` shows 50 at a time. Extract order IDs via JS, then loop `goto` + `pdf` for each.
- Payout emails from `shopify.com` (named after the shop) are Shopify Payments settlement notifications — not needed as separate receipts since order pages cover the sales side.

#### Shopify order pages: THREE tax regimes, not two (found 2026-10-01)

The order page PDF is the authoritative per-order record and its `Taxes` line states which
regime applied. Orders fall into three buckets, and treating them as a simple
"V81 for Swiss, V0 for export" split is wrong:

| Bucket | `Taxes` line on the order page | Meaning |
|---|---|---|
| Swiss delivery | `Taxes  CHF<tax> • MwSt 8.1%  Included` | Swiss output tax — V81 |
| EU delivery | an EU VAT line, e.g. `€<tax> EUR • DE MwSt 19%` | **EU** VAT was collected, NOT Swiss |
| Rest of world | no `Taxes` line at all (orders in other currencies) | export, no VAT — V0 |

**The EU bucket is the trap.** Shopify collects German/French/etc. VAT at the destination rate
on those orders. That tax is **not Swiss output tax** and must never be booked as V81; the sale
is an export from Switzerland (zero-rated), and the EU VAT portion of the gross is not revenue.
Whether Shopify remits it as deemed supplier/IOSS or whether it falls to the company is a
question for the tax advisor — but it has to be separated out either way, because booking the
full gross as Swiss-taxable turnover would both overstate turnover and misstate the return.

The measured split is in the workspace runbook.

**`classify` cannot get this right on its own, and it fails in ESTV's favour.** Revenue is booked
from the *aggregated* Stripe/Shopify payout transactions ("Webshop Bestellung …, Kunde
unbekannt"), which carry no country or tax breakdown — so every revenue entry of a quarter can come
back **V0**, and the Swiss output tax of the Swiss orders is then **not** recognised. Understating output tax is
an error against the authority, so after every `classify` run: cross-check the order pages' `Taxes`
lines against the V-codes actually booked, and reallocate the Swiss portion to V81. The EU-VAT
orders stay zero-rated for Swiss purposes, but their EU VAT is not revenue
either — confirm with the tax advisor whether Shopify remits it as deemed supplier under IOSS.

**Each order page also carries the payout linkage**, which is how per-order fees are derived:

```
Paid                  €<gross> EUR (1 EUR = <rate>)    <- gross charged (CHF <price>)
"€<net> EUR was added to your <date> payout."           <- net reaching the bank
difference €<gross − net>                               <- Shopify's deduction
```

Caveat: that difference is **not** purely the transaction fee. Orders can be in several
currencies while payouts are in one, so the gap also absorbs currency conversion.
The authoritative fee figure for the Vorsteuer correction remains the monthly Shopify Payments
invoice (`Transaction Fees` + 8.1% VAT); the per-order difference is a useful sanity check, not
a substitute. Note also that the `Paid` line appears in two layouts — `€<amount>` for an
EUR-denominated order and `€<amount> EUR (1 EUR = …)` for a converted one — so any parser must
handle both.

#### Shopify payout detail pages: the breakdown of one "Shopify <ref>" deposit (found 2026-10-08)

Order pages alone do not explain a payout: a payout can also deduct a **refund of another
order** (at the refund date, not the order's payout), or carry the **second payment of an edited
order**. The authoritative breakdown is the payout detail in Admin → Finance → Payouts:

1. `admin.shopify.com/store/<store>/payments/payouts-next?view=<YYYY-MM-DD>` (deposit date)
   shows `Payout #<id>` with the Charges / Refunds / Fees summary. The list view only renders the
   last ~2 months and does not load more on scroll — use `?view=` for older dates.
2. `...payouts-next?view=<date>&payout=<id>&selectedView=all` adds "Details of Payout" — one line
   per Charge/Refund with Order, Charge, Fee, Net.
3. The rows are `BUTTON`s inside shadow roots (no hrefs; `getByText` fails). Open the URL
   directly in `aside repl`, `await sleep(11000)`, then `await page.pdf({path: String(pwd)+'/x.pdf'})`
   and copy out of `~/.aside/u/0/sessions/<id>/` to `beleg-import/<YYYYMMDD>-shopify-payout-<ref>.pdf`.

Example: a payout = order A + order B − refund of an older order C.

#### Shopify Monthly Billing Statements (apps + duty/import tax fees)
- Shopify is registered for Swiss MWST and charges 8.1% on fees.
- `<store>` is the store slug in the admin URLs (the workspace runbook names it).
- Billing page: `admin.shopify.com/store/<store>/settings/billing`
- Individual bill: `admin.shopify.com/store/<store>/settings/organization-billing/invoice/{bill_number}`
- **Export as PDF** process (requires headed browser — Cloudflare blocks headless):
  1. Navigate to the bill page
  2. Click "Export bill" button (top right of bill page)
  3. In the modal: Tab → Tab → ArrowDown to select "PDF" (the `s-choice` web components have zero-size bounding boxes, so Playwright can't click them directly — keyboard navigation is the only reliable method)
  4. Click "Export bill" button in modal footer
  5. PDF is emailed to the store owner's address

#### Shopify Payments Invoices (transaction fees — MWST proof for Webshop Gebühren)
- These are the monthly invoices for Stripe/Shopify Payments transaction fees deducted from payouts.
- Each invoice shows: Transaction Fees, Dispute Fees, Subtotal, VAT (8.1%), Total — with Shopify's CHE MWST number.
- These are NOT emailed. They must be downloaded from the Shopify admin.
- **Download path (CORRECTED 2026-10-01)**: the control is **not** called "Documents" — it is a
  button labelled **"Tax forms"** on Shopify Admin → Finance → Payouts, and it opens a dialog
  titled "Tax documents". It lives inside a **shadow root** (that page has hundreds of shadow hosts),
  so `document.querySelectorAll` does not see it and a text search for "Documents" finds
  nothing. Two autonomous browser-agent attempts wedged here with `CDP command timeout:
  Runtime.callFunctionOn` / `Page.enable timeout` hunting for the wrong label.
- **Reliable method — drive it yourself with `aside repl`** (Playwright-style JS, 120s per call,
  each call is a FRESH context so `page` resets and the whole flow must fit in one call; globals
  include `openTab`, `sleep`, `fs` (promise-based: `fs.writeFile`), `pwd` (a STRING, not a
  function), `Buffer`):
  1. `const p = await openTab('…/payments/payouts'); await sleep(9000);`
  2. Walk the shadow DOM recursively (`el.shadowRoot`) to find `BUTTON` with text `Tax forms`
     and `.click()` it.
  3. Walk the shadow DOM again collecting `A`/`S-LINK` hrefs matching
     `/payments/documents/<doc_id>` — that yields every monthly document id at once.
  4. For each id: `openTab` the document URL, then in-page
     `fetch(location.href, {credentials:'include'})` → base64 → write it out with
     `await fs.writeFile(String(pwd) + '/x.pdf', Buffer.from(b64,'base64'))`, and copy the file
     out of the session sandbox from the Claude Code side.
  Verify `content-type: application/pdf` and a plausible byte count before trusting a file.
- **Do NOT infer which month a doc_id is** — the ids are not evenly spaced. Download it and read
  the `Shopify Payments Invoice for <Month> <Year>` line.
- **Each monthly invoice is issued on the 5th of the FOLLOWING month** (June→Jul 5, July→Aug 5,
  August→Sep 5). So the last month of a quarter is never available at quarter-end: collecting
  Q3 on 1 October yields July and August, and September only appears ~5 October.
- Clicking "Download PDF" navigates to `admin.shopify.com/store/<store>/payments/documents/{doc_id}` which renders the PDF inline (content-type: application/pdf).
- **Saving the PDF**: `curl` does not work (Shopify auth cookies are httpOnly and session-bound). Instead, use the in-browser fetch approach:
  1. Navigate to the document URL in the headed browser
  2. Run in-browser JS: `fetch(window.location.href, {credentials: 'include'}).then(r => r.arrayBuffer()).then(buf => { const bytes = new Uint8Array(buf); let binary = ''; for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]); window.__pdfBase64 = btoa(binary); })`
  3. Extract: `browse js --raw "window.__pdfBase64" | base64 -d > output.pdf`
- June invoice is typically not available until a few days after month-end.
- **Collect the last month of a quarter after the 5th of the next month**, before the return
  is filed: an invoice missing at filing time leaves its input VAT unclaimed in a filed quarter,
  and then needs a correction entry in the open period (golden rule 1).
- **Booking approach (Option B — monthly correction):**
  - Per-order "Webshop Gebühren" entries use I0 (no per-order MWST proof).
  - One monthly correction entry claims the total MWST from the Shopify Payments invoice.
  - The monthly Shopify Payments invoice is the receipt for the correction entry.

#### Shopify API Automation (future improvement)

All three Shopify document types can be fetched programmatically via the Shopify Admin API, eliminating the need for a headed browser:

1. **Order PDFs**: The Admin API (`GET /admin/api/2024-01/orders.json`) returns full order data as JSON. A script could render order data to PDF locally, or use the `GET /admin/api/2024-01/orders/{id}/metafields.json` endpoint. Alternatively, the order page URL pattern (`/orders/{shopify_internal_id}`) is predictable from the order list.

2. **Billing cycle bills**: No public API endpoint. The `Export bill` flow sends a CSV/PDF to email. The bill page can be print-to-PDF'd via Playwright without a headed browser if Cloudflare is bypassed (stealth mode). The bill URLs follow the pattern: `admin.shopify.com/store/<store>/settings/organization-billing/invoice/{bill_number}`.

3. **Shopify Payments fee invoices (VAT documents)**: No public API endpoint. The document URLs (`/payments/documents/{doc_id}`) require an authenticated session. A Playwright script with persistent auth could automate: login once, iterate months on the Documents panel, collect document IDs, then fetch each via the in-browser technique above.

**Recommended approach for a `collect-shopify.ts` script:**
- Use Playwright (not headed — stealth mode sufficient) with persistent auth context saved to `~/.gstack/chromium-profile`
- Login interactively once per session, then automate all downloads
- Three passes: (a) scrape order list → save each order page as PDF, (b) scrape billing page → save each bill as PDF, (c) scrape Documents panel on Payouts → fetch each fee invoice PDF
- Output all PDFs to `beleg-import/` with consistent naming

### tutti.ch

- Second-hand items from private sellers (equipment, tools, samples). The owner pays in **cash or TWINT out of their own pocket** at the handover,
  so there is no bank row and no receipt. The chat with the seller is the record: it holds the
  offer, the agreed price and the pickup.
- **tutti keeps only recent chats** (a few months). Export every quarter, before it closes.
- Procedure (`src/collect/tutti.ts`):
  1. `npm run tutti -- export`: Aside opens `tutti.ch/de/messages/buying` in the logged-in
     browser, scrolls the list, and dumps every chat (one `aside repl` per chat, 120 s limit
     each) to `data/tutti/conversations.json`. Own messages are the list items with
     `justify-content: flex-end`; the seller's are `flex-start`. Old chats stay in the file
     after tutti drops them.
  2. `npm run tutti -- propose`: one model call per new or changed chat writes
     `data/tutti/purchases.json`: bought or not, item, asking price, agreed price, handover
     date, payment, the quoting messages, and a business/private suggestion.
  3. The owner sets `"business": true|false` on each bought item. Nothing is imported until
     a person decides.
  4. `npm run tutti -- import --apply`: per approved purchase, prints the chat to
     `receipts/YYYYMMDD-tutti-<item>.pdf`, creates a manual transaction (`M<year>-NNN`, CHF,
     dated on the handover), and links them. Then book: I0/M0, credit 2451.
- A purchase dated inside a filed quarter becomes a correction: `import` dates the
  transaction on the first open day and names the real handover date in the description
  (golden rule 1). The chat PDF keeps the real date.
- Booking: goods or samples to the material account (M0), equipment over ~CHF 150 to an asset
  account (I0), all credited to the owner's account; which accounts is the workspace's
  knowledge/suppliers/tutti.yaml. tutti is always paid by the owner first.
- Pickup with no price talk = bought at the listing price. If the listing is gone, the price
  is nowhere, so ask the owner.

### Trap: a CHE number does NOT mean Swiss MWST was charged

Vendors can be registered for Swiss MWST, print their `CHE-…` UID on the invoice, and still
charge **0%** — typically because the delivery was handled as an export/import. Grepping for a
CHE number is therefore **not** a valid test for I81/M81. Examples:

| Vendor | UID on invoice | Rate actually charged |
|---|---|---|
| thomann.de | yes | `0% MwSt` |
| swissmarketplace.group | yes | 8.1% |
| Google | yes | 8.1% |

Always read the tax line/rate, not just the UID. This is the mirror image of the
Anthropic/Shopify case where the UID is present *and* 8.1% really is charged — and of the
DHL case where the header UID field is blank but MWST was charged.

### Amazon invoice latency

Amazon exposes per-seller invoices only after shipment, so an order placed near the end of a
quarter can be collected while still partly uninvoiced: the invoices on file cover only part of
the charge. Re-check such orders a few days into the next quarter before declaring a gap.

### Stripe (general)
- Stripe sends invoice+receipt pairs as PDF attachments from various vendor addresses.
- The `from` address is the vendor (e.g., `invoice+statements@stripe.com` prefixed with vendor name), but the sender domain is `stripe.com`.

### Google Cloud
- Monthly invoices emailed from `payments-noreply@google.com` as PDF attachments.
- Zero-balance invoices are still sent and should be collected.

### Google Ads & other Google services
(learned 2026-10-08, Q3 collection) `payments-noreply@google.com` only mails Google Cloud invoices.
Google Ads and Google's consumer subscriptions send no PDF anywhere.
- **Google Ads** (`Google *Ads<account no.>`): the statements are in the Ads account's billing
  documents, under the Google account that owns that Ads account (which one: the workspace runbook).
  In Aside: ads.google.com → "Switch Google account" → the owning account → the Ads account → Billing →
  Documents → Download. The file lands in `~/Downloads` as `<payments profile id>_<YYYYMMDD>.pdf`; rename
  to `<YYYYMMDD>-google-ads-statement-<mon>-<yyyy>.pdf`.
- A monthly statement says "This is not a bill" but it is the only document there is: it lists the clicks,
  `VAT (0%)` and the payments. **A charge on the 1st pays the previous month's ending balance**: the
  charge of 1 July is the June statement's ending balance. Link each charge to the statement whose ending balance it pays. Mid-month threshold
  charges belong to their own month.
- The statements can be addressed to a person rather than the company and show 0% VAT. Whether Bezugsteuer is
  owed is decided by the booking guide (pv-bezugsteuer) or the advisor.
- **Other Google services** (`Google *<service>`): pay.google.com/gp/w/u/0/home/activity
  → click the row → "Download tax invoice". Each one is a Google Commerce
  Limited invoice with a CHE number and 8.1% shown, addressed to the account holder. The owner decides
  whether it is a business expense before any Vorsteuer is claimed.

### Infomaniak
- Mails go to the Infomaniak account's login address. A mailbox in `npm run collect` that filters on
  `To:` an alias never sees them (which address: the workspace runbook).
- "<Company>: receipt of your payment of CHF x" links the invoice as
  `https://api.infomaniak.com/2/invoicing/invoice/pdf/<token>`. A plain GET downloads the PDF with no
  login. Each payment has its own mail and invoice, even when two payments fall on the same day
  (a domain and a mail service, say).
- Infomaniak Network SA, CHE-103.167.648, always charges 8.1%, so the code is I81.

### VistaPrint
- "Ihre Rechnung mit Steuerausweis von VistaPrint – Bestell-Nr. VP_…" (no-reply@t.vistaprint.ch)
  has **no attachment**. The invoice can only be downloaded from the order's "Bestellinformationen" page.
- Login is "Mit Google fortfahren" with the business Google account. If that Google account is signed out in
  the browser, the owner signs in first. Never pick another Google account, because that creates a new,
  empty Vista account.

### EIN Presswire
- The "EIN Presswire Order Confirmation" lists the order number and
  `Payment amount: $X ($net + $tax tax)`, but has no PDF. The invoice is at
  einpresswire.com/account/invoices (not kept logged in in Aside).
- The "Press Release Distribution Report" (noreply@noreply.einnews.com) is supporting material, NOT the invoice.
- The tax on the confirmation can be exactly 8.1%. Use I81 only after the invoice PDF shows a CHE number.

### DataForSEO
- Charged as `FS *Dataforseo fsprg.nl`, with FastSpring as the merchant of record. No receipt mail turned
  up in any mailbox. The dataforseo.com mails are newsletters.
- The invoice has to come from app.dataforseo.com (password or magic-link
  login; not kept logged in). Read its VAT line, because FastSpring may charge Swiss VAT.
- The monthly `*-seo-keyword-report.pdf` / `<date>_wincher_report.pdf` files are the free
  **Wincher** rank-tracking report: no amount and no payment, so they are noise and not DataForSEO evidence.

### Webshops that attach a return slip
- Some webshops mail the invoice PDF together with a Retourenbeleg (which shops: the workspace runbook).
- Each order includes invoice PDF + Retourenbeleg (blank return slip template — ignore, confidence 0).
- The Retourenbeleg PDFs are identical across orders (same SHA-256) — dedup catches them.

## Matching Notes

- `npm run match` (`src/cli/match.ts`) is the primary path. It calls the model once per receipt through `src/llm/ask.ts`, the one way the app calls a model (ADR 0002); each call is logged in `data/llm-ledger.jsonl` under step `evidence.guide.yaml#ai`. The `MATCH_LLM=codex` switch is gone.
- Transaction matching requires camt053 bank statements for the quarter. Without them, receipts get renamed/archived but stay unlinked (confidence-based filename still applied).
- **Grouped vendors (AliExpress, Amazon, FedEx) bundle several receipts into one bank transaction** — a single receipt's amount can be a small fraction of the transaction total (e.g. two small AliExpress orders landing in one Wise card charge alongside other same-day orders). `match.ts` detects these vendors by keyword in the receipt text and matches by vendor-name-in-description instead of amount proximity for them; the ordinary ±30% amount filter only applies to non-grouped vendors. If a grouped-vendor receipt still comes back unlinked, check by hand whether it's part of a transaction another receipt from the same day already claims (sum the receipt amounts and compare to the transaction total) rather than assuming the LLM just failed.

## Gmail IMAP Gotchas

- Google may revoke/block app-specific passwords after many rapid IMAP connections. If auth fails mid-session, generate a new app password.
- The `imapflow` `bodyStructure` check for attachments misses inline PDFs without `disposition: attachment` (e.g., FedEx `billch@` emails). When in doubt, fetch full source for receipt-like subjects.

## Decisions Log

- Receipts normalized to PDF before entering beleg-import/ (existing pipeline unchanged)
- IMAP over Gmail API (uniform protocol across providers, simpler)
- Claude classification in-session (no extra API costs)
- No email-level dedup state (stateless, SHA-256 in extract handles it)
- Collection code lives in src/collect/ of this repo (separation of concerns)
- Headed browser for link downloads and email-to-PDF (already available via gstack, no extra deps)
- Email phase first, webshops second (discover what email covers before scraping portals)
- Per-vendor webshop scraping (independent, fix one without affecting others)
- Sender classification of a mixed mailbox: skip/include/ambiguous lists in the workspace's mail.yaml
- Business-only mailboxes need no filtering
- Ambiguous senders classified per-email by Claude in-session
