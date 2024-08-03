import Foundation

class DistanceFormatter {
    static let shared = DistanceFormatter()
    
    private init() {}
    
    func formatDistance(_ distanceInFeet: Double, isMetric: Bool) -> String {
        if isMetric {
            return formatMetricDistance(distanceInFeet)
        } else {
            return formatImperialDistance(distanceInFeet)
        }
    }
    
    private func formatMetricDistance(_ distanceInFeet: Double) -> String {
        let meters = distanceInFeet * 0.3048
        if meters < 1000 {
            return "\(Int(round(meters))) m"
        } else {
            let kilometers = meters / 1000
            if kilometers < 10 {
                return String(format: "%.1f km", kilometers)
            } else {
                return "\(Int(round(kilometers))) km"
            }
        }
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
