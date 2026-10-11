import Foundation
import SwiftData

@Model
final class PendingUpload {
    var id: UUID
    var filename: String
    var capturedAt: Date
    var pageCount: Int
    var synced: Bool

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
}
