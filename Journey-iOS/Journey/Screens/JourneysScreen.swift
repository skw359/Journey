// Journeys list screen and its library.

import SwiftUI

@Observable
final class JourneyLibrary {
    private(set) var journeys: [JourneySummary] = []
    private(set) var isLoading = false
    private(set) var errorMessage: String?
    var selectedFilter: JourneyFilter = .all
    let detailStore = JourneyDetailStore()

    func load() async {
        if journeys.isEmpty { isLoading = true }
        if errorMessage != nil { errorMessage = nil }
        do {
            let fetched = try await APIService.shared.fetchJourneys()
            if fetched != journeys { journeys = fetched }
        } catch {
            if !Task.isCancelled {
                errorMessage = "Failed to load journeys: \(error.localizedDescription)"
            }
        }
        if isLoading { isLoading = false }
    }
}

struct JourneysScreen: View {
    let title: String
    let library: JourneyLibrary
    var searchText: Binding<String>?
    var journeyToReveal: Binding<Date?> = .constant(nil)

    @State private var presentedJourney: JourneySummary?
    @State private var focus = JourneyFocus()
    @State private var needsReloadAfterDetail = false
    @State private var titleState = JourneysTitleState()
    @Namespace private var journeyTransition

    private var isSearchTab: Bool { searchText != nil }

    private var query: String { searchText?.wrappedValue ?? "" }

    private var detailStore: JourneyDetailStore { library.detailStore }

    private var filteredJourneys: [JourneySummary] {
        var result = library.journeys

        if !query.isEmpty {
            result = result.filter {
                ($0.name ?? "").localizedCaseInsensitiveContains(query) ||
                ($0.citiesPassed ?? []).joined(separator: " ").localizedCaseInsensitiveContains(query)
            }
        }

        switch library.selectedFilter {
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

    private var orderedJourneys: [JourneySummary] {
        groupedJourneys.flatMap { $0.1 }
    }

    var body: some View {
        NavigationStack {
            journeyList
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Color.black.ignoresSafeArea())
                .navigationTitle(title)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar(removing: .title)
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) {
                        JourneysTitle(title: title, state: titleState)
                    }
                    .sharedBackgroundVisibility(.hidden)
                }
                .modifier(JourneySearchField(text: searchText))
                .fullScreenCover(item: $presentedJourney, onDismiss: {
                    focus.journeyID = nil
                    guard needsReloadAfterDetail else { return }
                    needsReloadAfterDetail = false
                    Task { await library.load() }
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
            await refresh()
        }
    }

    @ViewBuilder
    private var journeyList: some View {
        @Bindable var library = library

        if library.isLoading && library.journeys.isEmpty {
            ProgressView()
                .tint(AppConstants.journeyGreen)
        } else if let error = library.errorMessage, library.journeys.isEmpty {
            Text(error)
                .foregroundColor(.gray)
                .multilineTextAlignment(.center)
                .padding()
        } else {
            let sections = groupedJourneys

            ScrollViewReader { scrollProxy in
                ScrollView {
                    LazyVStack(spacing: 14, pinnedViews: .sectionHeaders) {
                        FilterChips(selected: $library.selectedFilter)

                        if sections.isEmpty {
                            emptyState
                        }

                        ForEach(sections, id: \.0) { section, items in
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
                .scrollDismissesKeyboard(.immediately)
                .scrollEdgeEffectStyle(.hard, for: .top)
                .onScrollGeometryChange(for: CGFloat.self) { geometry in
                    min(max(geometry.contentOffset.y + geometry.contentInsets.top, 0), JourneysTitle.compactDistance).rounded()
                } action: { _, offset in
                    titleState.compactProgress = offset / JourneysTitle.compactDistance
                }
                .refreshable {
                    await library.load()
                    detailStore.markAllStale()
                }
                .background {
                    FocusedCardScroller(focus: focus, scrollProxy: scrollProxy)
                }
            }
        }
    }

    @ViewBuilder
    private var emptyState: some View {
        Group {
            if !query.isEmpty {
                ContentUnavailableView.search(text: query)
            } else if library.selectedFilter != .all {
                ContentUnavailableView(
                    "No Matching Journeys",
                    systemImage: "line.3.horizontal.decrease.circle",
                    description: Text("No journeys match this filter.")
                )
            } else {
                ContentUnavailableView(
                    "No Journeys Yet",
                    systemImage: "point.bottomleft.forward.to.point.topright.scurvepath",
                    description: Text("Journeys you record will appear here.")
                )
            }
        }
        .padding(.top, 60)
    }

    private func refresh() async {
        if isSearchTab, !library.journeys.isEmpty { return }

        let hadJourneys = !library.journeys.isEmpty
        await library.load()
        if hadJourneys {
            detailStore.markAllStale()
        }
        revealRequestedJourney()
    }

    private func revealRequestedJourney() {
        guard let startedAt = journeyToReveal.wrappedValue else { return }
        journeyToReveal.wrappedValue = nil

        let earliest = startedAt.addingTimeInterval(-120)
        guard let journey = library.journeys
            .filter({ ($0.startDate ?? .distantPast) >= earliest })
            .max(by: { ($0.startDate ?? .distantPast) < ($1.startDate ?? .distantPast) })
        else { return }

        library.selectedFilter = .all
        focus.journeyID = journey.id
        presentedJourney = journey
    }
}

private struct JourneySearchField: ViewModifier {
    let text: Binding<String>?

    func body(content: Content) -> some View {
        if let text {
            content.searchable(text: text, prompt: "Search Journeys")
        } else {
            content
        }
    }
}

@Observable
final class JourneyFocus {
    var journeyID: String?
}

private struct ZoomFromFocusedCard: ViewModifier {
    let focus: JourneyFocus
    let fallbackID: String
    let namespace: Namespace.ID

    func body(content: Content) -> some View {
        content.navigationTransition(.zoom(sourceID: focus.journeyID ?? fallbackID, in: namespace))
    }
}

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

@Observable
final class JourneysTitleState {
    var compactProgress: CGFloat = 0
}

private struct JourneysTitle: View {
    static let compactDistance: CGFloat = 60
    private static let compactScale: CGFloat = 0.72

    let title: String
    let state: JourneysTitleState

    var body: some View {
        Text(title)
            .font(.montserrat(size: 28, weight: .heavy))
            .foregroundColor(.white)
            .fixedSize()
            .scaleEffect(1 - (1 - Self.compactScale) * state.compactProgress, anchor: .leading)
            .accessibilityAddTraits(.isHeader)
    }
}
