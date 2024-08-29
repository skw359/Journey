import SwiftUI
import CoreLocation

struct LocationNameElement: View {
    @ObservedObject var locationManager: LocationManager
    @State private var locationInfo: (name: String, county: String) = ("", "")
    @State private var showCounty: Bool = false
    
    var body: some View {
        Text(displayText)
            .padding(8)
            .background(Color.black.opacity(0.0))
            .cornerRadius(10)
            .foregroundColor(Color(hex: "#bee0ec"))
            .transition(.opacity)
            .animation(.easeInOut(duration: 0.2), value: showCounty)
            .onAppear(perform: updateLocationInfo)
            .onChange(of: locationManager.latestLocation) {
                updateLocationInfo()
            }
            .onTapGesture {
                if !locationInfo.county.isEmpty {
                    showCounty.toggle()
                }
            }
    }
    
    private var displayText: String {
        showCounty && !locationInfo.county.isEmpty ? locationInfo.county : locationInfo.name
    }
    
    private func updateLocationInfo() {
        guard let location = locationManager.latestLocation else {
            locationInfo = ("", "")
            return
        }
        
        CLGeocoder().reverseGeocodeLocation(location) { placemarks, error in
            DispatchQueue.main.async {
                if let error = error {
                    print("Geocoding failed with error: \(error.localizedDescription)")
                    // Keep the previous location info in case of error
                    return
                }
                
                guard let placemark = placemarks?.first else {
                    locationInfo = ("", "")
                    return
                }
                
                let country = placemark.country ?? ""
                let city = placemark.locality ?? ""
                let state = placemark.administrativeArea ?? ""
                let subAdministrativeArea = placemark.subAdministrativeArea ?? ""
                
                if country == "United States" {
                    let countyName: String
                    if city.isEmpty && subAdministrativeArea.isEmpty {
                        countyName = state
                    } else if subAdministrativeArea == ", \(state)" || city == ", \(state)" {
                        countyName = state
                    } else {
                        countyName = subAdministrativeArea.isEmpty ? city : subAdministrativeArea
                    }
                    locationInfo = ("\(city), \(state)", countyName)
                } else {
                    locationInfo = ("\(city), \(country)", "")
                }
                
                locationManager.currentLocationName = locationInfo.name
            }
        }
    }
}
