import SwiftUI

struct JourneysScreen: View {
    @State private var journeys: [JourneySummary] = []
    @State private var searchText = ""
    @State private var selectedFilter: JourneyFilter = .all
    @State private var isLoading = false
    @State private var errorMessage: String?
    @State private var presentedJourney: JourneySummary?
    /// The journey showing in the detail view. Read only by small child views, so swiping
    /// between journeys doesn't re-render this screen.
    @State private var focus = JourneyFocus()
    @State private var needsReloadAfterDetail = false
    /// Shared with the full-screen view so a journey loaded for its card opens instantly.
    @State private var detailStore = JourneyDetailStore()
    @State private var titleState = JourneysTitleState()
    @Namespace private var journeyTransition

    private var filteredJourneys: [JourneySummary] {
        var result = journeys

        // Search filter
        if !searchText.isEmpty {
            result = result.filter {
                ($0.name ?? "").localizedCaseInsensitiveContains(searchText) ||
                ($0.citiesPassed ?? []).joined(separator: " ").localizedCaseInsensitiveContains(searchText)
            }
        }

        // Chip filter
        switch selectedFilter {
        case .all:
            break
        case .past7Days:
            let sevenDaysAgo = Calendar.current.date(byAdding: .day, value: -7, to: Date()) ?? Date()
            result = result.filter {
                guard let startDate = $0.startDate else { return false }
                return startDate >= sevenDaysAgo
            }
        case .distanceOver5:
            result = result.filter { $0.distanceDouble > 5.0 }
        }

        return result
    }

    private var groupedJourneys: [(String, [JourneySummary])] {
        let grouped = Dictionary(grouping: filteredJourneys) { $0.sectionDate }
        return grouped.sorted { pair1, pair2 in
            guard let d1 = pair1.value.first?.startDate, let d2 = pair2.value.first?.startDate else { return false }
            return d1 > d2
        }
    }

    /// Journeys in the order the list shows them, so the detail pager swipes in the same order.
    private var orderedJourneys: [JourneySummary] {
        groupedJourneys.flatMap { $0.1 }
    }

    var body: some View {
        NavigationStack {
            journeyList
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Color.black.ignoresSafeArea())
                .navigationTitle("Journeys")
                // One compact bar row instead of the large-title layout, which reserves an
                // empty row above the title. Our own title replaces the system one.
                .navigationBarTitleDisplayMode(.inline)
                .toolbar(removing: .title)
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) {
                        JourneysTitle(state: titleState)
                    }
                    .sharedBackgroundVisibility(.hidden)
                }
                // System search under the title; slides away as the list scrolls
                .searchable(
                    text: $searchText,
                    placement: .navigationBarDrawer(displayMode: .automatic),
                    prompt: "Search Journeys"
                )
                .fullScreenCover(item: $presentedJourney, onDismiss: {
                    focus.journeyID = nil
                    guard needsReloadAfterDetail else { return }
                    needsReloadAfterDetail = false
                    Task { await loadJourneys() }
                }) { journey in
                    JourneyDetailScreen(
                        journeys: orderedJourneys,
                        initialJourneyID: journey.id,
                        store: detailStore,
                        onSelectionChange: { focus.journeyID = $0 },
                        onJourneyRenamed: { needsReloadAfterDetail = true }
                    )
                    .modifier(ZoomFromFocusedCard(focus: focus, fallbackID: journey.id, namespace: journeyTransition))
                }
        }
        .task {
            await loadJourneys()
        }
    }

    @ViewBuilder
    private var journeyList: some View {
        if isLoading && journeys.isEmpty {
            ProgressView()
                .tint(AppConstants.journeyGreen)
        } else if let error = errorMessage, journeys.isEmpty {
            Text(error)
                .foregroundColor(.gray)
                .multilineTextAlignment(.center)
                .padding()
        } else {
            ScrollViewReader { scrollProxy in
                ScrollView {
                    LazyVStack(spacing: 14, pinnedViews: .sectionHeaders) {
                        // Inside the scroll view so the navigation bar can track scrolling
                        FilterChips(selected: $selectedFilter)

                        ForEach(groupedJourneys, id: \.0) { section, items in
                            Section {
                                ForEach(items) { journey in
                                    Button {
                                        presentedJourney = journey
                                    } label: {
                                        JourneyCardView(journey: journey, store: detailStore)
                                    }
                                    .buttonStyle(JourneyCardButtonStyle())
                                    .matchedTransitionSource(id: journey.id, in: journeyTransition) { source in
                                        source.clipShape(RoundedRectangle(cornerRadius: JourneyCardView.cornerRadius, style: .continuous))
                                    }
                                    .padding(.horizontal, 16)
                                }
                            } header: {
                                Text(section)
                                    .font(.montserrat(size: 11, weight: .semibold))
                                    .tracking(1.2)
                                    .foregroundColor(.white.opacity(0.5))
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .padding(.horizontal, 18)
                                    .padding(.top, 10)
                                    .padding(.bottom, 4)
                                    .background(Color.black)
                            }
                        }
                    }
                    .padding(.top, 4)
                    .padding(.bottom, 24)
                }
                .scrollIndicators(.hidden)
                // Opaque edge under the navigation bar so cards don't show through
                // above the pinned date headers
                .scrollEdgeEffectStyle(.hard, for: .top)
                // Shrink the title over the first stretch of scrolling, like the search bar
                .onScrollGeometryChange(for: CGFloat.self) { geometry in
                    min(max(geometry.contentOffset.y + geometry.contentInsets.top, 0), JourneysTitle.compactDistance).rounded()
                } action: { _, offset in
                    titleState.compactProgress = offset / JourneysTitle.compactDistance
                }
                .refreshable {
                    await loadJourneys()
                    detailStore.markAllStale()
                }
                .background {
                    FocusedCardScroller(focus: focus, scrollProxy: scrollProxy)
                }
            }
        }
    }

    private func loadJourneys() async {
        isLoading = true
        errorMessage = nil
        do {
            let fetched = try await APIService.shared.fetchJourneys()
            journeys = fetched
        } catch {
            errorMessage = "Failed to load journeys: \(error.localizedDescription)"
        }
        isLoading = false
    }
}

// MARK: - Detail Focus

@Observable
final class JourneyFocus {
    var journeyID: String?
}

/// Zooms the detail view out of, and back into, the card of the journey it's showing.
private struct ZoomFromFocusedCard: ViewModifier {
    let focus: JourneyFocus
    let fallbackID: String
    let namespace: Namespace.ID

    func body(content: Content) -> some View {
        content.navigationTransition(.zoom(sourceID: focus.journeyID ?? fallbackID, in: namespace))
    }
}

/// Keeps the card for the journey swiped to on screen so the dismiss zoom lands on it.
private struct FocusedCardScroller: View {
    let focus: JourneyFocus
    let scrollProxy: ScrollViewProxy

    var body: some View {
        Color.clear
            .onChange(of: focus.journeyID) { _, id in
                guard let id else { return }
                scrollProxy.scrollTo(id, anchor: .center)
            }
    }
}

// MARK: - Title

/// How far the list has scrolled toward the compact title (0 at the top, 1 once compact).
/// Kept out of the screen's own state so scrolling re-renders only the title, not the cards.
@Observable
final class JourneysTitleState {
    var compactProgress: CGFloat = 0
}

private struct JourneysTitle: View {
    /// Points of scrolling over which the title shrinks.
    static let compactDistance: CGFloat = 60
    /// 28pt at rest, about 20pt once compact.
    private static let compactScale: CGFloat = 0.72

    let state: JourneysTitleState

    var body: some View {
        Text("Journeys")
            .font(.montserrat(size: 28, weight: .heavy))
            .foregroundColor(.white)
            .fixedSize()
            .scaleEffect(1 - (1 - Self.compactScale) * state.compactProgress, anchor: .leading)
            .accessibilityAddTraits(.isHeader)
    }
}
