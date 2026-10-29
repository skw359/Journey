import SwiftUI

extension Font {
    static func montserrat(size: CGFloat, weight: Font.Weight = .regular) -> Font {
        let weightName: String
        switch weight {
        case .black: weightName = "Black"
        case .heavy: weightName = "ExtraBold"
        case .bold: weightName = "Bold"
        case .semibold: weightName = "SemiBold"
        case .medium: weightName = "Medium"
        case .light: weightName = "Light"
        case .thin: weightName = "Thin"
        default: weightName = "Regular"
        }
        return .custom("Montserrat-\(weightName)", size: size)
    }
}

enum AppConstants {
    static let journeyGreen = Color(hex: "#00E676")
    static let journeyGreenUIColor = UIColor(red: 0, green: 230/255, blue: 118/255, alpha: 1)
    static let darkCardBackground = Color(hex: "#141416")
    static let darkCardBorder = Color(hex: "#1E1E20")
    static let appBackground = Color.black
    static let redAction = Color(hex: "#FF3B30")
    static let electricBlue = Color(hex: "#32ADE6")
    static let secondaryText = Color(hex: "#8E8E93")

    // API
    // Read from Journey/JourneyConfig.plist, which is git-ignored (copy
    // Config/JourneyConfig.example.plist). Without it, geocoding is skipped.
    static let geocodeBaseURL: String? = {
        guard let url = Bundle.main.url(forResource: "JourneyConfig", withExtension: "plist"),
              let config = NSDictionary(contentsOf: url),
              let value = config["GeocodeBaseURL"] as? String else { return nil }
        let base = value.trimmingCharacters(in: CharacterSet(charactersIn: "/ "))
        return base.isEmpty ? nil : base
    }()

    // Keychain
    static let keychainTokenKey = "journey_bearer_token"
    static let serverURLKey = "journey_server_url"

    // UserDefaults
    static let confirmBeforeStoppingKey = "confirmBeforeStopping"
    static let autoSegmentKey = "autoSegmentJourneys"
    static let appearanceKey = "appAppearance"
    static let useMetricUnitsKey = "useMetricUnits"
    static let hasCompletedPairingKey = "hasCompletedPairing"
}
