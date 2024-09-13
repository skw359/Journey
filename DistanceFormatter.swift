import Foundation

class DistanceFormatter {
    static let shared = DistanceFormatter()
    
    private init() {}
    
    func formatDistance(_ distanceInFeet: Double) -> String {
        return formatImperialDistance(distanceInFeet)
    }
    
    private func formatImperialDistance(_ distanceInFeet: Double) -> String {
        if distanceInFeet < 528 {
            return "\(Int(round(distanceInFeet))) ft"
        } else {
            let miles = distanceInFeet / 5280
            if miles < 1 {
                return String(format: "%.1f mi", miles)
            } else if miles < 10 {
                return String(format: "%.1f mi", miles)
            } else {
                return "\(Int(round(miles))) mi"
            }
        }
    }
}
