import SwiftUI
import CoreLocation

struct TravelRecordedView: View {
    var travelData: TravelData
    @Environment(\.presentationMode) var presentationMode
    @Binding var navigationPath: NavigationPath
    @ObservedObject var locationManager: LocationManager
    
    var temporaryFontSizeFix: CGFloat {
        if locationManager.totalTime >= 36000 {
            return 15
        } else if locationManager.totalTime >= 3600 {
            return 20
        } else {
            return 30
        }
    }
    
    var body: some View {
        ScrollView {
            VStack(spacing: 20) {
                milesTraveled
                speedAndTimeSection
                elevationSection
                doneButton
            }
            .padding()
        }
        .navigationTitle("Travel Recorded")
        .onAppear(perform: debugInfo)
    }
    
    private var milesTraveled: some View {
        VStack(spacing: 5) {
            Text(String(format: "%.0f", travelData.milesTraveled))
                .font(.system(size: 55))
                .bold()
            
            Text("Miles Traveled")
                .font(.caption)
                .foregroundColor(Color(hex: "#00ff81"))
        }
    }
    
    // Top speed, avg speed, total time
    private var speedAndTimeSection: some View {
        HStack {
            dataDisplay(topValue: String(format: "%.0f", travelData.topSpeed),
                        topLabel: "Top Speed",
                        bottomValue: locationManager.totalTimeTextTimer,
                        bottomLabel: "Total Time")
            
            Spacer()
            
            dataDisplay(topValue: String(format: "%.0f", travelData.averageSpeed),
                        topLabel: "AVG Speed",
                        bottomValue: "--",
                        bottomLabel: "--")
        }
    }
    
    // Creates a vertical display of two data points, each with a value and label. Used for displaying the speed and time information
    private func dataDisplay(topValue: String, topLabel: String, bottomValue: String, bottomLabel: String) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            VStack(alignment: .leading, spacing: 5) {
                Text(topValue)
                    .font(.system(size: 30))
                    .bold()
                    .frame(maxWidth: .infinity, alignment: .center)
                Text(topLabel)
                    .font(.caption)
                    .foregroundColor(Color(hex: "#00ff81"))
            }
            
            VStack(alignment: .leading, spacing: 5) {
                Text(bottomValue)
                    .font(.system(size: temporaryFontSizeFix))
                    .frame(maxWidth: .infinity, alignment: .center)
                Text(bottomLabel)
                    .font(.caption)
                    .foregroundColor(Color(hex: "#00ff81"))
            }
        }
    }
    
    // computed property creates the elevation graph section of the view
    private var elevationSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Elevation")
                .font(.headline)
            
            ElevationGraphView(readings: locationManager.elevationReadings)
                .frame(height: 75)
                .border(Color.clear)
        }
    }
    
    private var doneButton: some View {
        Button(action: { withAnimation { self.presentationMode.wrappedValue.dismiss() } }) {
            Text("Done")
                .fontWeight(.bold)
                .foregroundColor(.white)
                .frame(maxWidth: .infinity)
                .padding()
                .background(Color(hex: "#0c3617"))
                .cornerRadius(15)
        }
        .buttonStyle(PlainButtonStyle())
        .padding(.vertical, 40)
    }
    
    private func debugInfo() {
        print("Elevation Readings: \(locationManager.elevationReadings)")
        print("TravelRecordedView appeared with \(locationManager.elevationReadings.count) readings")
        print("Total Time: \(locationManager.totalTimeTimer)")
        print("Formatted Time: \(locationManager.totalTimeTextTimer)")
    }
}

struct ElevationGraphView: View {
    var readings: [ElevationReading]
    
    // Calculate max, min, and starting elevations, and format times
    private var maxElevation: String {
        let maxElev = readings.map { $0.elevation }.max() ?? 0
        return formatElevation(maxElev)
    }
    
    private var minElevation: String {
        let minElev = readings.map { $0.elevation }.min() ?? 0
        return formatElevation(minElev)
    }
    
    private var startElevation: String {
        let startElev = readings.first?.elevation ?? 0
        return formatElevation(startElev)
    }
    
    private var startTime: String {
        let formatter = DateFormatter()
        formatter.timeStyle = .short
        return formatter.string(from: readings.first?.time ?? Date())
    }
    
    private var endTime: String {
        let formatter = DateFormatter()
        formatter.timeStyle = .short
        return formatter.string(from: readings.last?.time ?? Date())
    }
    
    private func formatElevation(_ elevation: Double) -> String {
        let elevationInFeet = elevation * 3.281
        return "\(String(format: "%.0f", elevationInFeet))"
    }
    
    private func scaleReading(_ reading: ElevationReading, in size: CGSize) -> CGPoint {
        let initialElevation = readings.first?.elevation ?? 0
        let maxElevationChange = readings.map { abs($0.elevation - initialElevation) }.max() ?? 1
        
        let totalTime = readings.last?.time.timeIntervalSince(readings.first?.time ?? Date()) ?? 1
        let timeElapsed = reading.time.timeIntervalSince(readings.first?.time ?? Date())
        
        let elevationDelta = reading.elevation - initialElevation
        
        let xScale = size.width / CGFloat(totalTime)
        let yMidPoint = size.height / 2
        let yScale = yMidPoint / maxElevationChange
        
        let x = xScale * CGFloat(timeElapsed)
        let y = yMidPoint - (CGFloat(elevationDelta) * yScale)
        
        return CGPoint(x: x, y: y)
    }
    
    var body: some View {
        GeometryReader { geometry in
            
            Path { path in
                let points = readings.map { scaleReading($0, in: geometry.size) }
                print("Points for graph: \(points)") // Debug: print the points
                guard let firstPoint = points.first else { return }
                
                path.move(to: firstPoint)
                for point in points.dropFirst() {
                    path.addLine(to: point)
                }
            }
            .stroke(Color.green, lineWidth: 2)
            
            // Y-Axis (Elevation) labels and line
            VStack {
                Text(maxElevation).foregroundColor(.gray)
                Spacer()
                Text(startElevation).foregroundColor(.gray)
                Spacer()
                Text(minElevation).foregroundColor(.gray)
            }
            .frame(height: geometry.size.height)
            .padding(.leading)
            
            // Draw the Y-axis line
            Path { path in
                path.move(to: CGPoint(x: 0, y: 0))
                path.addLine(to: CGPoint(x: 0, y: geometry.size.height))
            }
            .stroke(Color.gray, lineWidth: 1)
            
            // X-Axis (Time) labels and line
            HStack {
                Text(startTime).foregroundColor(.gray)
                Spacer()
                Text(endTime).foregroundColor(.gray)
            }
            .frame(width: geometry.size.width)
            .padding(.top, geometry.size.height)
            
            // Draw the X-axis line
            Path { path in
                path.move(to: CGPoint(x: 0, y: geometry.size.height))
                path.addLine(to: CGPoint(x: geometry.size.width, y: geometry.size.height))
            }
            .stroke(Color.gray, lineWidth: 1)
            
        }
    }
}





