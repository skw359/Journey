// Client for the Journey server API.

import Foundation
import AVFoundation

enum APIError: Error, LocalizedError {
    case notPaired
    case invalidURL
    case httpError(Int)
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

    func ping() async throws -> Bool {
        let request = try authenticatedRequest(path: "/ping")
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else { return false }
        return String(data: data, encoding: .utf8) == "pong"
    }

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

    func videoAsset(filename: String) throws -> AVURLAsset {
        let request = try authenticatedRequest(path: photoPath(filename))
        guard let url = request.url else { throw APIError.invalidURL }
        let headers = ["Authorization": request.value(forHTTPHeaderField: "Authorization") ?? ""]
        return AVURLAsset(url: url, options: ["AVURLAssetHTTPHeaderFieldsKey": headers])
    }

    private struct MediaListResponse: Decodable {
        let photos: [JourneyPhoto]
    }

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
        let photos: [JourneyPhoto]
        let skipped: [Skipped]?

        struct Skipped: Decodable {
            let name: String
            let reason: String
        }
    }

    private struct ErrorResponse: Decodable {
        let error: String
    }

    func uploadMedia(
        _ files: [MediaUploadFile],
        toJourney id: String,
        onProgress: (@Sendable (Double) -> Void)? = nil
    ) async throws -> MediaUploadResult {
        let boundary = "Boundary-\(UUID().uuidString)"
        var request = try authenticatedRequest(path: "/api/routes/\(id)/photos", method: "POST")
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
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

    func mediaUploadRequest(path: String, method: String) throws -> URLRequest {
        var request = try authenticatedRequest(path: path, method: method)
        request.timeoutInterval = 120
        return request
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
                try output.write(contentsOf: file.data)
                try output.write(contentsOf: Data("\r\n".utf8))
            }
            try output.write(contentsOf: Data("--\(boundary)--\r\n".utf8))
        } catch {
            try? FileManager.default.removeItem(at: url)
            throw error
        }
        return url
    }

    struct UploadResponse: Codable {
        let accepted: Bool?
        let saved: Bool?
        let reason: String?
    }

    func uploadJourney(fileURL: URL, source: String, recordingId: String) async throws -> UploadResponse {
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

        body.append("--\(boundary)\r\n".data(using: .utf8)!)
        body.append("Content-Disposition: form-data; name=\"source\"\r\n\r\n".data(using: .utf8)!)
        body.append("\(source)\r\n".data(using: .utf8)!)

        body.append("--\(boundary)\r\n".data(using: .utf8)!)
        body.append("Content-Disposition: form-data; name=\"recordingId\"\r\n\r\n".data(using: .utf8)!)
        body.append("\(recordingId)\r\n".data(using: .utf8)!)

        body.append("--\(boundary)\r\n".data(using: .utf8)!)
        body.append("Content-Disposition: form-data; name=\"journey\"; filename=\"\(fileName)\"\r\n".data(using: .utf8)!)
        body.append("Content-Type: application/zip\r\n\r\n".data(using: .utf8)!)
        body.append(fileData)
        body.append("\r\n".data(using: .utf8)!)

        body.append("--\(boundary)--\r\n".data(using: .utf8)!)

        request.httpBody = body

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, (200...201).contains(http.statusCode) else {
            throw APIError.httpError((response as? HTTPURLResponse)?.statusCode ?? 0)
        }
        return try JSONDecoder().decode(UploadResponse.self, from: data)
    }
}

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
