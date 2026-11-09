// Compass page with calibration and waypoint bearing.

import SwiftUI
import WatchKit

private let cardinals: [(degrees: Double, name: String)] = [(0, "N"), (90, "E"), (180, "S"), (270, "W")]

private func isAligned(_ heading: Double, with bearing: Double) -> Bool {
    abs((heading - bearing + 540).truncatingRemainder(dividingBy: 360) - 180) <= 10
}

struct CompassPage: View {
    private static let calibrationTime: Duration = .seconds(20)

    let recorder: JourneyRecorder
    @State private var isCalibrating = false
    @State private var figureEight: FigureEightDetector?

    private var isAlignedWithCardinal: Bool {
        cardinals.contains { isAligned(recorder.heading, with: $0.degrees) }
    }

    private var headingText: String {
        let heading = recorder.heading
        let directions = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]
        return "\(Int(heading.rounded()) % 360)° \(directions[Int((heading / 45).rounded()) % 8])"
    }

    var body: some View {
        VStack(spacing: 0) {
            Triangle()
                .fill(isAlignedWithCardinal ? Theme.aligned : Color(hex: 0xFF3B30))
                .frame(width: 20, height: 14)

            ZStack {
                CompassDial(heading: recorder.heading)
                Circle()
                    .fill(Theme.aligned)
                    .frame(width: 10, height: 10)
                    .frame(width: 44, height: 44)
                    .contentShape(.circle)
                    .onLongPressGesture(minimumDuration: 1) {
                        WKInterfaceDevice.current().play(.click)
                        isCalibrating = true
                    }
            }
            .containerRelativeFrame(.horizontal) { width, _ in width * 0.66 }
            .frame(maxHeight: .infinity)

            Text(headingText)
                .font(.system(size: 14))
                .monospacedDigit()
        }
        .padding(.top, 20)
        .padding(.bottom, 18)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .ignoresSafeArea()
        .overlay {
            if isCalibrating { calibrationOverlay }
        }
        .pauseOverlay(recorder.isPaused)
        .task(id: isCalibrating) {
            guard isCalibrating else { return }
            let detector = FigureEightDetector()
            figureEight = detector
            detector.start()
            recorder.restartHeading()
            try? await Task.sleep(for: Self.calibrationTime)
            detector.stop()
            figureEight = nil
            isCalibrating = false
        }
    }

    private var calibrationOverlay: some View {
        let isConfirmed = figureEight?.isConfirmed == true
        return ZStack {
            Color.black.opacity(0.95)
            VStack(spacing: 8) {
                Text("Calibrate Compass").font(.headline)
                Text(isConfirmed ? "That's correct, keep going…" : "Move your device in a figure-8 pattern to calibrate the compass.")
                    .font(.system(size: 13))
                    .multilineTextAlignment(.center)
                    .foregroundStyle(isConfirmed ? Theme.aligned : .white)
                Text("Recalibrating…")
                    .font(.system(size: 14))
                    .foregroundStyle(Color(hex: 0x7A7A7A))
                    .shimmering()
                    .padding(.top, 8)
            }
            .padding(.horizontal, 12)
        }
        .ignoresSafeArea()
    }
}

private struct CompassDial: View {
    private static let tickCount = 24
    private static let tickLength = 6.0

    let heading: Double

    var body: some View {
        Canvas { context, size in
            let center = CGPoint(x: size.width / 2, y: size.height / 2)
            let radius = min(size.width, size.height) / 2

            func point(at bearing: Double, distance: Double) -> CGPoint {
                let angle = (bearing - heading - 90) * .pi / 180
                return CGPoint(x: center.x + cos(angle) * distance, y: center.y + sin(angle) * distance)
            }

            for index in 0..<Self.tickCount {
                let bearing = Double(index) * 360 / Double(Self.tickCount)
                let isLit = cardinals.contains { $0.degrees == bearing && isAligned(heading, with: bearing) }
                var tick = Path()
                tick.move(to: point(at: bearing, distance: radius - Self.tickLength))
                tick.addLine(to: point(at: bearing, distance: radius))
                context.stroke(tick, with: .color(isLit ? Theme.aligned : Color(hex: 0x7A7A7A)), lineWidth: 2)
            }

            for cardinal in cardinals {
                let label = Text(cardinal.name).font(.system(size: 14, weight: .semibold)).foregroundColor(.white)
                context.draw(label, at: point(at: cardinal.degrees, distance: radius * 0.76))
            }
        }
        .aspectRatio(1, contentMode: .fit)
    }
}

private struct Triangle: Shape {
    func path(in rect: CGRect) -> Path {
        Path { path in
            path.move(to: CGPoint(x: rect.midX, y: rect.minY))
            path.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY))
            path.addLine(to: CGPoint(x: rect.minX, y: rect.maxY))
            path.closeSubpath()
        }
    }
}
