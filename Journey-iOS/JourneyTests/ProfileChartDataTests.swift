import XCTest
@testable import Journey

final class ProfileChartDataTests: XCTestCase {
    // MARK: Series values

    func testElevationConvertsUnitsAndKeepsEveryPoint() {
        let samples = ProfileSeries.elevation(distancesMi: [0, 1, 2], elevationsM: [100, 200, 300], timesMs: [1000, 2000, 3000], useMetric: false)

        XCTAssertEqual(samples.map(\.x), [0, 1, 2])
        XCTAssertEqual(samples[1].y, 200 * 3.28084, accuracy: 1e-9)
        XCTAssertEqual(samples[2].time, Date(timeIntervalSince1970: 3))

        let metric = ProfileSeries.elevation(distancesMi: [0, 1], elevationsM: [100, 200], timesMs: [], useMetric: true)
        XCTAssertEqual(metric[1].x, 1.609344, accuracy: 1e-9)
        XCTAssertEqual(metric[1].y, 200)
        XCTAssertNil(metric[1].time)
    }

    func testElevationSkipsNullsWithoutShiftingOtherPoints() {
        let samples = ProfileSeries.elevation(
            distancesMi: [0, 1, 2, 3],
            elevationsM: [10, nil, 30, nil],
            timesMs: [0, 1000, 2000, 3000],
            useMetric: true
        )

        XCTAssertEqual(samples.map(\.x).map { $0 / 1.609344 }.map { $0.rounded() }, [0, 2])
        XCTAssertEqual(samples.map(\.y), [10, 30])
        XCTAssertEqual(samples[1].time, Date(timeIntervalSince1970: 2))
    }

    func testSpeedMatchesUnitConversion() {
        let samples = ProfileSeries.speed(distancesMi: [0, 1], speedsMph: [10, 60], timesMs: [0, 1000], useMetric: true)

        XCTAssertEqual(samples[1].y, 60 * 1.609344, accuracy: 1e-9)
    }

    /// The same formula the charts have always used: speed change over time, at the later point.
    func testAccelerationIsSpeedChangeOverTime() {
        let samples = ProfileSeries.acceleration(
            distancesMi: [0, 1, 2],
            speedsMph: [0, 10, 5],
            timesMs: [0, 2000, 4000],
            useMetric: false
        )

        XCTAssertEqual(samples.count, 2)
        XCTAssertEqual(samples[0].x, 1)
        XCTAssertEqual(samples[0].y, 10 * 1.46667 / 2, accuracy: 1e-9)
        XCTAssertEqual(samples[1].y, -5 * 1.46667 / 2, accuracy: 1e-9)

        let metric = ProfileSeries.acceleration(distancesMi: [0, 1], speedsMph: [0, 10], timesMs: [0, 1000], useMetric: true)
        XCTAssertEqual(metric[0].y, 10 * 0.44704, accuracy: 1e-9)
    }

    func testAccelerationSkipsPointsWithNoElapsedTime() {
        let samples = ProfileSeries.acceleration(distancesMi: [0, 1, 2], speedsMph: [0, 10, 20], timesMs: [0, 0, 1000], useMetric: false)

        XCTAssertEqual(samples.map(\.x), [2])
    }

    func testAccelerationToleratesMismatchedArrays() {
        XCTAssertTrue(ProfileSeries.acceleration(distancesMi: [0], speedsMph: [1, 2], timesMs: [0, 1], useMetric: false).isEmpty)
        XCTAssertTrue(ProfileSeries.acceleration(distancesMi: [], speedsMph: [], timesMs: [], useMetric: false).isEmpty)
    }

    func testSeriesDropsUnplottableValuesAndSortsByDistance() {
        let samples = ProfileSeries.speed(
            distancesMi: [2, .nan, 1, 3],
            speedsMph: [20, 5, 10, .infinity],
            timesMs: [],
            useMetric: false
        )

        XCTAssertEqual(samples.map(\.x), [1, 2])
        XCTAssertEqual(samples.map(\.y), [10, 20])
    }

    // MARK: Selection

    func testNearestIndexSnapsToClosestSample() {
        let samples = [0.0, 1, 2, 10].map { ProfileSample(x: $0, y: 0) }

        XCTAssertEqual(ProfileSample.nearestIndex(to: -5, in: samples), 0)
        XCTAssertEqual(ProfileSample.nearestIndex(to: 0.4, in: samples), 0)
        XCTAssertEqual(ProfileSample.nearestIndex(to: 0.6, in: samples), 1)
        XCTAssertEqual(ProfileSample.nearestIndex(to: 5.9, in: samples), 2)
        XCTAssertEqual(ProfileSample.nearestIndex(to: 6.1, in: samples), 3)
        XCTAssertEqual(ProfileSample.nearestIndex(to: 99, in: samples), 3)
        XCTAssertNil(ProfileSample.nearestIndex(to: 1, in: []))
    }

    func testNearestIndexAgreesWithExhaustiveSearch() {
        let samples = stride(from: 0.0, to: 50, by: 0.37).map { ProfileSample(x: $0, y: 0) }
        for x in stride(from: -1.0, to: 51, by: 0.11) {
            let index = ProfileSample.nearestIndex(to: x, in: samples)!
            let best = samples.map { abs($0.x - x) }.min()!
            XCTAssertEqual(abs(samples[index].x - x), best, accuracy: 1e-9)
        }
    }

    // MARK: Axes

    func testSpeedAxisStartsAtZeroAndContainsTheData() {
        let axis = ProfileAxis.y(values: [12, 68], style: .fromZero(minimumTop: 5))

        XCTAssertEqual(axis.domain, 0...75)
        XCTAssertEqual(axis.ticks, [0, 25, 50, 75])
        XCTAssertEqual(axis.baseline, 0)
    }

    func testSpeedAxisHandlesAllZeros() {
        let axis = ProfileAxis.y(values: [0, 0, 0], style: .fromZero(minimumTop: 5))

        XCTAssertEqual(axis.domain.lowerBound, 0)
        XCTAssertGreaterThanOrEqual(axis.domain.upperBound, 5)
    }

    func testElevationAxisFitsTheRangeInsteadOfStartingAtZero() {
        let axis = ProfileAxis.y(values: [5120, 7486], style: .fitted(minimumSpan: 50))

        XCTAssertGreaterThan(axis.domain.lowerBound, 0)
        XCTAssertLessThanOrEqual(axis.domain.lowerBound, 5120)
        XCTAssertGreaterThanOrEqual(axis.domain.upperBound, 7486)
        XCTAssertEqual(axis.baseline, axis.domain.lowerBound)
    }

    func testFlatElevationDoesNotExaggerateNoise() {
        let axis = ProfileAxis.y(values: [5280, 5281], style: .fitted(minimumSpan: 50))

        XCTAssertGreaterThanOrEqual(axis.domain.upperBound - axis.domain.lowerBound, 50)
    }

    func testElevationNearSeaLevelStaysAboveZero() {
        let axis = ProfileAxis.y(values: [3, 4], style: .fitted(minimumSpan: 50))

        XCTAssertEqual(axis.domain.lowerBound, 0)
    }

    func testElevationBelowSeaLevelIsContained() {
        let axis = ProfileAxis.y(values: [-282, 44], style: .fitted(minimumSpan: 50))

        XCTAssertLessThanOrEqual(axis.domain.lowerBound, -282)
        XCTAssertGreaterThanOrEqual(axis.domain.upperBound, 44)
    }

    func testAccelerationAxisIsSymmetricAroundZero() {
        let axis = ProfileAxis.y(values: [-4.9, 2], style: .symmetric(minimumMagnitude: 3))

        XCTAssertEqual(axis.domain, -5...5)
        XCTAssertEqual(axis.ticks, [-5, 0, 5])
        XCTAssertEqual(axis.baseline, 0)
    }

    func testOutliersStayOnTheAxis() {
        let axis = ProfileAxis.y(values: [24, 30, 312], style: .fromZero(minimumTop: 5))

        XCTAssertGreaterThanOrEqual(axis.domain.upperBound, 312)
    }

    func testDistanceAxisSpansExactlyTheJourney() {
        let axis = ProfileAxis.x(lower: 0, upper: 38.6)

        XCTAssertEqual(axis.domain, 0...38.6)
        XCTAssertEqual(axis.ticks, [0, 10, 20, 30])
        XCTAssertEqual(axis.decimals, 0)
    }

    func testDistanceAxisOnShortJourneysUsesDecimals() {
        let axis = ProfileAxis.x(lower: 0, upper: 0.84)

        XCTAssertEqual(axis.decimals, 2)
        XCTAssertEqual(axis.ticks, [0, 0.25, 0.5, 0.75])
    }

    func testDegenerateDistanceAxisIsNeverEmpty() {
        let axis = ProfileAxis.x(lower: 3, upper: 3)

        XCTAssertLessThan(axis.domain.lowerBound, axis.domain.upperBound)
    }

    // MARK: Formatting

    func testSignedFormatHasNoSignWhenRoundingToZero() {
        XCTAssertEqual(ProfileChartFormat.signed(2.34, decimals: 1), "+2.3")
        XCTAssertEqual(ProfileChartFormat.signed(-2.34, decimals: 1), "\u{2212}2.3")
        XCTAssertEqual(ProfileChartFormat.signed(-0.04, decimals: 1), "0.0")
    }

    // MARK: Decoding

    /// One point without an altitude must not stop the whole journey from loading.
    func testDetailDecodesNullElevations() throws {
        let json = #"{"id":"a","profileDistMi":[0,1,2],"profileElevM":[10,null,30]}"#
        let detail = try JSONDecoder().decode(JourneyDetail.self, from: Data(json.utf8))

        XCTAssertEqual(detail.profileElevM, [10, nil, 30])
    }
}
