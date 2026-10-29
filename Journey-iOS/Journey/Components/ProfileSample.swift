import Foundation

/// One point of a journey profile chart, already converted to display units.
struct ProfileSample {
    let x: Double
    let y: Double

    /// The x-axis range covering `samples`, never empty.
    static func domain(of samples: [ProfileSample]) -> ClosedRange<Double> {
        domain(of: samples.map(\.x))
    }

    static func domain(of xs: [Double]) -> ClosedRange<Double> {
        let lowerBound = xs.min() ?? 0
        let upperBound = xs.max() ?? 0
        return lowerBound...max(upperBound, lowerBound + 0.001)
    }

    /// The sample closest to a selected x value, for chart scrubbing.
    static func nearest(to x: Double?, in samples: [ProfileSample]) -> ProfileSample? {
        guard let x else { return nil }
        return samples.min { abs($0.x - x) < abs($1.x - x) }
    }
}
