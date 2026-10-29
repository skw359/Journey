import SwiftUI
import CoreLocation

struct CityNameElement: View {
    @ObservedObject var recorder: JourneyRecorder
    @State private var showCounty: Bool = false

    var body: some View {
        Text(displayText)
            .font(.system(size: 16, weight: .medium, design: .default))
            .padding(8)
            .background(Color.black.opacity(0.0))
            .cornerRadius(10)
            .foregroundColor(Color(hex: "#bee0ec"))
            .multilineTextAlignment(.center)
            .lineLimit(1)
            .minimumScaleFactor(0.8)
            .animation(.easeInOut(duration: 0.2), value: showCounty)
            .onTapGesture {
                if !recorder.currentCountyName.isEmpty {
                    showCounty.toggle()
                }
            }
    }

    private var displayText: String {
        if showCounty && !recorder.currentCountyName.isEmpty {
            return recorder.currentCountyName
        } else {
            return recorder.currentLocationName.isEmpty ?
                "Locating..." : recorder.currentLocationName
        }
    }
}
