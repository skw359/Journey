import SwiftUI

/// Page dots for the journey story pager. The active page is a wide white capsule; long lists
/// show a sliding window whose clipped edges shrink to hint at more pages.
struct StoryPageIndicator: View {
    let count: Int
    let current: Int
    var maxVisible = 7

    var body: some View {
        if count > 1 {
            HStack(spacing: 6) {
                ForEach(visibleRange, id: \.self) { index in
                    Capsule()
                        .fill(Color.white.opacity(index == current ? 1 : 0.45))
                        .frame(width: index == current ? 18 : dotSize(for: index), height: dotSize(for: index))
                }
            }
            .frame(height: 6)
            .animation(.spring(response: 0.35, dampingFraction: 0.85), value: current)
            .accessibilityElement()
            .accessibilityLabel("Journey \(current + 1) of \(count)")
        }
    }

    private var visibleRange: Range<Int> {
        guard count > maxVisible else { return 0..<count }
        let start = min(max(current - maxVisible / 2, 0), count - maxVisible)
        return start..<(start + maxVisible)
    }

    private func dotSize(for index: Int) -> CGFloat {
        guard index != current else { return 6 }
        let range = visibleRange
        let isClippedEdge = (index == range.lowerBound && range.lowerBound > 0)
            || (index == range.upperBound - 1 && range.upperBound < count)
        return isClippedEdge ? 4 : 6
    }
}
