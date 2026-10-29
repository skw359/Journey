import SwiftUI
import Charts

struct AccelerationChart: View, Equatable {
    let distancesMi: [Double]
    let speedsMph: [Double]
    let timesMs: [Double]
    @AppStorage(AppConstants.useMetricUnitsKey) private var useMetricUnits = false
    @State private var selectedDistance: Double?

    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.distancesMi == rhs.distancesMi && lhs.speedsMph == rhs.speedsMph && lhs.timesMs == rhs.timesMs
    }

    private var chartDistances: [Double] {
        distancesMi.map { DistanceFormatter.value(fromMiles: $0, useMetric: useMetricUnits) }
    }

    /// Acceleration between consecutive profile points, plotted at the later point.
    private func accelerationSamples(distances: [Double]) -> [ProfileSample] {
        let count = min(distances.count, speedsMph.count, timesMs.count)
        guard count >= 2 else { return [] }
        var result: [ProfileSample] = []
        result.reserveCapacity(count - 1)
        for i in 1..<count {
            let dt = (timesMs[i] - timesMs[i-1]) / 1000.0 // seconds
            guard dt > 0 else { continue }
            let accel = JourneyUnits.acceleration(speedDeltaMph: speedsMph[i] - speedsMph[i-1], durationSeconds: dt, useMetric: useMetricUnits)
            result.append(ProfileSample(x: distances[i], y: accel))
        }
        return result
    }

    var body: some View {
        // Derived once per render; selection drags re-render every frame
        let distances = chartDistances
        let samples = accelerationSamples(distances: distances)
        let selectedPoint = ProfileSample.nearest(to: selectedDistance, in: samples)

        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("ACCELERATION")
                    .font(.montserrat(size: 12, weight: .bold))
                    .foregroundColor(.gray)
                    .tracking(1)
                Spacer()
                Text("PEAK \(String(format: "%.1f", samples.map { abs($0.y) }.max() ?? 0)) \(JourneyUnits.accelerationUnit(useMetric: useMetricUnits).uppercased())")
                    .font(.montserrat(size: 12, weight: .bold))
                    .foregroundColor(AppConstants.redAction)
            }

            if samples.count >= 2 {
                Chart {
                    // A vectorized plot draws the whole series at once, far faster than a mark per point
                    LinePlot(samples, x: .value("Distance", \.x), y: .value("Acceleration", \.y))
                        .foregroundStyle(AppConstants.redAction)
                        .lineStyle(StrokeStyle(lineWidth: 1.5))

                    // Zero line
                    RuleMark(y: .value("Zero", 0))
                        .foregroundStyle(.gray.opacity(0.5))
                        .lineStyle(StrokeStyle(lineWidth: 0.5, dash: [4]))

                    if let selectedPoint {
                        RuleMark(x: .value("Distance", selectedPoint.x))
                            .foregroundStyle(Color.white.opacity(0.25))
                            .lineStyle(StrokeStyle(lineWidth: 1, dash: [4]))

                        PointMark(
                            x: .value("Distance", selectedPoint.x),
                            y: .value("Acceleration", selectedPoint.y)
                        )
                        .symbolSize(70)
                        .foregroundStyle(Color.white)
                        .annotation(position: .top, spacing: 10) {
                            selectionBadge(
                                distance: selectedPoint.x,
                                value: "\(String(format: "%+.2f", selectedPoint.y)) \(JourneyUnits.accelerationUnit(useMetric: useMetricUnits).uppercased())",
                                color: AppConstants.redAction
                            )
                        }
                    }
                }
                .chartXScale(
                    domain: ProfileSample.domain(of: distances),
                    range: .plotDimension(startPadding: 0, endPadding: 0)
                )
                .chartXAxis {
                    AxisMarks(values: .automatic(desiredCount: 4)) {
                        AxisGridLine(stroke: StrokeStyle(lineWidth: 0.5, dash: [4]))
                            .foregroundStyle(Color.gray.opacity(0.3))
                        AxisValueLabel()
                            .foregroundStyle(.gray)
                    }
                }
                .chartYAxis {
                    AxisMarks(values: .automatic(desiredCount: 4)) {
                        AxisGridLine(stroke: StrokeStyle(lineWidth: 0.5, dash: [4]))
                            .foregroundStyle(Color.gray.opacity(0.3))
                        AxisValueLabel()
                            .foregroundStyle(.gray)
                    }
                }
                .chartOverlay { proxy in
                    GeometryReader { geometry in
                        Rectangle()
                            .fill(Color.clear)
                            .contentShape(Rectangle())
                            .gesture(
                                DragGesture(minimumDistance: 0)
                                    .onChanged { value in
                                        updateSelection(at: value.location, proxy: proxy, geometry: geometry)
                                    }
                                    .onEnded { _ in
                                        selectedDistance = nil
                                    }
                            )
                    }
                }
                .frame(height: 160)
            } else {
                Text("Not enough data")
                    .foregroundColor(.gray)
                    .frame(height: 160)
                    .frame(maxWidth: .infinity)
            }
        }
        .padding(16)
        .background(
            RoundedRectangle(cornerRadius: 16)
                .fill(AppConstants.darkCardBackground)
                .overlay(
                    RoundedRectangle(cornerRadius: 16)
                        .stroke(AppConstants.darkCardBorder, lineWidth: 1)
                )
        )
    }

    private func updateSelection(at location: CGPoint, proxy: ChartProxy, geometry: GeometryProxy) {
        let frame = geometry[proxy.plotAreaFrame]
        guard frame.contains(location) else {
            selectedDistance = nil
            return
        }

        let positionX = location.x - frame.origin.x
        guard let distance = proxy.value(atX: positionX, as: Double.self) else { return }
        selectedDistance = distance
    }

    @ViewBuilder
    private func selectionBadge(distance: Double, value: String, color: Color) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("AT \(String(format: "%.2f", distance)) \(DistanceFormatter.unit(useMetric: useMetricUnits).uppercased())")
                .font(.montserrat(size: 9, weight: .bold))
                .foregroundColor(.gray)
            Text(value)
                .font(.montserrat(size: 11, weight: .bold))
                .foregroundColor(color)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .background(
            RoundedRectangle(cornerRadius: 10)
                .fill(AppConstants.darkCardBackground.opacity(0.96))
                .overlay(
                    RoundedRectangle(cornerRadius: 10)
                        .stroke(AppConstants.darkCardBorder, lineWidth: 1)
                )
        )
    }
}
