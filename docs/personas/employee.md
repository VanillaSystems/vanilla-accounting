# Employee (Mitarbeitende)

Anyone in the company who spends money for it: a fuel receipt, a parcel, a lunch with a client,
an online subscription. Not an accountant and not interested in becoming one. There can be
many.

## Jobs

- Hand in each receipt, soon after paying, with as little effort as taking a photo.
- Say what it was for when it is not obvious ("Material Projekt X", "privat bezahlt").
- Answer a question about a receipt when asked.

## How often

Whenever they pay; seconds each time.

## Technical level

Low to medium. They install an app from the App Store and scan a QR code once. The company
(the owner) does any further setup for them.

## Where they work

- **The receipt app on the phone:** scan, done. It uploads to the company's host.
- **Mail:** forward an invoice to the company's receipt address.
- **A shared folder** (iCloud Drive, Dropbox, a network share) the host watches.

They do not need the desktop app. A small web page to see "my receipts and their state" is
enough, if anything.

## What they may change

Add receipts and their own note on a receipt. Nothing else.

## What they need from the app

- **One receipt app, installed from the App Store,** not built by the company. The company
  points it at its own host by showing a QR code in the desktop app; the code carries the host
  address and a token for that phone. Scanning it is the whole setup.
- Uploads that wait and retry when the host is not reachable (the owner's laptop is closed,
  the phone is abroad).
- A clear "received" and, later, "booked" for each receipt.

## Risks and pains

- Today the receipt app takes a typed address and the upload endpoint accepts files from
  anyone who can reach it. The QR token is also the access control: a phone without one cannot
  upload.
- There is no always-on company server ([ADR 0003](../adr/0003-deployment-and-collaboration.md)):
  the phone delivers to the repository's inbox (or a shared folder) and keeps receipts until
  delivered. Employees get no clone of the books: a clone would show them everything.
- Building and signing an iOS app is not a job a company does for its staff; the app has to be
  published once, by the vendor.
