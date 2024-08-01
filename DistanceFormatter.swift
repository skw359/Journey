import Foundation

class DistanceFormatter {
    static let shared = DistanceFormatter()
    
    private init() {}
    
    func formatDistance(_ distanceInFeet: Double, isMetric: Bool, usePreciseUnits: Bool? = nil) -> String {
        let value: Double
        let unit: String
        
        if isMetric {
            let meters = distanceInFeet * 0.3048
            if meters < 1000 {
                value = meters
                unit = "meters"
            } else {
                value = meters / 1000
                unit = "km"
            }
        } else {
            if distanceInFeet < 5280 {
                value = distanceInFeet
                unit = "feet"
            } else {
                value = distanceInFeet / 5280
                unit = "miles"
            }
        }
        
        let format: String
        if let usePreciseUnits = usePreciseUnits, usePreciseUnits {
            format = "%.2f"
        } else {
            format = value < 100 ? "%.0f" : "%.1f"
        }
        
        return String(format: "\(format) \(unit)", value)
    }
}
