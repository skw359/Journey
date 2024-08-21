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
                speedSection
                accelerationSection
                doneButton
            }
            .padding()
        }
        .navigationTitle("Travel Recorded")
        .onAppear(perform: debugInfo)
        .toolbar(.hidden, for: .navigationBar)
    }
    
    private var speedSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Speed Over Time")
                .font(.headline)
                .fontWeight(.bold)
            
            SpeedGraphView(readings: locationManager.speedReadings)
                .frame(height: 125)
                .border(Color.clear)
        }
    }
    
    private var accelerationSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Acceleration")
                .font(.headline)
                .fontWeight(.bold)
            
            AccelerationGraphView(
                readings: locationManager.accelerationReadings,
                startTime: locationManager.startTime ?? Date(),
                endTime: Date()
            )
            .frame(height: 125)
            .border(Color.clear)
        }
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
                        bottomValue: String(format: "%.0f"),
                        bottomLabel: "--")
        }
    }
    
    // Creates a vertical display of two data points, each with a value and label. Used for displaying the speed and time information
    private func dataDisplay(topValue: String, topLabel: String, bottomValue: String, bottomLabel: String) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            VStack(alignment: .leading, spacing: 5) {
                Text(topValue)
                    .font(.system(size: 30))
                
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
    
    private var maxElevation: String {
        let maxElev = locationManager.elevationReadings.map { $0.elevation }.max() ?? 0
        return formatElevation(maxElev)
    }
    
    private var minElevation: String {
        let minElev = locationManager.elevationReadings.map { $0.elevation }.min() ?? 0
        return formatElevation(minElev)
    }
    
    private func formatElevation(_ elevation: Double) -> String {
        let elevationInFeet = elevation * 3.281
        return "\(String(format: "%.0f", elevationInFeet)) ft"
    }
    
    // computed property creates the elevation graph section of the view
    private var elevationSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Elevation")
                .font(.headline)
            
            HStack(alignment: .center, spacing: 20) {
                VStack(alignment: .leading, spacing: 0) {
                    HStack(spacing: 5) {
                        Image(systemName: "triangle.fill")
                            .foregroundColor(Color(hex: "#00ff81"))
                        Text(maxElevation)
                    }
                    HStack(spacing: 5) {
                        Image(systemName: "triangle.fill")
                            .foregroundColor(Color(hex: "#00ff81"))
                            .rotationEffect(.degrees(180))
                        Text(minElevation)
                    }
                }
                .font(.subheadline)
                
                Spacer()
            }
            
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

// MARK: Graphs

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
    
    private let leftPadding: CGFloat = 20
    private let bottomPadding: CGFloat = 20 // Added for time labels
    
    private func scaleReading(_ reading: ElevationReading, in size: CGSize) -> CGPoint {
        let initialElevation = readings.first?.elevation ?? 0
        let maxElevationChange = readings.map { abs($0.elevation - initialElevation) }.max() ?? 1
        
        let totalTime = readings.last?.time.timeIntervalSince(readings.first?.time ?? Date()) ?? 1
        let timeElapsed = reading.time.timeIntervalSince(readings.first?.time ?? Date())
        
        let elevationDelta = reading.elevation - initialElevation
        
        let xScale = (size.width - leftPadding) / CGFloat(totalTime)
        let yMidPoint = (size.height - bottomPadding) / 2
        let yScale = yMidPoint / maxElevationChange
        
        let x = xScale * CGFloat(timeElapsed) + leftPadding
        let y = yMidPoint - (CGFloat(elevationDelta) * yScale)
        
        return CGPoint(x: x, y: y)
    }
    
    var body: some View {
        GeometryReader { geometry in
            ZStack {
                // Y-Axis (Elevation) labels
                VStack {
                    Text(maxElevation).foregroundColor(.gray).font(.footnote)
                    Spacer()
                    Text(minElevation).foregroundColor(.gray).font(.footnote)
                }
                .frame(height: geometry.size.height - bottomPadding)
                .position(x: leftPadding / 2 - 5, y: (geometry.size.height - bottomPadding) / 2)
                
                // Graph and axis lines
                Path { path in
                    let points = readings.map { scaleReading($0, in: geometry.size) }
                    guard let firstPoint = points.first else { return }
                    
                    path.move(to: firstPoint)
                    for point in points.dropFirst() {
                        path.addLine(to: point)
                    }
                }
                .stroke(Color.green, lineWidth: 2)
                
                // Draw horizontal line at top elevation
                Path { path in
                    path.move(to: CGPoint(x: leftPadding, y: 0))
                    path.addLine(to: CGPoint(x: geometry.size.width, y: 0))
                }
                .stroke(Color(hex: "#2e2e2e"), lineWidth: 1)
                
                // Draw horizontal line at middle elevation
                Path { path in
                    path.move(to: CGPoint(x: leftPadding, y: (geometry.size.height - bottomPadding) / 2))
                    path.addLine(to: CGPoint(x: geometry.size.width, y: (geometry.size.height - bottomPadding) / 2))
                }
                .stroke(Color(hex: "#2e2e2e"), lineWidth: 1)
                
                // X-Axis (Time) labels
                VStack {
                    Spacer()
                    HStack {
                        Text(startTime).foregroundColor(.gray).font(.footnote)
                        Spacer()
                        Text(endTime).foregroundColor(.gray).font(.footnote)
                    }
                    .frame(width: geometry.size.width - leftPadding)
                    .offset(x: leftPadding / 2, y: bottomPadding / 2)
                }
                
                // Draw the X-axis line
                Path { path in
                    path.move(to: CGPoint(x: leftPadding, y: geometry.size.height - bottomPadding))
                    path.addLine(to: CGPoint(x: geometry.size.width, y: geometry.size.height - bottomPadding))
                }
                .stroke(Color(hex: "#2e2e2e"), lineWidth: 1)
            }
            
        }
        
    }
    
}

struct SpeedGraphView: View {
    var readings: [SpeedReading]
    
    private var maxSpeed: String {
        let maxSpeed = readings.map { $0.speed }.max() ?? 0
        return String(format: "%.0f", maxSpeed)
    }
    
    private var minSpeed: String {
        let minSpeed = readings.map { $0.speed }.min() ?? 0
        return String(format: "%.0f", minSpeed)
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
    
    private let leftPadding: CGFloat = 20
    private let bottomPadding: CGFloat = 20
    
    private func scaleReading(_ reading: SpeedReading, in size: CGSize) -> CGPoint {
        let maxSpeed = readings.map { $0.speed }.max() ?? 1
        let totalTime = readings.last?.time.timeIntervalSince(readings.first?.time ?? Date()) ?? 1
        let timeElapsed = reading.time.timeIntervalSince(readings.first?.time ?? Date())
        
        let xScale = (size.width - leftPadding) / CGFloat(totalTime)
        let yScale = (size.height - bottomPadding) / CGFloat(maxSpeed)
        
        let x = xScale * CGFloat(timeElapsed) + leftPadding
        let y = size.height - (CGFloat(reading.speed) * yScale) - bottomPadding
        
        return CGPoint(x: x, y: y)
    }
    
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .center, spacing: 20) {
                VStack(alignment: .leading, spacing: 0) {
                    /*
                     HStack(spacing: 5) {
                     Image(systemName: "bolt.circle.fill")
                     .foregroundColor(Color(hex: "#00ff81"))
                     Text("\(maxSpeed) ")
                     + Text("mph").font(.caption2)
                     
                     }
                     */
                }
                .font(.subheadline)
                Spacer()
            }
            
            GeometryReader { geometry in
                ZStack {
                    // Y-Axis (Speed) labels
                    VStack {
                        Text(maxSpeed).foregroundColor(.gray).font(.footnote)
                        Spacer()
                        Text(minSpeed).foregroundColor(.gray).font(.footnote)
                    }
                    .frame(height: geometry.size.height - bottomPadding)
                    .position(x: leftPadding / 2 - 5, y: (geometry.size.height - bottomPadding) / 2)
                    
                    // Graph and axis lines
                    Path { path in
                        let points = readings.map { scaleReading($0, in: geometry.size) }
                        guard let firstPoint = points.first else { return }
                        
                        path.move(to: firstPoint)
                        for point in points.dropFirst() {
                            path.addLine(to: point)
                        }
                    }
                    .stroke(Color.orange, lineWidth: 2)
                    
                    // Draw horizontal lines
                    Path { path in
                        path.move(to: CGPoint(x: leftPadding, y: 0))
                        path.addLine(to: CGPoint(x: geometry.size.width, y: 0))
                    }
                    .stroke(Color(hex: "#2e2e2e"), lineWidth: 1)
                    
                    Path { path in
                        path.move(to: CGPoint(x: leftPadding, y: (geometry.size.height - bottomPadding) / 2))
                        path.addLine(to: CGPoint(x: geometry.size.width, y: (geometry.size.height - bottomPadding) / 2))
                    }
                    .stroke(Color(hex: "#2e2e2e"), lineWidth: 1)
                    
                    // X-Axis (Time) labels
                    VStack {
                        Spacer()
                        HStack {
                            Text(startTime).foregroundColor(.gray).font(.footnote)
                            Spacer()
                            Text(endTime).foregroundColor(.gray).font(.footnote)
                        }
                        .frame(width: geometry.size.width - leftPadding)
                        .offset(x: leftPadding / 2, y: bottomPadding / 2)
                    }
                    
                    // Draw the X-axis line
                    Path { path in
                        path.move(to: CGPoint(x: leftPadding, y: geometry.size.height - bottomPadding))
                        path.addLine(to: CGPoint(x: geometry.size.width, y: geometry.size.height - bottomPadding))
                    }
                    .stroke(Color(hex: "#2e2e2e"), lineWidth: 1)
                }
            }
        }
    }
}

struct AccelerationGraphView: View {
    var readings: [Double]
    var startTime: Date
    var endTime: Date
    
    private var maxAcceleration: Double {
        readings.max() ?? 0
    }
    
    private var minAcceleration: Double {
        readings.min() ?? 0
    }
    
    private var startTimeString: String {
        let formatter = DateFormatter()
        formatter.timeStyle = .short
        return formatter.string(from: startTime)
    }
    
    private var endTimeString: String {
        let formatter = DateFormatter()
        formatter.timeStyle = .short
        return formatter.string(from: endTime)
    }
    
    private let leftPadding: CGFloat = 20
    private let bottomPadding: CGFloat = 20
    
    private func scaleReading(_ reading: Double, index: Int, in size: CGSize) -> CGPoint {
        let maxAbsAcceleration = readings.map { abs($0) }.max() ?? 1
        
        let xScale = (size.width - leftPadding) / CGFloat(readings.count - 1)
        let yMidPoint = (size.height - bottomPadding) / 2
        let yScale = yMidPoint / CGFloat(maxAbsAcceleration)
        
        let x = xScale * CGFloat(index) + leftPadding
        let y = yMidPoint - (CGFloat(reading) * yScale)
        
        return CGPoint(x: x, y: y)
    }
    
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .center, spacing: 20) {
                VStack(alignment: .leading, spacing: 0) {
                    HStack(spacing: 5) {
                        Image(systemName: "arrow.up.right")
                            .foregroundColor(Color(hex: "#00ff81"))
                        Text(String(format: "%.1f ", maxAcceleration)) +
                        Text("m/s").font(.caption2) +
                        Text("²").font(.caption2).baselineOffset(4)
                    }
                    HStack(spacing: 5) {
                        Image(systemName: "arrow.down.right")
                            .foregroundColor(Color(hex: "#00ff81"))
                        Text(String(format: "%.1f ", minAcceleration)) +
                        Text("m/s").font(.caption2) +
                        Text("²").font(.caption2).baselineOffset(4)
                        
                    }
                }
                .font(.subheadline)
                
                Spacer()
            }
            
            GeometryReader { geometry in
                ZStack {
                    // Y-Axis (Acceleration) labels
                    VStack {
                        Text(String(format: "%.1f", maxAcceleration)).foregroundColor(.gray).font(.footnote)
                        Spacer()
                        Text("0").foregroundColor(.gray).font(.footnote)
                        Spacer()
                        Text(String(format: "%.1f", minAcceleration)).foregroundColor(.gray).font(.footnote)
                    }
                    .frame(height: geometry.size.height - bottomPadding)
                    .position(x: leftPadding / 2 - 5, y: (geometry.size.height - bottomPadding) / 2)
                    
                    // Graph and axis lines
                    Path { path in
                        let points = readings.enumerated().map { scaleReading($0.element, index: $0.offset, in: geometry.size) }
                        guard let firstPoint = points.first else { return }
                        
                        path.move(to: firstPoint)
                        for point in points.dropFirst() {
                            path.addLine(to: point)
                        }
                    }
                    .stroke(Color.blue, lineWidth: 2)
                    
                    // Draw horizontal lines
                    Path { path in
                        path.move(to: CGPoint(x: leftPadding, y: 0))
                        path.addLine(to: CGPoint(x: geometry.size.width, y: 0))
                    }
                    .stroke(Color(hex: "#2e2e2e"), lineWidth: 1)
                    
                    Path { path in
                        path.move(to: CGPoint(x: leftPadding, y: (geometry.size.height - bottomPadding) / 2))
                        path.addLine(to: CGPoint(x: geometry.size.width, y: (geometry.size.height - bottomPadding) / 2))
                    }
                    .stroke(Color(hex: "#2e2e2e"), lineWidth: 1)
                    
                    Path { path in
                        path.move(to: CGPoint(x: leftPadding, y: geometry.size.height - bottomPadding))
                        path.addLine(to: CGPoint(x: geometry.size.width, y: geometry.size.height - bottomPadding))
                    }
                    .stroke(Color(hex: "#2e2e2e"), lineWidth: 1)
                    
                    // X-Axis (Time) labels
                    VStack {
                        Spacer()
                        HStack {
                            Text(startTimeString).foregroundColor(.gray).font(.footnote)
                            Spacer()
                            Text(endTimeString).foregroundColor(.gray).font(.footnote)
                        }
                        .frame(width: geometry.size.width - leftPadding)
                        .offset(x: leftPadding / 2, y: bottomPadding / 2)
                    }
                }
            }
        }
    }
}
