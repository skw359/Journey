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

    // Obtains the county name
    private func getCountyName() {
        guard let location = locationManager.latestLocation else {
            self.countyName = "Location not available"
            return
        }
        
        let geocoder = CLGeocoder()
        geocoder.reverseGeocodeLocation(location) { placemarks, error in
            if let error = error {
                print("Geocoding failed with error: \(error.localizedDescription)")
                if let lastSuccessfulCounty = self.lastFetchedCountyName {
                    self.countyName = lastSuccessfulCounty  // Use the last successful fetch as a fallback
                } else {
                    self.countyName = "Error fetching county"
                }
            } else if let placemark = placemarks?.first {
                // Update both the current and last fetched county names on successful fetch
                let fetchedCounty = placemark.subAdministrativeArea ?? "Data not available"
                self.countyName = fetchedCounty
                self.lastFetchedCountyName = fetchedCounty
            } else {
                self.countyName = "No placemark data available"
            }
        }
    }
}
