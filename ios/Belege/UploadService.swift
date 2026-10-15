import Foundation

enum UploadError: LocalizedError {
    case fileNotFound
    case notPaired
    case serverError(Int)

    var errorDescription: String? {
        switch self {
        case .fileNotFound: return "Receipt file not found on device"
        case .notPaired: return "This phone is not paired with the Mac: scan the code in Settings › Pair with Mac"
        case .serverError(let code): return "Server returned error \(code)"
        }
    }
}

enum UploadService {
    static func upload(_ upload: PendingUpload, to serverURL: URL, token: String?) async throws {
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
        request.authorize(token)
        request.httpBody = data

        let (_, response) = try await URLSession.shared.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        if status == 401 { throw UploadError.notPaired }
        guard status == 200 else { throw UploadError.serverError(status) }
    }
}
