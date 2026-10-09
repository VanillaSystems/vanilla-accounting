import Foundation

enum UploadError: LocalizedError {
    case fileNotFound
    case serverError(Int)

    var errorDescription: String? {
        switch self {
        case .fileNotFound: return "Receipt file not found on device"
        case .serverError(let code): return "Server returned error \(code)"
        }
    }
}

enum UploadService {
    static func upload(_ upload: PendingUpload, to serverURL: URL) async throws {
        guard FileManager.default.fileExists(atPath: upload.fileURL.path) else {
            throw UploadError.fileNotFound
        }

        let data = try Data(contentsOf: upload.fileURL)

        let base = serverURL.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard let url = URL(string: base + "/api/upload") else {
            throw UploadError.serverError(0)
        }

        var request = URLRequest(url: url, timeoutInterval: 60)
        request.httpMethod = "POST"
        request.setValue("application/pdf", forHTTPHeaderField: "Content-Type")
        request.setValue(
            ISO8601DateFormatter().string(from: upload.capturedAt),
            forHTTPHeaderField: "X-Captured-At"
        )
        request.httpBody = data

        let (_, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw UploadError.serverError((response as? HTTPURLResponse)?.statusCode ?? 0)
        }
    }
}
