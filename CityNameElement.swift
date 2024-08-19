import SwiftUI
import CoreLocation

// This is the city/county name element found on RecordingView (toggleable on tap)
struct CityNameElement: View {
    @ObservedObject var locationManager: LocationManager
    @State private var countyName: String = "Fetching..."
    @State private var lastFetchedCountyName: String? = nil  // Store the last successfully fetched county name
    @State private var showCounty: Bool = false  // Initially show the city name first
    
    var body: some View {
        Text(showCounty ? countyName : locationManager.currentLocationName)
            .padding(8)
            .background(Color.black.opacity(0.3))
            .cornerRadius(10)
            .foregroundColor(Color(hex: "#bee0ec"))
            .transition(.opacity)
            .animation(.easeInOut(duration: 0.2), value: showCounty)
            .onAppear {
                getCountyName()
            }
            .onChange(of: locationManager.latestLocation) {
                getCountyName()
            }
            .onTapGesture {
                self.showCounty.toggle()  // Toggle between city and county name on tap
            }
    }
    
    // Check for a valid city or county name.
    // If both locality and subAdministrativeArea are empty, only show the state. So like ", MD" or ", NC", only show the state
    // Otherwise, update both the current and last fetched county names on successful fetch
    private func getCountyName() {
        guard let location = locationManager.latestLocation else {
            self.countyName = "Location not available"
            return
        }
        
        let geocoder = CLGeocoder()
        geocoder.reverseGeocodeLocation(location) { placemarks, error in
            if let error = error {
                print("Geocoding failed with error: \(error.localizedDescription)")
                if let lastSuccessfulCountyName = self.lastFetchedCountyName {
                    self.countyName = lastSuccessfulCountyName
                } else {
                    self.countyName = "Error fetching county"
                }
            } else if let placemark = placemarks?.first {
                let locality = placemark.locality ?? ""
                let subAdministrativeArea = placemark.subAdministrativeArea ?? ""
                let state = placemark.administrativeArea ?? ""
                
                if locality.isEmpty && subAdministrativeArea.isEmpty {
                    
                    self.countyName = state
                } else if subAdministrativeArea == ", \(state)" || locality == ", \(state)" {
                    self.countyName = state
                } else {
                    
                    let fetchedCounty = subAdministrativeArea.isEmpty ? locality : subAdministrativeArea
                    self.countyName = fetchedCounty
                    self.lastFetchedCountyName = fetchedCounty
                }
            } else {
                self.countyName = "No placemark data available"
            }
        }
    }
}
