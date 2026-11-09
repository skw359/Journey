// Profile chart data points, series and axes.

import Foundation

struct ProfileSample: Equatable {
    let x: Double
    let y: Double
    var time: Date?

    init(x: Double, y: Double, time: Date? = nil) {
        self.x = x
        self.y = y
        self.time = time
    }

    static func nearestIndex(to x: Double, in samples: [ProfileSample]) -> Int? {
        guard !samples.isEmpty else { return nil }
        var low = 0
        var high = samples.count
        while low < high {
            let mid = (low + high) / 2
            if samples[mid].x < x {
                low = mid + 1
            } else {
                high = mid
            }
        }
        if low == 0 { return 0 }
        if low == samples.count { return samples.count - 1 }
        return x - samples[low - 1].x <= samples[low].x - x ? low - 1 : low
    }
}

enum ProfileSeries {
    static func elevation(distancesMi: [Double], elevationsM: [Double?], timesMs: [Double], useMetric: Bool) -> [ProfileSample] {
        let hasTimes = timesMs.count == distancesMi.count
        var samples: [ProfileSample] = []
        samples.reserveCapacity(min(distancesMi.count, elevationsM.count))
        for i in 0..<min(distancesMi.count, elevationsM.count) {
            guard let elevation = elevationsM[i] else { continue }
            samples.append(ProfileSample(
                x: JourneyUnits.distance(fromMiles: distancesMi[i], useMetric: useMetric),
                y: JourneyUnits.elevation(fromMeters: elevation, useMetric: useMetric),
                time: hasTimes ? date(fromMs: timesMs[i]) : nil
            ))
        }
        return normalized(samples)
    }

    static func speed(distancesMi: [Double], speedsMph: [Double], timesMs: [Double], useMetric: Bool) -> [ProfileSample] {
        let hasTimes = timesMs.count == distancesMi.count
        var samples: [ProfileSample] = []
        samples.reserveCapacity(min(distancesMi.count, speedsMph.count))
        for i in 0..<min(distancesMi.count, speedsMph.count) {
            samples.append(ProfileSample(
                x: JourneyUnits.distance(fromMiles: distancesMi[i], useMetric: useMetric),
                y: JourneyUnits.speed(fromMph: speedsMph[i], useMetric: useMetric),
                time: hasTimes ? date(fromMs: timesMs[i]) : nil
            ))
        }
        return normalized(samples)
    }

    static func acceleration(distancesMi: [Double], speedsMph: [Double], timesMs: [Double], useMetric: Bool) -> [ProfileSample] {
        let count = min(distancesMi.count, speedsMph.count, timesMs.count)
        guard count >= 2 else { return [] }
        var samples: [ProfileSample] = []
        samples.reserveCapacity(count - 1)
        for i in 1..<count {
            let seconds = (timesMs[i] - timesMs[i - 1]) / 1000
            guard seconds > 0 else { continue }
            samples.append(ProfileSample(
                x: JourneyUnits.distance(fromMiles: distancesMi[i], useMetric: useMetric),
                y: JourneyUnits.acceleration(speedDeltaMph: speedsMph[i] - speedsMph[i - 1], durationSeconds: seconds, useMetric: useMetric),
                time: date(fromMs: timesMs[i])
            ))
        }
        return normalized(samples)
    }

    private static func normalized(_ samples: [ProfileSample]) -> [ProfileSample] {
        let finite = samples.filter { $0.x.isFinite && $0.y.isFinite }
        let isSorted = zip(finite, finite.dropFirst()).allSatisfy { $0.x <= $1.x }
        if isSorted { return finite }
        return finite.enumerated()
            .sorted { $0.element.x == $1.element.x ? $0.offset < $1.offset : $0.element.x < $1.element.x }
            .map(\.element)
    }

    private static func date(fromMs ms: Double) -> Date? {
        ms.isFinite ? Date(timeIntervalSince1970: ms / 1000) : nil
    }
}

struct ProfileAxis: Equatable {
    enum YStyle: Equatable {
        case fromZero(minimumTop: Double)
        case fitted(minimumSpan: Double)
        case symmetric(minimumMagnitude: Double)
    }

    let domain: ClosedRange<Double>
    let ticks: [Double]
    let decimals: Int
    let baseline: Double

    static func y(values: [Double], style: YStyle) -> ProfileAxis {
        let low = values.min() ?? 0
        let high = values.max() ?? 0

        switch style {
        case .fromZero(let minimumTop):
            let lower = min(low, 0)
            let span = max(high, minimumTop) - lower
            let step = niceStep(span / 3)
            return evenlySpaced(
                lower: (lower / step).rounded(.down) * step,
                upper: (max(high, minimumTop) / step).rounded(.up) * step,
                step: step,
                baseline: 0
            )

        case .fitted(let minimumSpan):
            var lower = low
            var upper = high
            if upper - lower < minimumSpan {
                let middle = (lower + upper) / 2
                lower = middle - minimumSpan / 2
                upper = middle + minimumSpan / 2
                if low >= 0, lower < 0 {
                    upper -= lower
                    lower = 0
                }
            }
            let step = niceStep((upper - lower) / 3)
            let bottom = (lower / step).rounded(.down) * step
            return evenlySpaced(
                lower: low >= 0 ? max(bottom, 0) : bottom,
                upper: (upper / step).rounded(.up) * step,
                step: step,
                baseline: low >= 0 ? max(bottom, 0) : bottom
            )

        case .symmetric(let minimumMagnitude):
            let magnitude = niceCeiling(max(abs(low), abs(high), minimumMagnitude))
            return evenlySpaced(lower: -magnitude, upper: magnitude, step: magnitude, baseline: 0)
        }
    }

    static func x(lower: Double, upper: Double, targetIntervals: Int = 4) -> ProfileAxis {
        let upper = max(upper, lower + 0.001)
        let step = niceStep((upper - lower) / Double(targetIntervals))
        var ticks: [Double] = []
        var index = (lower / step).rounded(.up)
        while index * step <= upper + step * 1e-9 {
            ticks.append(index * step)
            index += 1
        }
        return ProfileAxis(domain: lower...upper, ticks: ticks, decimals: decimalPlaces(of: step), baseline: lower)
    }

    private static func evenlySpaced(lower: Double, upper: Double, step: Double, baseline: Double) -> ProfileAxis {
        let upper = max(upper, lower + step)
        let intervals = Int(((upper - lower) / step).rounded())
        let ticks = (0...intervals).map { lower + Double($0) * step }
        return ProfileAxis(domain: lower...upper, ticks: ticks, decimals: decimalPlaces(of: step), baseline: baseline)
    }

    static func niceStep(_ rough: Double) -> Double {
        guard rough > 0, rough.isFinite else { return 1 }
        let magnitude = pow(10, floor(log10(rough)))
        let residual = rough / magnitude
        for candidate in [1, 2, 2.5, 5] where residual <= candidate * (1 + 1e-9) {
            return candidate * magnitude
        }
        return 10 * magnitude
    }

    private static func niceCeiling(_ value: Double) -> Double {
        guard value > 0, value.isFinite else { return 1 }
        let magnitude = pow(10, floor(log10(value)))
        let residual = value / magnitude
        for candidate in [1, 2, 3, 4, 5, 6, 8] where residual <= Double(candidate) * (1 + 1e-9) {
            return Double(candidate) * magnitude
        }
        return 10 * magnitude
    }

    private static func decimalPlaces(of step: Double) -> Int {
        for places in 0...4 {
            let scaled = step * pow(10, Double(places))
            if abs(scaled - scaled.rounded()) < 1e-6 { return places }
        }
        return 4
    }
}
