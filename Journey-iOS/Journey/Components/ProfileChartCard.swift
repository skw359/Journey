// Interactive chart card for a journey's speed, elevation and acceleration profiles.

import SwiftUI
import Charts
import Accessibility

enum ProfileChartKind {
    case elevation, speed, acceleration

    var title: String {
        switch self {
        case .elevation: "ELEVATION"
        case .speed: "SPEED"
        case .acceleration: "ACCELERATION"
        }
    }

    var accessibilityTitle: String {
        switch self {
        case .elevation: "Elevation profile"
        case .speed: "Speed profile"
        case .acceleration: "Acceleration profile"
        }
    }

    var accessibilityIdentifier: String {
        switch self {
        case .elevation: "profileChart.elevation"
        case .speed: "profileChart.speed"
        case .acceleration: "profileChart.acceleration"
        }
    }

    func tint(for scheme: ColorScheme) -> Color {
        switch (self, scheme) {
        case (.elevation, .dark): AppConstants.journeyGreen
        case (.speed, .dark): AppConstants.electricBlue
        case (.acceleration, .dark): AppConstants.redAction
        case (.elevation, _): Color(hex: "#008F48")
        case (.speed, _): Color(hex: "#0A78B4")
        case (.acceleration, _): Color(hex: "#D92B20")
        }
    }
}

struct ProfileStat {
    let label: String
    let value: String
    let unit: String
    let spokenValue: String
    var isReferenceLine = false
}

struct ProfileChartContent {
    let kind: ProfileChartKind
    let samples: [ProfileSample]
    let yAxis: ProfileAxis
    let xAxis: ProfileAxis
    let xUnit: String
    let spokenXUnit: String
    let yUnit: String
    let spokenYUnit: String
    let headline: ProfileStat
    let secondary: ProfileStat?
    let referenceLine: Double?
    let signedYAxis: Bool
    let formatValue: (Double) -> String
    let describeValue: ((Double) -> String?)?

    var hasEnoughData: Bool {
        guard samples.count >= 2, let first = samples.first, let last = samples.last else { return false }
        return last.x > first.x
    }

    static func xAxis(distancesMi: [Double], useMetric: Bool) -> ProfileAxis {
        let finite = distancesMi.filter(\.isFinite)
        return ProfileAxis.x(
            lower: JourneyUnits.distance(fromMiles: finite.min() ?? 0, useMetric: useMetric),
            upper: JourneyUnits.distance(fromMiles: finite.max() ?? 0, useMetric: useMetric)
        )
    }

    init(
        kind: ProfileChartKind,
        samples: [ProfileSample],
        yStyle: ProfileAxis.YStyle,
        xAxis: ProfileAxis,
        xUnit: String,
        spokenXUnit: String,
        yUnit: String,
        spokenYUnit: String,
        headline: ProfileStat,
        secondary: ProfileStat?,
        referenceLine: Double? = nil,
        signedYAxis: Bool = false,
        formatValue: @escaping (Double) -> String,
        describeValue: ((Double) -> String?)? = nil
    ) {
        self.kind = kind
        self.samples = samples
        yAxis = ProfileAxis.y(values: samples.map(\.y), style: yStyle)
        self.xAxis = xAxis
        self.xUnit = xUnit
        self.spokenXUnit = spokenXUnit
        self.yUnit = yUnit
        self.spokenYUnit = spokenYUnit
        self.headline = headline
        self.secondary = secondary
        self.referenceLine = referenceLine
        self.signedYAxis = signedYAxis
        self.formatValue = formatValue
        self.describeValue = describeValue
    }
}

enum ProfileChartFormat {
    static func whole(_ value: Double) -> String {
        number(value, decimals: 0)
    }

    static func number(_ value: Double, decimals: Int) -> String {
        value.formatted(.number.precision(.fractionLength(decimals)))
    }

    static func signed(_ value: Double, decimals: Int) -> String {
        let magnitude = number(abs(value), decimals: decimals)
        let rounded = (value * pow(10, Double(decimals))).rounded()
        if rounded == 0 { return magnitude }
        return (value > 0 ? "+" : "\u{2212}") + magnitude
    }

    static func distance(_ value: Double) -> String {
        number(value, decimals: value < 10 ? 2 : value < 100 ? 1 : 0)
    }

    private static let timeFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm"
        return formatter
    }()

    static func time(_ date: Date) -> String {
        timeFormatter.string(from: date)
    }
}

@Observable
private final class ProfileChartSelection {
    private(set) var index: Int?
    @ObservationIgnored var chartValue: Double?
    @ObservationIgnored var plotFrame: CGRect = .zero

    func select(_ index: Int?) {
        if self.index != index {
            self.index = index
        }
    }
}

struct ProfileChartCard: View {
    let content: ProfileChartContent

    @State private var selection = ProfileChartSelection()

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            ProfileChartHeader(content: content, selection: selection)

            if content.hasEnoughData {
                ProfileChartPlot(content: content, selection: selection)
                    .dynamicTypeSize(...DynamicTypeSize.accessibility1)
            } else {
                ProfileChartEmptyState()
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(ProfileChartSurface())
        .modifier(ProfileChartAccessibility(content: content, selection: selection))
    }
}

private struct ProfileChartSurface: View {
    @Environment(\.colorScheme) private var colorScheme

    private static let shape = RoundedRectangle(cornerRadius: 20, style: .continuous)

    var body: some View {
        Self.shape
            .fill(ProfileChartSurface.fill(for: colorScheme))
            .overlay(
                Self.shape.strokeBorder(
                    colorScheme == .dark ? AppConstants.darkCardBorder : Color.black.opacity(0.08),
                    lineWidth: 1
                )
            )
    }

    static func fill(for scheme: ColorScheme) -> Color {
        scheme == .dark ? AppConstants.darkCardBackground : .white
    }
}

private struct ProfileChartHeader: View {
    let content: ProfileChartContent
    let selection: ProfileChartSelection

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    private var selected: ProfileSample? {
        selection.index.flatMap { content.samples.indices.contains($0) ? content.samples[$0] : nil }
    }

    private var value: String {
        selected.map { content.formatValue($0.y) } ?? content.headline.value
    }

    private var caption: String {
        guard let selected else { return content.headline.label }
        var parts: [String] = []
        if let word = content.describeValue?(selected.y) { parts.append(word) }
        parts.append("\(ProfileChartFormat.distance(selected.x)) \(content.xUnit)")
        if let time = selected.time { parts.append(ProfileChartFormat.time(time)) }
        return parts.joined(separator: " \u{00B7} ")
    }

    var body: some View {
        let layout = dynamicTypeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 12))
            : AnyLayout(HStackLayout(alignment: .bottom, spacing: 12))

        VStack(alignment: .leading, spacing: 6) {
            Text(content.kind.title)
                .font(.montserrat(size: 12, weight: .bold))
                .foregroundStyle(.secondary)
                .tracking(1)

            if content.hasEnoughData {
                layout {
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(alignment: .firstTextBaseline, spacing: 4) {
                            Text(value)
                                .font(.montserrat(size: 28, weight: .bold))
                                .foregroundStyle(.primary)
                                .monospacedDigit()
                            Text(content.yUnit)
                                .font(.montserrat(size: 14, weight: .semibold))
                                .foregroundStyle(.secondary)
                        }
                        Text(caption)
                            .font(.montserrat(size: 13, weight: .medium))
                            .foregroundStyle(.secondary)
                            .monospacedDigit()
                            .lineLimit(dynamicTypeSize.isAccessibilitySize ? 3 : 1)
                            .minimumScaleFactor(0.8)
                    }
                    .layoutPriority(1)

                    if !dynamicTypeSize.isAccessibilitySize {
                        Spacer(minLength: 0)
                    }

                    if let secondary = content.secondary {
                        ProfileSecondaryStat(stat: secondary, kind: content.kind)
                    }
                }
            }
        }
        .sensoryFeedback(.selection, trigger: selection.index != nil) { _, isSelecting in isSelecting }
    }
}

private struct ProfileSecondaryStat: View {
    let stat: ProfileStat
    let kind: ProfileChartKind

    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        VStack(alignment: dynamicTypeSize.isAccessibilitySize ? .leading : .trailing, spacing: 2) {
            HStack(spacing: 5) {
                if stat.isReferenceLine {
                    ProfileReferenceLineShape()
                        .stroke(kind.tint(for: colorScheme), style: ProfileChartStyle.referenceStroke)
                        .frame(width: 14, height: 1)
                }
                Text(stat.label)
                    .font(.montserrat(size: 13, weight: .medium))
                    .foregroundStyle(.secondary)
            }
            HStack(alignment: .firstTextBaseline, spacing: 3) {
                Text(stat.value)
                    .font(.montserrat(size: 15, weight: .semibold))
                    .foregroundStyle(.primary)
                    .monospacedDigit()
                Text(stat.unit)
                    .font(.montserrat(size: 12, weight: .medium))
                    .foregroundStyle(.secondary)
            }
        }
        .lineLimit(1)
        .minimumScaleFactor(0.8)
    }
}

private struct ProfileReferenceLineShape: Shape {
    func path(in rect: CGRect) -> Path {
        Path { path in
            path.move(to: CGPoint(x: rect.minX, y: rect.midY))
            path.addLine(to: CGPoint(x: rect.maxX, y: rect.midY))
        }
    }
}

private enum ProfileChartStyle {
    static let referenceStroke = StrokeStyle(lineWidth: 1, lineCap: .butt, dash: [3, 3])
    static let axisText = Color.primary.opacity(0.62)
    static let maximumMarkedPoints = 24
    static let dismissTapRadius: CGFloat = 22
}

private struct ProfileAreaPoint {
    let x: Double
    let base: Double
    let y: Double
}

private struct ProfileChartPlot: View {
    let content: ProfileChartContent
    let selection: ProfileChartSelection

    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @ScaledMetric(relativeTo: .caption) private var plotHeight: CGFloat = 164
    @ScaledMetric(relativeTo: .caption2) private var yAxisWidth: CGFloat = 54

    private var tint: Color { content.kind.tint(for: colorScheme) }
    private var surface: Color { ProfileChartSurface.fill(for: colorScheme) }

    private var yTicks: [Double] {
        let ticks = content.yAxis.ticks
        guard dynamicTypeSize.isAccessibilitySize, ticks.count > 3 else { return ticks }
        let stride = max(1, (ticks.count - 1) / 2)
        return ticks.enumerated().filter { $0.offset % stride == 0 }.map(\.element)
    }

    private var xTicks: [Double] {
        let ticks = content.xAxis.ticks
        guard dynamicTypeSize >= .xxxLarge, ticks.count > 3 else { return ticks }
        return ticks.enumerated().filter { $0.offset % 2 == 0 }.map(\.element)
    }

    var body: some View {
        let areaPoints = content.samples.map {
            ProfileAreaPoint(x: $0.x, base: content.yAxis.baseline, y: $0.y)
        }

        Chart {
            AreaPlot(
                areaPoints,
                x: .value("Distance", \.x),
                yStart: .value("Baseline", \.base),
                yEnd: .value("Value", \.y)
            )
            .foregroundStyle(fill)

            if let referenceLine = content.referenceLine, content.yAxis.domain.contains(referenceLine) {
                RuleMark(y: .value("Average", referenceLine))
                    .foregroundStyle(tint.opacity(0.75))
                    .lineStyle(ProfileChartStyle.referenceStroke)
            }

            LinePlot(content.samples, x: .value("Distance", \.x), y: .value("Value", \.y))
                .foregroundStyle(tint)
                .lineStyle(StrokeStyle(
                    lineWidth: content.kind == .acceleration ? 1.5 : 2,
                    lineCap: .round,
                    lineJoin: .round
                ))

            if content.samples.count <= ProfileChartStyle.maximumMarkedPoints {
                ForEach(Array(content.samples.enumerated()), id: \.offset) { _, sample in
                    PointMark(x: .value("Distance", sample.x), y: .value("Value", sample.y))
                        .symbolSize(24)
                        .foregroundStyle(tint)
                }
            }
        }
        .chartXScale(domain: content.xAxis.domain, range: .plotDimension(startPadding: 0, endPadding: 0))
        .chartYScale(domain: content.yAxis.domain)
        .chartLegend(.hidden)
        .chartXAxis { xAxisMarks }
        .chartYAxis { yAxisMarks }
        .chartXSelection(value: Binding(
            get: { selection.chartValue },
            set: {
                selection.chartValue = $0
                selection.select($0.flatMap { ProfileSample.nearestIndex(to: $0, in: content.samples) })
            }
        ))
        .chartOverlay(alignment: .topLeading) { proxy in
            GeometryReader { geometry in
                Color.clear
                    .onChange(of: proxy.plotFrame.map { geometry[$0] }, initial: true) { _, frame in
                        selection.plotFrame = frame ?? .zero
                    }
                ProfileSelectionMarker(
                    samples: content.samples,
                    selection: selection,
                    proxy: proxy,
                    geometry: geometry,
                    tint: tint,
                    surface: surface
                )
            }
            .allowsHitTesting(false)
        }
        .simultaneousGesture(
            SpatialTapGesture().onEnded { handleTap(at: $0.location) }
        )
        .frame(height: plotHeight)
    }

    private func handleTap(at location: CGPoint) {
        let plot = selection.plotFrame
        guard plot.width > 0, plot.contains(location) else {
            selection.select(nil)
            return
        }
        let domain = content.xAxis.domain
        let pointsPerUnit = plot.width / (domain.upperBound - domain.lowerBound)

        if let index = selection.index, content.samples.indices.contains(index) {
            let selectedX = plot.minX + (content.samples[index].x - domain.lowerBound) * pointsPerUnit
            if abs(selectedX - location.x) <= ProfileChartStyle.dismissTapRadius {
                selection.select(nil)
                return
            }
        }

        let x = domain.lowerBound + (location.x - plot.minX) / pointsPerUnit
        selection.select(ProfileSample.nearestIndex(to: x, in: content.samples))
    }

    private var fill: some ShapeStyle {
        let isSigned = content.kind == .acceleration
        let strength = colorScheme == .dark ? 0.30 : 0.22
        return LinearGradient(
            colors: [tint.opacity(isSigned ? strength * 0.6 : strength), tint.opacity(isSigned ? strength * 0.6 : 0.02)],
            startPoint: .top,
            endPoint: .bottom
        )
    }

    private var xAxisMarks: some AxisContent {
        AxisMarks(values: xTicks) { value in
            if let x = value.as(Double.self) {
                AxisValueLabel(anchor: x == content.xAxis.domain.lowerBound ? .topLeading : .top, horizontalSpacing: 0) {
                    Text(xLabel(x))
                        .font(.montserrat(size: 11, weight: .medium))
                        .foregroundStyle(ProfileChartStyle.axisText)
                        .monospacedDigit()
                        .fixedSize()
                }
            }
        }
    }

    private var yAxisMarks: some AxisContent {
        AxisMarks(position: .trailing, values: yTicks) { value in
            if let y = value.as(Double.self) {
                AxisGridLine(stroke: StrokeStyle(lineWidth: isBaseline(y) ? 1 : 0.5))
                    .foregroundStyle(Color.primary.opacity(isBaseline(y) ? 0.28 : 0.1))
                AxisValueLabel(horizontalSpacing: 6) {
                    Text(yLabel(y))
                        .font(.montserrat(size: 11, weight: .medium))
                        .foregroundStyle(ProfileChartStyle.axisText)
                        .monospacedDigit()
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)
                        .frame(width: yAxisWidth, alignment: .leading)
                }
            }
        }
    }

    private func isBaseline(_ y: Double) -> Bool {
        abs(y - content.yAxis.baseline) < 1e-9
    }

    private func xLabel(_ x: Double) -> String {
        let number = ProfileChartFormat.number(x, decimals: content.xAxis.decimals)
        return x == xTicks.last ? "\(number) \(content.xUnit)" : number
    }

    private func yLabel(_ y: Double) -> String {
        let decimals = content.yAxis.decimals
        let number = content.signedYAxis ? ProfileChartFormat.signed(y, decimals: decimals) : ProfileChartFormat.number(y, decimals: decimals)
        return y == yTicks.last ? "\(number) \(content.yUnit)" : number
    }
}

private struct ProfileSelectionMarker: View {
    let samples: [ProfileSample]
    let selection: ProfileChartSelection
    let proxy: ChartProxy
    let geometry: GeometryProxy
    let tint: Color
    let surface: Color

    var body: some View {
        if let index = selection.index, samples.indices.contains(index),
           let plotAnchor = proxy.plotFrame,
           let positionX = proxy.position(forX: samples[index].x),
           let positionY = proxy.position(forY: samples[index].y) {
            let plot = geometry[plotAnchor]

            Rectangle()
                .fill(Color.primary.opacity(0.45))
                .frame(width: 1, height: plot.height)
                .position(x: plot.minX + positionX, y: plot.midY)

            Circle()
                .fill(tint)
                .frame(width: 10, height: 10)
                .overlay(Circle().stroke(surface, lineWidth: 2).padding(-1))
                .position(x: plot.minX + positionX, y: plot.minY + positionY)
        }
    }
}

private struct ProfileChartEmptyState: View {
    @ScaledMetric(relativeTo: .caption) private var height: CGFloat = 164

    var body: some View {
        VStack(spacing: 8) {
            Image(systemName: "chart.xyaxis.line")
                .font(.system(size: 22, weight: .medium))
                .foregroundStyle(.tertiary)
            Text("Not enough data to chart")
                .font(.montserrat(size: 13, weight: .medium))
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity, minHeight: height * 0.6)
    }
}

private struct ProfileChartAccessibility: ViewModifier {
    let content: ProfileChartContent
    let selection: ProfileChartSelection

    private var summary: String {
        guard content.hasEnoughData else { return "Not enough data to chart." }
        var parts = ["\(content.headline.label) \(content.headline.spokenValue)."]
        if let secondary = content.secondary {
            parts.append("\(secondary.label) \(secondary.spokenValue).")
        }
        if let last = content.samples.last {
            parts.append("Over \(ProfileChartFormat.distance(last.x)) \(content.spokenXUnit).")
        }
        return parts.joined(separator: " ")
    }

    private var value: String {
        guard let index = selection.index, content.samples.indices.contains(index) else { return summary }
        let sample = content.samples[index]
        var parts = ["\(content.formatValue(sample.y)) \(content.spokenYUnit)"]
        if let word = content.describeValue?(sample.y) { parts.append(word) }
        parts.append("at \(ProfileChartFormat.distance(sample.x)) \(content.spokenXUnit)")
        if let time = sample.time { parts.append(ProfileChartFormat.time(time)) }
        return parts.joined(separator: ", ")
    }

    func body(content view: Content) -> some View {
        view
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(content.kind.accessibilityTitle)
            .accessibilityValue(value)
            .accessibilityIdentifier(content.kind.accessibilityIdentifier)
            .accessibilityHint(content.hasEnoughData ? "Swipe up or down to move along the journey." : "")
            .accessibilityAdjustableAction { direction in
                guard content.hasEnoughData else { return }
                let step = max(1, content.samples.count / 20)
                let last = content.samples.count - 1
                switch direction {
                case .increment:
                    selection.select(selection.index.map { min($0 + step, last) } ?? 0)
                case .decrement:
                    selection.select(selection.index.map { max($0 - step, 0) } ?? last)
                @unknown default:
                    break
                }
            }
            .accessibilityChartDescriptor(ProfileChartDescriptor(content: content))
    }
}

private struct ProfileChartDescriptor: AXChartDescriptorRepresentable {
    let content: ProfileChartContent

    func makeChartDescriptor() -> AXChartDescriptor {
        let xAxis = AXNumericDataAxisDescriptor(
            title: "Distance in \(content.spokenXUnit)",
            range: content.xAxis.domain,
            gridlinePositions: content.xAxis.ticks,
            valueDescriptionProvider: { "\(ProfileChartFormat.distance($0)) \(content.spokenXUnit)" }
        )
        let yAxis = AXNumericDataAxisDescriptor(
            title: content.spokenYUnit.capitalized,
            range: content.yAxis.domain,
            gridlinePositions: content.yAxis.ticks,
            valueDescriptionProvider: { "\(content.formatValue($0)) \(content.spokenYUnit)" }
        )
        let series = AXDataSeriesDescriptor(
            name: content.kind.accessibilityTitle,
            isContinuous: true,
            dataPoints: content.samples.map { AXDataPoint(x: $0.x, y: $0.y) }
        )
        return AXChartDescriptor(
            title: content.kind.accessibilityTitle,
            summary: "\(content.headline.label) \(content.headline.spokenValue).",
            xAxis: xAxis,
            yAxis: yAxis,
            additionalAxes: [],
            series: [series]
        )
    }
}
