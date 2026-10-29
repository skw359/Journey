import Foundation

struct ServerPairing {
    let serverURL: String
    let bearerToken: String

    var baseURL: String {
        var url = serverURL
        while url.hasSuffix("/") { url.removeLast() }
        return url
    }

    static var stored: ServerPairing? {
        guard let token = KeychainHelper.loadString(key: AppConstants.keychainTokenKey),
              let url = UserDefaults.standard.string(forKey: AppConstants.serverURLKey),
              !token.isEmpty, !url.isEmpty else {
            return nil
        }
        return ServerPairing(serverURL: url, bearerToken: token)
    }

    func save() {
        KeychainHelper.save(key: AppConstants.keychainTokenKey, string: bearerToken)
        UserDefaults.standard.set(serverURL, forKey: AppConstants.serverURLKey)
        UserDefaults.standard.set(true, forKey: AppConstants.hasCompletedPairingKey)
    }

    static func clear() {
        KeychainHelper.delete(key: AppConstants.keychainTokenKey)
        UserDefaults.standard.removeObject(forKey: AppConstants.serverURLKey)
        UserDefaults.standard.set(false, forKey: AppConstants.hasCompletedPairingKey)
    }
}
