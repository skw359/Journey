import Foundation
import UserNotifications

class NotificationManager {
    static func sendNotificationWith(message: String) {
        let content = UNMutableNotificationContent()
        content.title = "Altitude Alert"
        content.body = message
        content.sound = .default
        
        let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request)
    }
}
