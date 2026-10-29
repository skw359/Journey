import Foundation
import CoreLocation

@Observable
final class GeocodingService {
    static let shared = GeocodingService()

    var currentCity: String = ""
    var currentState: String = ""
    var currentRoad: String = ""

    private var lastCityLookupLocation: CLLocation?
    private var lastCityLookupTime: Date?
    private var lastRoadLookupTime: Date?

    private init() {}

    func updateLocation(_ location: CLLocation, speedMph: Double) {
        updateCity(location)
        if speedMph > 15 {
            updateRoad(location)
        } else {
            currentRoad = ""
        }
    }

    private func updateCity(_ location: CLLocation) {
        let now = Date()
        // Throttle: max once per 30s or 500m moved
        if let lastTime = lastCityLookupTime, now.timeIntervalSince(lastTime) < 30 {
            if let lastLoc = lastCityLookupLocation, location.distance(from: lastLoc) < 500 {
                return
            }
        }
        lastCityLookupTime = now
        lastCityLookupLocation = location

        Task {
            let result = await lookupCity(lat: location.coordinate.latitude, lon: location.coordinate.longitude)
            await MainActor.run {
                if let result {
                    self.currentCity = result.city
                    self.currentState = result.state
                }
            }
        }
    }

    private func updateRoad(_ location: CLLocation) {
        let now = Date()
        if let lastTime = lastRoadLookupTime, now.timeIntervalSince(lastTime) < 10 {
            return
        }
        lastRoadLookupTime = now

        Task {
            let result = await lookupRoad(lat: location.coordinate.latitude, lon: location.coordinate.longitude)
            await MainActor.run {
                if let result { self.currentRoad = result }
            }
        }
    }

    private func lookupCity(lat: Double, lon: Double) async -> (city: String, state: String)? {
        guard let base = AppConstants.geocodeBaseURL,
              let url = URL(string: "\(base)/lookup?lat=\(lat)&lon=\(lon)") else { return nil }
        do {
            let (data, _) = try await URLSession.shared.data(from: url)
            if let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
               let city = json["city"] as? String {
                let state = (json["state_code"] as? String) ?? ""
                return (city, state)
            }
        } catch {}
        return nil
    }

    private func lookupRoad(lat: Double, lon: Double) async -> String? {
        guard let base = AppConstants.geocodeBaseURL,
              let url = URL(string: "\(base)/road?lat=\(lat)&lon=\(lon)") else { return nil }
        do {
            let (data, _) = try await URLSession.shared.data(from: url)
            if let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
               let road = json["road"] as? String {
                return road
            }
        } catch {}
        return nil
    }
}
