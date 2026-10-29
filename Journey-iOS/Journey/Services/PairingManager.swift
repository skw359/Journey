import Foundation
import SwiftUI

@Observable
final class PairingManager {
    var isPaired: Bool = false
    var serverURL: String?
    var isServerReachable: Bool = false
    var isCheckingReachability: Bool = false

    init() {
        loadStoredPairing()
    }

    func loadStoredPairing() {
        if let pairing = ServerPairing.stored {
            isPaired = true
            serverURL = pairing.baseURL
        } else {
            isPaired = false
            serverURL = nil
        }
    }

    /// Parses a QR code string in format: journey://pair?server=X&token=Y
    func parseQRCode(_ string: String) -> (server: String, token: String)? {
        guard let components = URLComponents(string: string),
              components.scheme == "journey",
              components.host == "pair" else {
            return nil
        }
        guard let server = components.queryItems?.first(where: { $0.name == "server" })?.value,
              let token = components.queryItems?.first(where: { $0.name == "token" })?.value,
              !server.isEmpty, !token.isEmpty else {
            return nil
        }
        return (server: server, token: token)
    }

    /// Pairs with a server by storing credentials and validating the connection
    func pair(serverURL: String, token: String) async -> Bool {
        let pairing = ServerPairing(serverURL: serverURL, bearerToken: token)
        pairing.save()

        await MainActor.run {
            self.isPaired = true
            self.serverURL = pairing.baseURL
            self.isServerReachable = false
        }

        // Validate connection
        let reachable = await pingServer(baseURL: pairing.baseURL, token: token)

        await MainActor.run {
            self.isServerReachable = reachable
        }
        return true
    }

    func disconnect() {
        ServerPairing.clear()
        isPaired = false
        serverURL = nil
        isServerReachable = false
    }

    func checkServerReachability() async {
        guard let pairing = ServerPairing.stored else {
            await MainActor.run { isServerReachable = false }
            return
        }
        await MainActor.run { isCheckingReachability = true }
        let reachable = await pingServer(baseURL: pairing.baseURL, token: pairing.bearerToken)
        await MainActor.run {
            isServerReachable = reachable
            isCheckingReachability = false
        }
    }

    private func pingServer(baseURL: String, token: String) async -> Bool {
        guard let url = URL(string: "\(baseURL)/ping") else { return false }
        var request = URLRequest(url: url)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.timeoutInterval = 5
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse,
                  httpResponse.statusCode == 200 else { return false }
            let body = String(data: data, encoding: .utf8)
            return body == "pong"
        } catch {
            return false
        }
    }
}
