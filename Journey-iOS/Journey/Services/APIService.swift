import Foundation
import AVFoundation

enum APIError: Error, LocalizedError {
    case notPaired
    case invalidURL
    case httpError(Int)
    /// An HTTP error whose JSON body named the reason, e.g. `{ "error": "Journey not found" }`.
    case serverError(Int, String)
    case decodingError(Error)
    case networkError(Error)

    var errorDescription: String? {
        switch self {
        case .notPaired: return "Not paired with server"
        case .invalidURL: return "Invalid URL"
        case .httpError(let code): return "HTTP error \(code)"
        case .serverError(_, let message): return message
        case .decodingError(let err): return "Decoding error: \(err.localizedDescription)"
        case .networkError(let err): return err.localizedDescription
        }
    }
}

final class APIService: Sendable {
    struct Profile: Codable {
        let id: String
        let username: String
        let displayName: String?
        let firstName: String?
        let lastName: String?
        let unitPreference: String?
        let avatarUrl: String?

        var fullName: String {
            let parts = [firstName, lastName]
                .compactMap { $0 }
                .filter { !$0.isEmpty }
            if !parts.isEmpty { return parts.joined(separator: " ") }
            if let displayName, !displayName.isEmpty { return displayName }
            return username
        }

        var initials: String {
            let parts = [firstName, lastName]
                .compactMap { $0 }
                .filter { !$0.isEmpty }
            if !parts.isEmpty {
                return parts.compactMap { $0.first.map { String($0).uppercased() } }.joined()
            }
            return username.first.map { String($0).uppercased() } ?? "?"
        }

        var absoluteAvatarURL: URL? {
            guard let avatarUrl, !avatarUrl.isEmpty else { return nil }
            if avatarUrl.hasPrefix("http://") || avatarUrl.hasPrefix("https://") {
                return URL(string: avatarUrl)
            }
            guard let pairing = ServerPairing.stored else { return nil }
            return URL(string: "\(pairing.baseURL)\(avatarUrl)")
        }
    }

    static let shared = APIService()
    private init() {}

    private func authenticatedRequest(path: String, method: String = "GET") throws -> URLRequest {
        guard let pairing = ServerPairing.stored else {
            throw APIError.notPaired
        }
        guard let url = URL(string: "\(pairing.baseURL)\(path)") else {
            throw APIError.invalidURL
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("Bearer \(pairing.bearerToken)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 15
        return request
    }

    // MARK: - Health Check

    func ping() async throws -> Bool {
        let request = try authenticatedRequest(path: "/ping")
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else { return false }
        return String(data: data, encoding: .utf8) == "pong"
    }

    // MARK: - Profile

    func fetchMe() async throws -> Profile {
        let request = try authenticatedRequest(path: "/api/auth/me")
        let tokenPrefix = String((ServerPairing.stored?.bearerToken ?? "").prefix(8))
        print("[APIService] fetchMe → \(request.url?.absoluteString ?? "nil") token=\(tokenPrefix)…")
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            let body = String(data: data, encoding: .utf8) ?? "<non-utf8>"
            print("[APIService] fetchMe ← \(status) body=\(body)")
            throw APIError.httpError(status)
        }
        do {
            return try JSONDecoder().decode(Profile.self, from: data)
        } catch {
            throw APIError.decodingError(error)
        }
    }

    // MARK: - Journeys

    func fetchJourneys() async throws -> [JourneySummary] {
        let request = try authenticatedRequest(path: "/api/routes")
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw APIError.httpError((response as? HTTPURLResponse)?.statusCode ?? 0)
        }
        do {
            return try JSONDecoder().decode([JourneySummary].self, from: data)
        } catch {
            throw APIError.decodingError(error)
        }
    }

    func fetchJourneyDetail(id: String, maxPoints: Int = 200) async throws -> JourneyDetail {
        let request = try authenticatedRequest(path: "/api/routes/\(id)?maxPoints=\(maxPoints)")
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw APIError.httpError((response as? HTTPURLResponse)?.statusCode ?? 0)
        }
        do {
            return try JSONDecoder().decode(JourneyDetail.self, from: data)
        } catch {
            throw APIError.decodingError(error)
        }
    }

    func renameJourney(id: String, newName: String) async throws {
        var request = try authenticatedRequest(path: "/api/routes/\(id)/name", method: "PATCH")
        request.httpBody = try JSONEncoder().encode(["newName": newName])
        let (_, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw APIError.httpError((response as? HTTPURLResponse)?.statusCode ?? 0)
        }
    }

    func setTravelMode(id: String, mode: String) async throws {
        var request = try authenticatedRequest(path: "/api/routes/\(id)/travel-mode", method: "PATCH")
        request.httpBody = try JSONEncoder().encode(["travelMode": mode])
        let (_, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw APIError.httpError((response as? HTTPURLResponse)?.statusCode ?? 0)
        }
    }

    func deleteJourney(id: String) async throws {
        let request = try authenticatedRequest(path: "/api/routes/\(id)", method: "DELETE")
        let (_, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw APIError.httpError((response as? HTTPURLResponse)?.statusCode ?? 0)
        }
    }

    // MARK: - Photos and Videos

    /// Server path of a stored photo, video or video poster. With `thumbnail`, the reduced
    /// copy the server makes for gallery tiles (720px wide); a video has none of its own, so
    /// ask for its poster's.
    private func photoPath(_ filename: String, thumbnail: Bool = false) -> String {
        let encodedPath = filename
            .split(separator: "/")
            .map { $0.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? String($0) }
            .joined(separator: "/")
        return thumbnail ? "/photos/thumb/\(encodedPath)" : "/photos/\(encodedPath)"
    }

    func fetchPhotoData(filename: String, thumbnail: Bool = false) async throws -> Data {
        var request = try authenticatedRequest(path: photoPath(filename, thumbnail: thumbnail))
        request.timeoutInterval = 30
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw APIError.httpError((response as? HTTPURLResponse)?.statusCode ?? 0)
        }
        return data
    }

    /// A converted video, streamed from the server (which answers the Range requests seeking
    /// makes) with the pairing token, since AVPlayer can't be handed a URLRequest.
    func videoAsset(filename: String) throws -> AVURLAsset {
        let request = try authenticatedRequest(path: photoPath(filename))
        guard let url = request.url else { throw APIError.invalidURL }
        let headers = ["Authorization": request.value(forHTTPHeaderField: "Authorization") ?? ""]
        return AVURLAsset(url: url, options: ["AVURLAssetHTTPHeaderFieldsKey": headers])
    }

    private struct MediaListResponse: Decodable {
        let photos: [JourneyPhoto]
    }

    /// A journey's photos and videos on their own, which is lighter than the journey itself.
    /// The web app polls it while uploads convert, and so does this app.
    func fetchJourneyMedia(id: String) async throws -> [JourneyPhoto] {
        let request = try authenticatedRequest(path: "/api/routes/\(id)/photos")
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw APIError.httpError((response as? HTTPURLResponse)?.statusCode ?? 0)
        }
        do {
            return try JSONDecoder().decode(MediaListResponse.self, from: data).photos
        } catch {
            throw APIError.decodingError(error)
        }
    }

    struct MediaUploadResult: Decodable {
        /// The items as the server stored them. HEIC photos and videos come back "processing".
        let photos: [JourneyPhoto]
        /// Files the server turned down without failing the request, e.g. a photo over 50 MB.
        let skipped: [Skipped]?

        struct Skipped: Decodable {
            let name: String
            let reason: String
        }
    }

    private struct ErrorResponse: Decodable {
        let error: String
    }

    /// Adds photos and videos to a journey with the same request the web app makes: a
    /// multipart POST with each file under the `photos` field. The server replies once the
    /// files are stored and converts HEIC photos and videos afterwards.
    func uploadMedia(
        _ files: [MediaUploadFile],
        toJourney id: String,
        onProgress: (@Sendable (Double) -> Void)? = nil
    ) async throws -> MediaUploadResult {
        let boundary = "Boundary-\(UUID().uuidString)"
        var request = try authenticatedRequest(path: "/api/routes/\(id)/photos", method: "POST")
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        // How long the connection may sit idle, not the whole upload, which for a long video
        // over a slow link takes minutes
        request.timeoutInterval = 120

        let bodyURL = try await Task.detached(priority: .userInitiated) {
            try Self.writeUploadBody(files, boundary: boundary)
        }.value
        defer { try? FileManager.default.removeItem(at: bodyURL) }

        let delegate = onProgress.map(UploadProgressDelegate.init)
        let (data, response) = try await URLSession.shared.upload(for: request, fromFile: bodyURL, delegate: delegate)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 200 else {
            if let message = try? JSONDecoder().decode(ErrorResponse.self, from: data).error {
                throw APIError.serverError(status, message)
            }
            throw APIError.httpError(status)
        }
        do {
            return try JSONDecoder().decode(MediaUploadResult.self, from: data)
        } catch {
            throw APIError.decodingError(error)
        }
    }

    func deletePhoto(id photoID: String, fromJourney journeyID: String) async throws {
        let request = try authenticatedRequest(path: "/api/routes/\(journeyID)/photos/\(photoID)", method: "DELETE")
        let (data, response) = try await URLSession.shared.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 200 else {
            if let message = try? JSONDecoder().decode(ErrorResponse.self, from: data).error {
                throw APIError.serverError(status, message)
            }
            throw APIError.httpError(status)
        }
    }

    /// Writes the multipart body to a temporary file for URLSession to send from, since a video
    /// can run to hundreds of megabytes. Built off the main thread.
    nonisolated private static func writeUploadBody(_ files: [MediaUploadFile], boundary: String) throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("upload-\(UUID().uuidString)")
        guard FileManager.default.createFile(atPath: url.path, contents: nil) else {
            throw CocoaError(.fileWriteUnknown)
        }
        do {
            let output = try FileHandle(forWritingTo: url)
            defer { try? output.close() }
            for file in files {
                try output.write(contentsOf: Data("--\(boundary)\r\n".utf8))
                try output.write(contentsOf: Data("Content-Disposition: form-data; name=\"photos\"; filename=\"\(file.filename)\"\r\n".utf8))
                try output.write(contentsOf: Data("Content-Type: \(file.mimeType)\r\n\r\n".utf8))
                switch file.contents {
                case .data(let data):
                    try output.write(contentsOf: data)
                case .file(let source):
                    let input = try FileHandle(forReadingFrom: source)
                    defer { try? input.close() }
                    while let chunk = try input.read(upToCount: 4 << 20), !chunk.isEmpty {
                        try output.write(contentsOf: chunk)
                    }
                }
                try output.write(contentsOf: Data("\r\n".utf8))
            }
            try output.write(contentsOf: Data("--\(boundary)--\r\n".utf8))
        } catch {
            try? FileManager.default.removeItem(at: url)
            throw error
        }
        return url
    }

    // MARK: - Upload

    struct UploadResponse: Codable {
        let accepted: Bool?
        let saved: Bool?
        let reason: String?
    }

    func uploadJourney(fileURL: URL, source: String) async throws -> UploadResponse {
        guard let pairing = ServerPairing.stored else { throw APIError.notPaired }
        guard let url = URL(string: "\(pairing.baseURL)/upload") else { throw APIError.invalidURL }

        let boundary = UUID().uuidString
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("Bearer \(pairing.bearerToken)", forHTTPHeaderField: "Authorization")
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 60

        let fileData = try Data(contentsOf: fileURL)
        let fileName = fileURL.lastPathComponent

        var body = Data()

        // Source field
        body.append("--\(boundary)\r\n".data(using: .utf8)!)
        body.append("Content-Disposition: form-data; name=\"source\"\r\n\r\n".data(using: .utf8)!)
        body.append("\(source)\r\n".data(using: .utf8)!)

        // File field
        body.append("--\(boundary)\r\n".data(using: .utf8)!)
        body.append("Content-Disposition: form-data; name=\"journey\"; filename=\"\(fileName)\"\r\n".data(using: .utf8)!)
        body.append("Content-Type: application/zip\r\n\r\n".data(using: .utf8)!)
        body.append(fileData)
        body.append("\r\n".data(using: .utf8)!)

        // End
        body.append("--\(boundary)--\r\n".data(using: .utf8)!)

        request.httpBody = body

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, (200...201).contains(http.statusCode) else {
            throw APIError.httpError((response as? HTTPURLResponse)?.statusCode ?? 0)
        }
        return try JSONDecoder().decode(UploadResponse.self, from: data)
    }
}

/// Reports how much of an upload's body has been sent.
nonisolated private final class UploadProgressDelegate: NSObject, URLSessionTaskDelegate, Sendable {
    let onProgress: @Sendable (Double) -> Void

    init(onProgress: @escaping @Sendable (Double) -> Void) {
        self.onProgress = onProgress
    }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        didSendBodyData bytesSent: Int64,
        totalBytesSent: Int64,
        totalBytesExpectedToSend: Int64
    ) {
        guard totalBytesExpectedToSend > 0 else { return }
        onProgress(Double(totalBytesSent) / Double(totalBytesExpectedToSend))
    }
}
