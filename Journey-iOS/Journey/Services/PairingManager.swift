// Pairs with a server from a QR code and checks that it is reachable.

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

    static let rejectedCodeMessage = "The server didn't accept this code. Codes work for 15 minutes. Make a new one on the pairing page and scan it again."

    // Returns false when the server refuses the code, leaving any existing pairing as it was.
    // /ping answers anyone, so the code is checked with a request that needs it; that request
    // is also what tells the server the code has been scanned.
    func pair(serverURL: String, token: String) async -> Bool {
        let pairing = ServerPairing(serverURL: serverURL, bearerToken: token)
        let check = await checkToken(baseURL: pairing.baseURL, token: token)
        if check == .rejected { return false }

        // An unreachable server may only be out of range for now, so the pairing is kept.
        pairing.save()
        await MainActor.run {
            self.isPaired = true
            self.serverURL = pairing.baseURL
            self.isServerReachable = check == .accepted
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

    private enum TokenCheck {
        case accepted, rejected, unreachable
    }

    private func checkToken(baseURL: String, token: String) async -> TokenCheck {
        guard let url = URL(string: "\(baseURL)/api/auth/me") else { return .unreachable }
        var request = URLRequest(url: url)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.timeoutInterval = 8
        do {
            let (_, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse else { return .unreachable }
            switch http.statusCode {
            case 200: return .accepted
            case 401, 403: return .rejected
            default: return .unreachable
            }
        } catch {
            return .unreachable
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
