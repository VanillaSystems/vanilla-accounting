import Foundation

/// A provisional name for a receipt from its recognised text: «<supplier> · CHF <amount>».
/// Pure (text lines in, name out), so it runs in tests on macOS; the recognition itself is in ReceiptRecognizer.
enum ReceiptNaming {
    /// Raised when the rules change, so receipts named by an older version are read again.
    static let version = 2

    /// Lines in reading order, top first. Nil when neither a supplier nor an amount is found.
    static func name(fromLines lines: [String]) -> String? {
        let clean = lines.map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        let supplier = supplier(in: clean)
        let total = total(in: clean)
        switch (supplier, total) {
        case let (s?, t?): return "\(s) · \(t.currency) \(t.amount)"
        case let (s?, nil): return s
        case let (nil, t?): return "Beleg · \(t.currency) \(t.amount)"
        default: return nil
        }
    }

    // MARK: Amount

    struct Total: Equatable { let currency: String; let amount: String }

    private static let totalWords = ["zu bezahlen", "zu zahlen", "total", "summe", "gesamt", "betrag", "montant", "totale", "importo", "amount due", "to pay"]
    private static let notTotal = ["mwst", "mwst.", "tva", "iva", "vat", "rabatt", "rückgeld", "rueckgeld", "gegeben", "bar ", "zwischen", "subtotal", "netto", "exkl", "excl"]
    private static let amountPattern = #"(?<![\d.])(\d{1,3}(?:['’ ]\d{3})+|\d+)[.,](\d{2})(?!\d)"#
    private static let currencyPattern = #"\b(CHF|EUR|USD|GBP|Fr\.?|SFr\.?|€|\$)"#

    static func total(in lines: [String]) -> Total? {
        let fallbackCurrency = lines.lazy.compactMap { currency(in: $0) }.first ?? "CHF"
        for (i, line) in lines.enumerated() {
            let low = line.lowercased()
            guard totalWords.contains(where: { low.contains($0) }), !notTotal.contains(where: { low.contains($0) }) else { continue }
            // The amount stands on the line itself, or on the next one.
            for candidate in [line] + (i + 1 < lines.count ? [lines[i + 1]] : []) {
                if let amount = amounts(in: candidate).last {
                    return Total(currency: currency(in: candidate) ?? currency(in: line) ?? fallbackCurrency, amount: format(amount))
                }
            }
        }
        // No total line: the largest amount on the receipt.
        let all = lines.flatMap { line in amounts(in: line).map { (line, $0) } }
        guard let best = all.max(by: { $0.1 < $1.1 }) else { return nil }
        return Total(currency: currency(in: best.0) ?? fallbackCurrency, amount: format(best.1))
    }

    static func amounts(in line: String) -> [Decimal] {
        guard let re = try? NSRegularExpression(pattern: amountPattern) else { return [] }
        let ns = line as NSString
        return re.matches(in: line, range: NSRange(location: 0, length: ns.length)).compactMap { m in
            let whole = ns.substring(with: m.range(at: 1)).filter(\.isNumber)
            let cents = ns.substring(with: m.range(at: 2))
            return Decimal(string: "\(whole).\(cents)", locale: Locale(identifier: "en_US_POSIX"))
        }
    }

    private static func currency(in line: String) -> String? {
        guard let r = line.range(of: currencyPattern, options: .regularExpression) else { return nil }
        switch line[r].uppercased() {
        case "CHF", "FR", "FR.", "SFR", "SFR.": return "CHF"
        case "€", "EUR": return "EUR"
        case "$", "USD": return "USD"
        default: return String(line[r]).uppercased()
        }
    }

    /// Swiss style: 2'888.30.
    static func format(_ amount: Decimal) -> String {
        let f = NumberFormatter()
        f.numberStyle = .decimal
        f.minimumFractionDigits = 2
        f.maximumFractionDigits = 2
        f.groupingSeparator = "'"
        f.decimalSeparator = "."
        f.usesGroupingSeparator = true
        return f.string(from: amount as NSDecimalNumber) ?? "\(amount)"
    }

    // MARK: Supplier

    private static let skipWords = ["quittung", "rechnung", "beleg", "kassenbon", "kassenzettel", "receipt", "invoice", "facture", "ricevuta", "datum", "date", "tel", "fax", "www", "http", "mwst", "uid", "che-", "kasse", "filiale", "danke", "willkommen", "bienvenue", "kundenbeleg", "original"]
    private static let streetPattern = #"(?i)(strasse|str\.|gasse|weg|platz|allee|rue|via|avenue|route)\s*\d"#

    static func supplier(in lines: [String]) -> String? {
        for line in lines.prefix(8) {
            let low = line.lowercased()
            let letters = line.filter(\.isLetter).count
            let digits = line.filter(\.isNumber).count
            if letters < 3 || digits > letters { continue }
            if skipWords.contains(where: { low.contains($0) }) { continue }
            if line.range(of: streetPattern, options: .regularExpression) != nil { continue }
            if line.range(of: #"^\d{4,5}\s"#, options: .regularExpression) != nil { continue }   // «8000 Zürich»
            if line.contains("@") { continue }
            let name = tidy(line)
            if name.filter(\.isLetter).count < 2 { continue }
            return name
        }
        return nil
    }

    /// Chains whose logo the text recognition reads badly («cOO •», «cooo»), and common spellings.
    private static let known: [(pattern: String, name: String)] = [
        (#"^coop\s+pronto"#, "Coop Pronto"),
        (#"^c\s*[o0ö]{2,4}\s*p?\b"#, "Coop"),
        (#"^migros\b"#, "Migros"),
        (#"^ups\b"#, "UPS"),
        (#"^dh[l12i]\s*express"#, "DHL Express"),
        (#"^dhl\b"#, "DHL"),
        (#"^fedex"#, "FedEx"),
        (#"^(die\s+)?post\b"#, "Die Post"),
        (#"^sbb\b"#, "SBB"),
        (#"^denner\b"#, "Denner"),
        (#"^aldi\b"#, "Aldi"),
        (#"^lidl\b"#, "Lidl"),
    ]

    private static func knownName(_ s: String) -> String? {
        let low = s.lowercased()
        return known.first { low.range(of: $0.pattern, options: .regularExpression) != nil }?.name
    }

    /// Stray marks off («®», «•», a leading «&» or «77»), a known chain by its usual name, and «COOP PRONTO»
    /// becomes «Coop Pronto»; short words in capitals (SBB, CH, AG) stay.
    private static func tidy(_ line: String) -> String {
        var s = line.replacingOccurrences(of: #"[®™©•·*|_~^°]"#, with: " ", options: .regularExpression)
        s = s.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
        s = s.replacingOccurrences(of: #"^[^\p{L}]+"#, with: "", options: .regularExpression)
        s = s.trimmingCharacters(in: CharacterSet(charactersIn: " *-–—:|.,&"))
        if let known = knownName(s) { return known }
        if let first = s.first, s == s.lowercased() { s = first.uppercased() + s.dropFirst() }
        let letters = s.filter(\.isLetter)
        if !letters.isEmpty, letters == letters.uppercased() {
            s = s.split(separator: " ").map { w in
                w.count <= 3 ? String(w) : w.prefix(1) + w.dropFirst().lowercased()
            }.joined(separator: " ")
        }
        return s.count > 32 ? String(s.prefix(31)) + "…" : s
    }
}
