import Foundation

class UserSettings: ObservableObject {
    @Published var usePreciseUnits: Bool {
        didSet {
            UserDefaults.standard.set(usePreciseUnits, forKey: "usePreciseUnits")
        }
    }

    @Published var isDarkMode: Bool {
        didSet {
            UserDefaults.standard.set(isDarkMode, forKey: "isDarkMode")
        }
    }

    init() {
        usePreciseUnits = UserDefaults.standard.bool(forKey: "usePreciseUnits")
        isDarkMode = UserDefaults.standard.bool(forKey: "isDarkMode")
    }
}
