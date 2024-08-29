import SwiftUI
import CoreLocation

struct LocationNameElement: View {
    @ObservedObject var locationManager: LocationManager
    @State private var countyName: String = ""
    @State private var lastFetchedCountyName: String? = nil
    @State private var showCounty: Bool = false

    var body: some View {
        Text(displayText)
            .padding(8)
            .background(Color.black.opacity(0.0))
            .cornerRadius(10)
            .foregroundColor(Color(hex: "#bee0ec"))
            .transition(.opacity)
            .animation(.easeInOut(duration: 0.2), value: showCounty)
            .onAppear {
                getLocationInfo()
            }
            .onChange(of: locationManager.latestLocation) {
                getLocationInfo()
            }
            .onTapGesture {
                if !countyName.isEmpty {
                    self.showCounty.toggle()
                }
            }
    }

    private var displayText: String {
        if !countyName.isEmpty {
            return showCounty ? countyName : locationManager.currentLocationName
        } else {
            return locationManager.currentLocationName
        }
    }

    private func getLocationInfo() {
        guard let location = locationManager.latestLocation else {
            self.countyName = ""
            return
        }

        let geocoder = CLGeocoder()
        geocoder.reverseGeocodeLocation(location) { placemarks, error in
            if let error = error {
                print("Geocoding failed with error: \(error.localizedDescription)")
                self.countyName = self.lastFetchedCountyName ?? ""
            } else if let placemark = placemarks?.first {
                let country = placemark.country ?? ""
                
                if country == "United States" {
                    self.handleUSLocation(placemark)
                } else {
                    self.handleNonUSLocation(placemark)
                }
            } else {
                self.countyName = ""
            }
        }
    }

    private func handleUSLocation(_ placemark: CLPlacemark) {
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

        locationManager.currentLocationName = "\(locality), \(state)"
    }

    private func handleNonUSLocation(_ placemark: CLPlacemark) {
        let city = placemark.locality ?? ""
        let country = placemark.country ?? ""
        locationManager.currentLocationName = "\(city), \(country)"
        self.countyName = ""
    }
}
