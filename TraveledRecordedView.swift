import SwiftUI
import CoreLocation

struct TravelRecordedView: View {
    var travelData: TravelData // This will be passed when navigating to this view
    @Environment(\.presentationMode) var presentationMode
    @Binding var navigationPath: NavigationPath
    @ObservedObject var locationManager: LocationManager
    
    func formatTime(totalSeconds: Int) -> String {
        let hours = totalSeconds / 3600
        let minutes = (totalSeconds % 3600) / 60
        
        if hours > 0 {
            return "\(hours)h \(minutes)m"
        } else {
            return "\(minutes)m"
        }
    }
    
    var appropriateFontSize: CGFloat {
        // Check if the total time exceeds 36000 seconds (10 hours)
        if locationManager.totalTime >= 36000 {
            return 15 // Smaller font size for 10 hours or more
            // Check if the total time exceeds 3600 seconds (1 hour)
        } else if locationManager.totalTime >= 3600 {
            return 20 // Smaller font size when hours are present
        } else {
            return 30 // Default font size for less than an hour
        }
    }
    
    var body: some View {
        ScrollView {
            VStack {
                // Miles Traveled Display
                Text(String(format: "%.0f", travelData.milesTraveled))
                    .font(.system(size: 55)) // Makes the text large
                    .bold()
                    .frame(maxWidth: .infinity, alignment: .center) // Centers the text
                
                Text("Miles Traveled")
                    .font(.caption) // Makes the text small and applies caption style
                    .frame(maxWidth: .infinity, alignment: .center)
                    .foregroundColor(Color(hex: "#00ff81"))
                
                Spacer()
                Spacer()
                
                // Top Speed Display
                HStack {
                    // VStack for Top Speed
                    VStack(alignment: .leading) {
                        Text(String(format: "%.0f", travelData.topSpeed))
                            .font(.system(size: 30)) // Adjust font size as needed
                            .bold()
                            .frame(maxWidth: .infinity, alignment: .center)
                        
                        Text("Top Speed")
                            .font(.caption) // Makes the text small and applies caption style
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .foregroundColor(Color(hex: "#00ff81"))
                        
                        Spacer()
                        
                        Text(locationManager.totalTimeTextTimer)
                            .font(.system(size: appropriateFontSize)) // Adjust font size as needed
                        // .bold()
                            .frame(maxWidth: .infinity, alignment: .center)
                        
                        Text("Total Time")
                            .font(.caption) // Makes the text small and applies caption style
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .foregroundColor(Color(hex: "#00ff81"))
                    }
                    
                    Spacer() // This will create space between the two VStacks
                    Spacer()
                    Spacer()
                    Spacer()
                    Spacer()
                    Spacer()
                    Spacer()
                    // Spacer()
                    
                    // VStack for Average Speed
                    VStack(alignment: .leading) {
                        Text(String(format: "%.0f", travelData.averageSpeed))
                            .font(.system(size: 30)) // Adjust font size as needed
                            .bold()
                            .frame(maxWidth: .infinity, alignment: .center)
                        
                        Text("AVG Speed")
                            .font(.caption) // Makes the text small and applies caption style
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .foregroundColor(Color(hex: "#00ff81"))
                        
                        Spacer()
                        
                        Text("--")
                            .font(.system(size: appropriateFontSize)) // Adjust font size as needed
                        // .bold()
                            .frame(maxWidth: .infinity, alignment: .center)
                        
                        Text("Your Pace")
                            .font(.caption) // Makes the text small and applies caption style
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .foregroundColor(Color(hex: "#00ff81"))
                    }
                }
                
                Spacer()
                
                Text("Elevation")
                    .font(.headline)
                ElevationGraphView(readings: locationManager.elevationReadings)
                    .frame(height: 75) // Set a fixed height for testing purposes
                    .border(Color.clear) // Temporarily add a border to see the frame
                
                // Done button
                Button(action: {
                    withAnimation {
                        self.presentationMode.wrappedValue.dismiss()
                    }
                }) {
                    HStack(alignment: .center, spacing: 10) {
                        Text("Done")
                            .fontWeight(.bold)
                            .foregroundColor(.white)
                    }
                    .frame(maxWidth: .infinity)
                    .padding()
                    .background(Color(hex: "#0c3617"))
                    .cornerRadius(15)
                }
                .buttonStyle(PlainButtonStyle())
                .padding()
                .padding()
                .padding()
            }
            .padding()
            .navigationTitle("Travel Recorded")
            .onAppear {
                print("TravelRecordedView appeared with \(locationManager.elevationReadings.count) readings")
            }
            
        }
        .onAppear {
            print("Elevation Readings: \(locationManager.elevationReadings)")
            print("TravelRecordedView appeared with \(locationManager.elevationReadings.count) readings")
        }
        
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
        // Format elevation here, for example to feet
        let elevationInFeet = elevation * 3.281 // Assuming elevation is in meters
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





