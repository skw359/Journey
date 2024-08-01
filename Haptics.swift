import WatchKit

struct Haptics {
    static func vibrate(_ type: WKHapticType) {
        WKInterfaceDevice.current().play(type)
    }
}
