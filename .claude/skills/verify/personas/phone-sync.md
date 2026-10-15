# Scenario: receipts from the phone (snapshot huber-q3)

Thomas photographs receipts on the building site with the iPhone app (ios/, it uploads to the
desktop app over the local network: POST /api/upload, see src/server/routes/scan.ts and the scan
page /scan). Simulate the phone: from the host, send photos the way the app does (read ios/ and
scan.ts for the exact request; through the VM's network), several at once, one twice, one
while the Mac app is closed, one huge HEIC-like photo, one that is not a receipt.

Judge: does each arrive, get read and linked; is a double upload caught; what Thomas sees on the
phone when the Mac is off; what Sandra sees on the Mac; anything lost.
