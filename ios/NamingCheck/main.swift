// Checks ReceiptNaming with sample receipt texts (demo data), no test target needed:
//   swiftc ios/Belege/ReceiptNaming.swift ios/NamingCheck/main.swift -o /tmp/naming && /tmp/naming
import Foundation
let cases: [(String, [String], String?)] = [
  ("Coop Pronto", ["COOP PRONTO", "Tankstelle Zürich", "Badenerstrasse 120", "8004 Zürich", "17.10.2026 08:15", "Bleifrei 95 71.85", "Wasser 2.40", "Kaffee 5.00", "TOTAL CHF 79.25", "MWST 8.1% 5.94"], "Coop Pronto · CHF 79.25"),
  ("Post CH", ["Die Post", "Post CH AG", "Filiale Zürich 1", "Quittung", "Pakete Inland 3x 27.00", "Total", "CHF 217.75", "MWST-Nr CHE-123.456.789"], "Die Post · CHF 217.75"),
  ("Migros", ["MIGROS", "Genossenschaft Migros Zürich", "Limmatplatz 1", "Brot 3.20", "Milch 1.95", "Summe CHF 12.40", "Bar 20.00", "Rückgeld 7.60"], "Migros · CHF 12.40"),
  ("SBB", ["SBB CFF FFS", "Billett 2. Klasse", "Zürich HB - Bern", "Datum 15.10.2026", "Betrag CHF 52.00", "inkl. MWST 8.1% 3.89"], "SBB · CHF 52.00"),
  ("thousands", ["Grünkaffee Muster AG", "Rechnung 2026-17", "Rohkaffee 60 kg", "Zu bezahlen CHF 2'888.30"], "Grünkaffee Muster AG · CHF 2'888.30"),
  ("EUR, no total word", ["AMAZON EU", "Order 302-1234", "Item 19.99", "Item 4.50", "EUR 24.49"], "Amazon EU · EUR 24.49"),
  ("Coop logo misread", ["cOO •", "Coop Pronto Shop", "8808 Pfäffikon", "TOTAL CHF 63.16"], "Coop · CHF 63.16"),
  ("leading junk", ["& Stützliwäsch AG", "Seestrasse 4", "Total 9.01"], "Stützliwäsch AG · CHF 9.01"),
  ("registered mark", ["Reize®", "Rechnung 77", "Zu bezahlen CHF 1'111.70"], "Reize · CHF 1'111.70"),
  ("lowercase", ["hornbach", "Total CHF 12.95"], "Hornbach · CHF 12.95"),
  ("nothing", ["", "  ", "12 34"], nil),
]
var fails = 0
for (label, lines, want) in cases {
  let got = ReceiptNaming.name(fromLines: lines)
  let ok = got == want
  if !ok { fails += 1 }
  print(ok ? "ok  " : "FAIL", label, "→", got ?? "nil", ok ? "" : "(want \(want ?? "nil"))")
}
print(fails == 0 ? "all \(cases.count) pass" : "\(fails) failing")
exit(fails == 0 ? 0 : 1)
