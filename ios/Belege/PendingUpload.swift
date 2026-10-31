import Foundation
import SwiftData

@Model
final class PendingUpload {
    var id: UUID
    var filename: String
    var capturedAt: Date
    var pageCount: Int
    var synced: Bool
    /// When it reached the Mac; for «Gesendete nach 30 Tagen vom Handy löschen».
    var syncedAt: Date?
    /// A name the person gave the receipt. Optional, so SwiftData adds it to existing stores by itself.
    /// Phase 1 keeps it on the phone; the Mac names a receipt from what it reads.
    var name: String?
    /// The phone's own guess from the receipt's text (ReceiptNaming): «Coop Pronto · CHF 79.25».
    /// A name typed by hand always wins. Phase 4 adds the Mac's name (from what it read) between the two.
    var guessedName: String?
    /// The ReceiptNaming version that last read this receipt (with or without a result); the backfill
    /// reads it again when the rules have changed.
    var guessVersion: Int?
    /// A note for the accountant. Phase 1 keeps it on the phone only: sending it (an X-Note header on the
    /// upload, an update route for a note added later) needs the server change of phase 4,
    /// see docs/0.4.0/mockups/phone-app/NOTES.md.
    var note: String?

    init(filename: String, capturedAt: Date, pageCount: Int) {
        self.id = UUID()
        self.filename = filename
        self.capturedAt = capturedAt
        self.pageCount = pageCount
        self.synced = false
    }


    var fileURL: URL {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent(filename)
    }

    var fileSize: Int64? {
        (try? FileManager.default.attributesOfItem(atPath: fileURL.path))?[.size] as? Int64
    }

    /// The receipt's header, cropped by the recognition for the list's tile.
    var headerURL: URL {
        fileURL.deletingPathExtension().appendingPathExtension("head.jpg")
    }

    /// The person's name, else the phone's guess, else «Beleg 13:09» (the day stands in the group header).
    var displayName: String {
        if let name, !name.trimmingCharacters(in: .whitespaces).isEmpty { return name }
        if let guessedName, !guessedName.isEmpty { return guessedName }
        return "Beleg \(capturedAt.formatted(.dateTime.hour(.twoDigits(amPM: .omitted)).minute(.twoDigits)))"
    }

    /// Shown with a quiet «vorläufig»: the phone's guess, not confirmed by a person (or, later, the Mac).
    var isProvisional: Bool {
        (name?.trimmingCharacters(in: .whitespaces).isEmpty ?? true) && guessedName != nil
    }

    /// «Coop Pronto · CHF 79.25» gives «CP», for the tile when no header could be cropped.
    var initials: String? {
        guard let source = (name?.isEmpty == false ? name : guessedName) else { return nil }
        let supplier = source.components(separatedBy: " · ").first ?? source
        let letters = supplier.split(separator: " ").compactMap { $0.first(where: \.isLetter) }.prefix(2)
        return letters.isEmpty ? nil : String(letters).uppercased()
    }
}
