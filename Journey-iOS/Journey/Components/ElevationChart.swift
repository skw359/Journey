import SwiftUI
import Charts

struct ElevationChart: View, Equatable {
    let distancesMi: [Double]
    let elevationsM: [Double]
    @AppStorage(AppConstants.useMetricUnitsKey) private var useMetricUnits = false
    @State private var selectedDistance: Double?

    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.distancesMi == rhs.distancesMi && lhs.elevationsM == rhs.elevationsM
    }

    private var samples: [ProfileSample] {
        zip(distancesMi, elevationsM).map {
            ProfileSample(
                x: DistanceFormatter.value(fromMiles: $0.0, useMetric: useMetricUnits),
                y: JourneyUnits.elevation(fromMeters: $0.1, useMetric: useMetricUnits)
            )
        }
    }

    var body: some View {
        // Derived once per render; selection drags re-render every frame
        let samples = self.samples
        let selectedPoint = ProfileSample.nearest(to: selectedDistance, in: samples)

        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("ELEVATION PROFILE")
                    .font(.montserrat(size: 12, weight: .bold))
                    .foregroundColor(.gray)
                    .tracking(1)
                Spacer()
                Text("PEAK \(Int((samples.map(\.y).max() ?? 0).rounded())) \(JourneyUnits.elevationUnit(useMetric: useMetricUnits).uppercased())")
                    .font(.montserrat(size: 12, weight: .bold))
                    .foregroundColor(AppConstants.journeyGreen)
            }

            if distancesMi.count >= 2 {
                Chart {
                    // Vectorized plots draw the whole series at once, far faster than a mark per point
                    AreaPlot(samples, x: .value("Distance", \.x), y: .value("Elevation", \.y))
                        .foregroundStyle(
                            LinearGradient(
                                colors: [AppConstants.journeyGreen.opacity(0.4), AppConstants.journeyGreen.opacity(0.05)],
                                startPoint: .top,
                                endPoint: .bottom
                            )
                        )

                    LinePlot(samples, x: .value("Distance", \.x), y: .value("Elevation", \.y))
                        .foregroundStyle(AppConstants.journeyGreen)
                        .lineStyle(StrokeStyle(lineWidth: 1.5))

                    if let selectedPoint {
                        RuleMark(x: .value("Distance", selectedPoint.x))
                            .foregroundStyle(Color.white.opacity(0.25))
                            .lineStyle(StrokeStyle(lineWidth: 1, dash: [4]))

                        PointMark(
                            x: .value("Distance", selectedPoint.x),
                            y: .value("Elevation", selectedPoint.y)
                        )
                        .symbolSize(70)
                        .foregroundStyle(Color.white)
                        .annotation(position: .top, spacing: 10) {
                            selectionBadge(
                                distance: selectedPoint.x,
                                value: "\(Int(selectedPoint.y.rounded()).formatted()) \(JourneyUnits.elevationUnit(useMetric: useMetricUnits).uppercased())",
                                color: AppConstants.journeyGreen
                            )
                        }
                    }
                }
                .chartXScale(
                    domain: ProfileSample.domain(of: samples),
                    range: .plotDimension(startPadding: 0, endPadding: 0)
                )
                .chartXAxisLabel(DistanceFormatter.unit(useMetric: useMetricUnits))
                .chartYAxisLabel(JourneyUnits.elevationUnit(useMetric: useMetricUnits))
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
