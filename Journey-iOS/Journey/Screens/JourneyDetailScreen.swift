// Journey detail screen with its story pages, photos and charts.

import SwiftUI
import MapKit
import PhotosUI
import AVKit
import Combine

struct JourneyDetailScreen: View {
    let journeys: [JourneySummary]
    let store: JourneyDetailStore
    let onSelectionChange: ((String) -> Void)?
    let onJourneyRenamed: (() -> Void)?

    @State private var selectedID: String
    @State private var scrollState = JourneyStoryScrollState()
    @State private var showRenameAlert = false
    @State private var newName = ""
    @State private var showFullscreenMap = false
    @State private var showRouteCard = false
    @State private var showPhotoPicker = false
    @State private var pickedPhotos: [PhotosPickerItem] = []
    @State private var photoPickerJourneyID: String?
    @State private var mapIsRevealed = false
    @Environment(\.dismiss) private var dismiss

    init(
        journeys: [JourneySummary],
        initialJourneyID: String,
        store: JourneyDetailStore,
        onSelectionChange: ((String) -> Void)? = nil,
        onJourneyRenamed: (() -> Void)? = nil
    ) {
        self.journeys = journeys
        self.store = store
        self.onSelectionChange = onSelectionChange
        self.onJourneyRenamed = onJourneyRenamed
        _selectedID = State(initialValue: initialJourneyID)
    }

    private var selectedIndex: Int {
        journeys.firstIndex { $0.id == selectedID } ?? 0
    }

    private var selectedDetail: JourneyDetail? {
        store.detail(selectedID)
    }

    private var fullscreenMapDetail: JourneyDetail? {
        showFullscreenMap ? selectedDetail : nil
    }

    private static let mapFade = Animation.easeInOut(duration: 0.35)

    private func openFullscreenMap() {
        mapIsRevealed = false
        withAnimation(Self.mapFade) { showFullscreenMap = true }
    }

    private func revealFullscreenMap() {
        guard !mapIsRevealed else { return }
        withAnimation(Self.mapFade) { mapIsRevealed = true }
    }

    private func heroMapRect(for detail: JourneyDetail, in proxy: GeometryProxy) -> MKMapRect? {
        guard detail.previewFilenames.isEmpty,
              (scrollState.offsets[selectedID] ?? 0) == 0,
              detail.routeCoordinates.count >= 2 else { return nil }
        let safeArea = proxy.safeAreaInsets
        let pageSize = CGSize(
            width: proxy.size.width + safeArea.leading + safeArea.trailing,
            height: proxy.size.height + safeArea.top + safeArea.bottom
        )
        return RouteSnapshotCache.mapRect(
            fitting: detail.routeCoordinates,
            in: pageSize,
            insets: JourneyStoryPage.heroRouteInsets(pageHeight: pageSize.height, safeArea: safeArea)
        )
    }

    var body: some View {
        GeometryReader { proxy in
            let safeArea = proxy.safeAreaInsets

            ZStack {
                Color.black

                TabView(selection: $selectedID) {
                    ForEach(journeys) { journey in
                        JourneyStoryPage(
                            summary: journey,
                            store: store,
                            scrollState: scrollState,
                            isActive: journey.id == selectedID,
                            safeArea: safeArea,
                            mapIsOpen: showFullscreenMap && journey.id == selectedID,
                            onOpenMap: { openFullscreenMap() },
                            onOpenRouteCard: { showRouteCard = true },
                            onAddPhotos: { addPhotos(to: journey.id) }
                        )
                        .equatable()
                        .tag(journey.id)
                    }
                }
                .tabViewStyle(.page(indexDisplayMode: .never))

                JourneyStoryChrome(
                    scrollState: scrollState,
                    selectedID: selectedID,
                    pageIndex: selectedIndex,
                    pageCount: journeys.count,
                    safeArea: safeArea,
                    hasRoute: (selectedDetail?.routeCoordinates.count ?? 0) >= 2,
                    canAddPhotos: selectedDetail != nil,
                    uploadingLabel: store.uploadingLabel(selectedID),
                    onClose: { dismiss() },
                    onRename: {
                        newName = selectedDetail?.name ?? journeys[safe: selectedIndex]?.displayName ?? ""
                        showRenameAlert = true
                    },
                    onAddPhotos: { addPhotos(to: selectedID) },
                    onOpenMap: { openFullscreenMap() },
                    onOpenRouteCard: { showRouteCard = true }
                )
                .opacity(showFullscreenMap ? 0 : 1)
            }
            .ignoresSafeArea()
            .accessibilityHidden(fullscreenMapDetail != nil)

            if let detail = fullscreenMapDetail {
                let heroRect = heroMapRect(for: detail, in: proxy)

                FullscreenMapScreen(
                    coordinates: detail.routeCoordinates,
                    userLocation: nil,
                    pointCount: detail.coordinates?.count ?? 0,
                    distanceMiles: detail.distanceDouble,
                    initialCameraMode: .overview,
                    initialMapRect: heroRect,
                    showsEndMarker: true,
                    onMapRendered: revealFullscreenMap,
                    onClose: { withAnimation(Self.mapFade) { showFullscreenMap = false } }
                )
                .opacity(heroRect != nil || mapIsRevealed ? 1 : 0.01)
                .transition(.opacity)
                .task {
                    try? await Task.sleep(for: .seconds(1.2))
                    guard !Task.isCancelled else { return }
                    revealFullscreenMap()
                }
            }
        }
        .background(Color.black.ignoresSafeArea())
        .alert("Rename Journey", isPresented: $showRenameAlert) {
            TextField("Name", text: $newName)
            Button("Cancel", role: .cancel) {}
            Button("Save") { rename(selectedID, to: newName) }
        }
        .interactiveDismissDisabled(fullscreenMapDetail != nil)
        .fullScreenCover(isPresented: $showRouteCard) {
            if let detail = selectedDetail {
                RouteCardView(detail: detail)
            }
        }
        .photosPicker(
            isPresented: $showPhotoPicker,
            selection: $pickedPhotos,
            selectionBehavior: .ordered,
            matching: .any(of: [.images, .videos]),
            preferredItemEncoding: .current
        )
        .onChange(of: pickedPhotos) { _, items in
            guard !items.isEmpty else { return }
            if let id = photoPickerJourneyID {
                store.uploadMedia(items, to: id)
            }
            pickedPhotos = []
        }
        .alert(
            "Couldn't Upload",
            isPresented: Binding(
                get: { store.uploadError(selectedID) != nil },
                set: { if !$0 { store.clearUploadError(selectedID) } }
            ),
            presenting: store.uploadError(selectedID)
        ) { _ in
            Button("OK", role: .cancel) {}
        } message: { message in
            Text(message)
        }
        .onChange(of: selectedID) { _, newID in
            onSelectionChange?(newID)
        }
        .task(id: selectedID) {
            await prefetchAroundSelection()
        }
    }

    private func addPhotos(to id: String) {
        photoPickerJourneyID = id
        showPhotoPicker = true
    }

    private func rename(_ id: String, to name: String) {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        Task {
            do {
                try await APIService.shared.renameJourney(id: id, newName: trimmed)
                await store.load(id, force: true)
                onJourneyRenamed?()
            } catch {
                print("Failed to rename journey: \(error)")
            }
        }
    }

    private func prefetchAroundSelection() async {
        let index = selectedIndex
        await store.load(selectedID)
        for neighbor in [index + 1, index - 1] where journeys.indices.contains(neighbor) {
            guard !Task.isCancelled else { return }
            await store.load(journeys[neighbor].id)
        }
    }
}

@Observable
final class JourneyDetailStore {
    private(set) var generation = 0
    @ObservationIgnored private var entries: [String: Entry] = [:]
    @ObservationIgnored private var loadedGeneration: [String: Int] = [:]
    @ObservationIgnored private var inFlight: [String: Task<Void, Never>] = [:]
    @ObservationIgnored private var mediaPolls: [String: Task<Void, Never>] = [:]

    @Observable
    final class Entry {
        fileprivate(set) var detail: JourneyDetail?
        fileprivate(set) var loadFailed = false
        fileprivate(set) var pendingUploads: [PendingUpload] = []
        fileprivate(set) var localPreviews: [String: UIImage] = [:]
        fileprivate(set) var uploadError: String?
        @ObservationIgnored fileprivate var mediaRevision = 0
    }

    @Observable
    final class PendingUpload: Identifiable {
        let id = UUID()
        let isVideo: Bool
        fileprivate(set) var preview: UIImage?
        fileprivate(set) var progress: Double?
        @ObservationIgnored fileprivate var work: Task<[String], Error>?
        @ObservationIgnored fileprivate var isCancelled = false

        init(isVideo: Bool) {
            self.isVideo = isVideo
        }

        func cancel() {
            isCancelled = true
            work?.cancel()
        }
    }

    private enum UploadSource {
        case picked(PhotosPickerItem)
        case resumed(ChunkedUploadJob)
    }

    func detail(_ id: String) -> JourneyDetail? { entry(id).detail }

    func loadFailed(_ id: String) -> Bool { entry(id).loadFailed }

    func pendingUploads(_ id: String) -> [PendingUpload] { entry(id).pendingUploads }

    func localPreviews(_ id: String) -> [String: UIImage] { entry(id).localPreviews }

    func uploadingLabel(_ id: String) -> String? {
        let pending = entry(id).pendingUploads
        guard !pending.isEmpty else { return nil }
        let videos = pending.filter(\.isVideo).count
        return JourneyPhoto.describeCounts(photos: pending.count - videos, videos: videos)
    }

    func uploadError(_ id: String) -> String? { entry(id).uploadError }

    func clearUploadError(_ id: String) { entry(id).uploadError = nil }

    private func entry(_ id: String) -> Entry {
        if let entry = entries[id] { return entry }
        let entry = Entry()
        entries[id] = entry
        return entry
    }

    func load(_ id: String, force: Bool = false) async {
        if let pending = inFlight[id] {
            await pending.value
            return
        }
        let entry = entry(id)
        guard force || entry.detail == nil || loadedGeneration[id] != generation else { return }

        let requestGeneration = generation
        let task = Task {
            if entry.loadFailed { entry.loadFailed = false }
            do {
                let revision = entry.mediaRevision
                var detail = try await APIService.shared.fetchJourneyDetail(id: id)
                if entry.mediaRevision == revision {
                    settleMedia(from: entry.detail?.photos ?? [], to: detail.photos ?? [], in: entry)
                } else {
                    detail.photos = entry.detail?.photos
                }
                entry.detail = detail
                loadedGeneration[id] = requestGeneration
            } catch {
                print("Failed to load journey detail: \(error)")
                if entry.detail == nil { entry.loadFailed = true }
            }
            inFlight[id] = nil
        }
        inFlight[id] = task
        await task.value
    }

    func markAllStale() {
        generation += 1
    }

    func uploadMedia(_ items: [PhotosPickerItem], to id: String) {
        guard !items.isEmpty else { return }
        let sources = items.map { UploadSource.picked($0) }
        let pending = items.map { PendingUpload(isVideo: MediaUploadEncoder.isVideo($0)) }
        runUploads(sources, pending, to: id)
    }

    func resumeInterruptedUploads() {
        let jobs = VideoUploadQueue.shared.claimInterrupted()
        for (id, journeyJobs) in Dictionary(grouping: jobs, by: \.journeyID) {
            runUploads(journeyJobs.map(UploadSource.resumed), journeyJobs.map { _ in PendingUpload(isVideo: true) }, to: id)
        }
    }

    private func runUploads(_ sources: [UploadSource], _ pending: [PendingUpload], to id: String) {
        let entry = entry(id)
        entry.pendingUploads.append(contentsOf: pending)
        entry.uploadError = nil

        Task {
            UploadBackgroundTime.shared.begin()
            defer { UploadBackgroundTime.shared.end() }

            var problems: [String] = []
            for (source, placeholder) in zip(sources, pending) {
                let work = Task { try await send(source, placeholder, to: id, entry: entry) }
                placeholder.work = work
                if placeholder.isCancelled { work.cancel() }
                do {
                    problems += try await work.value
                } catch is CancellationError {
                } catch let error as URLError where error.code == .cancelled {
                } catch {
                    print("Failed to upload media: \(error)")
                    problems.append(error.localizedDescription)
                }
                entry.pendingUploads.removeAll { $0 === placeholder }
            }

            if let reason = problems.first {
                let videos = pending.filter(\.isVideo).count
                let noun = videos == 0 ? "photos" : videos == pending.count ? "videos" : "items"
                entry.uploadError = pending.count == 1
                    ? reason
                    : "\(problems.count) of \(pending.count) \(noun) couldn't be uploaded. \(reason)"
            }
        }
    }

    private func send(
        _ source: UploadSource,
        _ placeholder: PendingUpload,
        to id: String,
        entry: Entry
    ) async throws -> [String] {
        let queue = VideoUploadQueue.shared
        let onProgress: @MainActor (Double) -> Void = { placeholder.progress = $0 }

        switch source {
        case .resumed(let job):
            placeholder.preview = await MediaUploadEncoder.videoPreview(queue.fileURL(for: job))
            let result = try await queue.upload(job, onProgress: onProgress)
            return add(result, preview: placeholder.preview, photoData: nil, to: entry, id: id)

        case .picked(let item):
            let prepared = try await MediaUploadEncoder.prepare(item)
            placeholder.preview = prepared.preview
            switch prepared.contents {
            case .video(let video):
                if Task.isCancelled {
                    video.discard()
                    throw CancellationError()
                }
                guard let job = try await queue.enqueue(video, journeyID: id) else { return [] }
                let result = try await queue.upload(job, onProgress: onProgress)
                return add(result, preview: prepared.preview, photoData: nil, to: entry, id: id)

            case .photo(let file):
                let result = try await APIService.shared.uploadMedia([file], toJourney: id) { sent in
                    Task { @MainActor in
                        if sent >= 1 || sent - (placeholder.progress ?? 0) >= 0.01 {
                            placeholder.progress = sent
                        }
                    }
                }
                return add(result, preview: prepared.preview, photoData: file.data, to: entry, id: id)
            }
        }
    }

    private func add(
        _ result: APIService.MediaUploadResult,
        preview: UIImage?,
        photoData: Data?,
        to entry: Entry,
        id: String
    ) -> [String] {
        for uploaded in result.photos {
            if let photoData, let filename = uploaded.filename {
                JourneyPhotoCache.shared.insertOriginal(photoData, for: filename)
            }
            if uploaded.isProcessing {
                entry.localPreviews[uploaded.id] = preview
            }
        }
        add(result.photos, to: entry)
        watchProcessingMedia(id)
        return (result.skipped ?? []).map(\.reason)
    }

    func deleteMedia(_ item: JourneyPhoto, from id: String) async throws {
        try await APIService.shared.deletePhoto(id: item.id, fromJourney: id)
        let entry = entry(id)
        entry.mediaRevision += 1
        entry.detail?.photos?.removeAll { $0.id == item.id }
        entry.localPreviews[item.id] = nil
    }

    func watchProcessingMedia(_ id: String) {
        guard mediaPolls[id] == nil else { return }
        let entry = entry(id)
        guard entry.detail?.photos?.contains(where: \.isProcessing) == true else { return }

        mediaPolls[id] = Task {
            while let processing = entry.detail?.photos?.filter(\.isProcessing), !processing.isEmpty {
                let interval: Duration = processing.contains { !$0.isVideo } ? .seconds(1) : .seconds(4)
                try? await Task.sleep(for: interval)
                let revision = entry.mediaRevision
                guard let media = try? await APIService.shared.fetchJourneyMedia(id: id),
                      entry.mediaRevision == revision else { continue }
                apply(media, to: entry)
            }
            mediaPolls[id] = nil
        }
    }

    private func add(_ uploaded: [JourneyPhoto], to entry: Entry) {
        let existing = entry.detail?.photos ?? []
        entry.mediaRevision += 1
        entry.detail?.photos = existing + uploaded.filter { item in
            !existing.contains { $0.id == item.id }
        }
    }

    private func apply(_ media: [JourneyPhoto], to entry: Entry) {
        let previous = entry.detail?.photos ?? []
        guard media != previous else { return }
        settleMedia(from: previous, to: media, in: entry)
        entry.detail?.photos = media
    }

    private func settleMedia(from previous: [JourneyPhoto], to media: [JourneyPhoto], in entry: Entry) {
        var failedPhotos = 0
        var failedVideos = 0
        for item in media where !item.isProcessing {
            guard let before = previous.first(where: { $0.id == item.id }), before.isProcessing else { continue }
            entry.localPreviews[item.id] = nil
            if item.isFailed {
                if item.isVideo { failedVideos += 1 } else { failedPhotos += 1 }
            } else if !item.isVideo, let old = before.filename, let new = item.filename, old != new {
                JourneyPhotoCache.shared.moveOriginal(from: old, to: new)
            }
        }

        var messages: [String] = []
        if failedVideos > 0 {
            messages.append(failedVideos == 1 ? "A video couldn't be converted." : "\(failedVideos) videos couldn't be converted.")
        }
        if failedPhotos > 0 {
            messages.append(failedPhotos == 1 ? "A photo couldn't be processed." : "\(failedPhotos) photos couldn't be processed.")
        }
        if !messages.isEmpty {
            entry.uploadError = messages.joined(separator: " ")
        }
    }
}

@Observable
final class JourneyStoryScrollState {
    var offsets: [String: CGFloat] = [:]
}

private struct JourneyStoryChrome: View {
    let scrollState: JourneyStoryScrollState
    let selectedID: String
    let pageIndex: Int
    let pageCount: Int
    let safeArea: EdgeInsets
    let hasRoute: Bool
    let canAddPhotos: Bool
    let uploadingLabel: String?
    let onClose: () -> Void
    let onRename: () -> Void
    let onAddPhotos: () -> Void
    let onOpenMap: () -> Void
    let onOpenRouteCard: () -> Void

    var body: some View {
        let progress = min(max((scrollState.offsets[selectedID] ?? 0) / 240, 0), 1)

        ZStack(alignment: .top) {
            LinearGradient(
                stops: [
                    .init(color: .black, location: 0),
                    .init(color: .black, location: safeArea.top / (safeArea.top + 72)),
                    .init(color: .black.opacity(0), location: 1)
                ],
                startPoint: .top,
                endPoint: .bottom
            )
            .frame(height: safeArea.top + 72)
                .opacity(progress)
                .allowsHitTesting(false)

            VStack(spacing: 0) {
                HStack {
                    Button(action: onClose) {
                        chromeIcon("xmark")
                    }
                    .accessibilityLabel("Close")

                    Spacer()

                    if let uploadingLabel {
                        uploadStatus(uploadingLabel)
                            .transition(.opacity.combined(with: .scale(scale: 0.9)))
                    }

                    Spacer()

                    Menu {
                        Button("Rename", systemImage: "pencil", action: onRename)
                        Button("Add Photos & Videos", systemImage: "photo.badge.plus", action: onAddPhotos)
                            .disabled(!canAddPhotos)
                        Button("Full-Screen Map", systemImage: "arrow.up.left.and.arrow.down.right", action: onOpenMap)
                            .disabled(!hasRoute)
                        Button("Route Card", systemImage: "map.fill", action: onOpenRouteCard)
                            .disabled(!hasRoute)
                    } label: {
                        chromeIcon("ellipsis")
                    }
                    .menuStyle(.button)
                    .accessibilityLabel("Journey actions")
                }
                .buttonStyle(.glass)
                .buttonBorderShape(.circle)
                .padding(.horizontal, 20)
                .padding(.top, safeArea.top + 6)
                .animation(.smooth(duration: 0.3), value: uploadingLabel != nil)

                Spacer()

                StoryPageIndicator(count: pageCount, current: pageIndex)
                    .opacity(1 - progress)
                    .padding(.bottom, max(safeArea.bottom, 16) + 12)
                    .allowsHitTesting(false)
            }
        }
    }

    private func chromeIcon(_ systemName: String) -> some View {
        Image(systemName: systemName)
            .font(.system(size: 15, weight: .semibold))
            .foregroundStyle(.white)
            .frame(width: 26, height: 26)
    }

    private func uploadStatus(_ label: String) -> some View {
        HStack(spacing: 8) {
            ProgressView()
                .controlSize(.small)
                .tint(.white)
            Text("Uploading \(label)")
                .font(.montserrat(size: 12, weight: .semibold))
                .foregroundStyle(.white)
                .contentTransition(.numericText())
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .glassEffect(.regular, in: .capsule)
        .allowsHitTesting(false)
    }
}

private struct JourneyStoryPage: View, Equatable {
    let summary: JourneySummary
    let store: JourneyDetailStore
    let scrollState: JourneyStoryScrollState
    let isActive: Bool
    let safeArea: EdgeInsets
    let mapIsOpen: Bool
    let onOpenMap: () -> Void
    let onOpenRouteCard: () -> Void
    let onAddPhotos: () -> Void

    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.summary == rhs.summary && lhs.isActive == rhs.isActive && lhs.safeArea == rhs.safeArea
            && lhs.mapIsOpen == rhs.mapIsOpen
            && lhs.store === rhs.store && lhs.scrollState === rhs.scrollState
    }

    static func heroRouteInsets(pageHeight: CGFloat, safeArea: EdgeInsets) -> UIEdgeInsets {
        UIEdgeInsets(top: safeArea.top + 72, left: 44, bottom: pageHeight * 0.48, right: 44)
    }

    @State private var scrollPosition = ScrollPosition(edge: .top)
    @State private var photosUnavailable = false
    @State private var viewerItem: MediaViewerItem?
    @State private var deleteError: String?
    @State private var showsDetails = false

    private struct MediaViewerItem: Identifiable {
        let id: String
    }

    private static let dateFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "MMM d, yyyy"
        return formatter
    }()

    private var detail: JourneyDetail? { store.detail(summary.id) }

    private var previewFilenames: [String] {
        detail?.previewFilenames ?? []
    }

    private var showsPhotos: Bool { !previewFilenames.isEmpty && !photosUnavailable }

    private var showsRouteBackdrop: Bool {
        !showsPhotos && (detail?.routeCoordinates.count ?? 0) >= 2
    }

    private var hasProcessingMedia: Bool {
        detail?.photos?.contains(where: \.isProcessing) == true
    }

    var body: some View {
        GeometryReader { geometry in
            ScrollView(.vertical) {
                LazyVStack(spacing: 0) {
                    hero(size: geometry.size)

                    if showsDetails {
                        JourneyStoryDetails(
                            detail: detail,
                            journeyID: summary.id,
                            media: detail?.photos ?? [],
                            localPreviews: store.localPreviews(summary.id),
                            pendingUploads: store.pendingUploads(summary.id),
                            loadFailed: store.loadFailed(summary.id),
                            showsRoutePreview: showsPhotos,
                            onRetry: { Task { await store.load(summary.id, force: true) } },
                            onOpenMap: onOpenMap,
                            onOpenRouteCard: onOpenRouteCard,
                            onOpenMedia: { viewerItem = MediaViewerItem(id: $0) },
                            onDeleteMedia: deleteMedia,
                            onAddPhotos: onAddPhotos
                        )
                    } else {
                        Color.black
                            .frame(height: geometry.size.height)
                    }

                    Color.black
                        .frame(height: 56)
                }
            }
            .scrollPosition($scrollPosition)
            .scrollIndicators(.hidden)
            .onScrollGeometryChange(for: CGFloat.self) { scroll in
                min(max(scroll.contentOffset.y + scroll.contentInsets.top, 0), 400).rounded()
            } action: { _, offset in
                scrollState.offsets[summary.id] = offset
                if offset > 0, !showsDetails { showsDetails = true }
            }
        }
        .ignoresSafeArea()
        .background(Color.black)
        .fullScreenCover(item: $viewerItem) { item in
            JourneyMediaViewer(journeyID: summary.id, store: store, startID: item.id)
        }
        .alert(
            "Couldn't Delete",
            isPresented: Binding(get: { deleteError != nil }, set: { if !$0 { deleteError = nil } }),
            presenting: deleteError
        ) { _ in
            Button("OK", role: .cancel) {}
        } message: { message in
            Text(message)
        }
        .onChange(of: previewFilenames) {
            photosUnavailable = false
        }
        .onChange(of: isActive && hasProcessingMedia, initial: true) { _, watch in
            if watch { store.watchProcessingMedia(summary.id) }
        }
        .task {
            await store.load(summary.id)
        }
        .task(id: isActive) {
            guard isActive, !showsDetails else { return }
            try? await Task.sleep(for: .milliseconds(700))
            guard !Task.isCancelled else { return }
            showsDetails = true
        }
    }

    private func hero(size: CGSize) -> some View {
        ZStack(alignment: .bottomLeading) {
            heroBackdrop(size: size)
                .frame(width: size.width, height: size.height)
                .visualEffect { content, proxy in
                    let minY = proxy.frame(in: .scrollView).minY
                    return content.offset(y: minY < 0 ? -minY * 0.35 : 0)
                }
                .clipped()

            Group {
                LinearGradient(colors: [.black.opacity(0.5), .clear], startPoint: .top, endPoint: .bottom)
                    .frame(height: safeArea.top + 120)
                    .frame(maxHeight: .infinity, alignment: .top)

                LinearGradient(
                    stops: [
                        .init(color: .clear, location: 0),
                        .init(color: .black.opacity(0.75), location: 0.8),
                        .init(color: .black, location: 1)
                    ],
                    startPoint: .top,
                    endPoint: .bottom
                )
                .frame(height: size.height * 0.5)
                .frame(maxHeight: .infinity, alignment: .bottom)

                heroCaption
                    .padding(.horizontal, 24)
                    .padding(.bottom, max(safeArea.bottom, 16) + 44)
                    .modifier(FadeBelowChrome(chromeHeight: safeArea.top + 56))
            }
            .opacity(mapIsOpen ? 0 : 1)
            .allowsHitTesting(false)
        }
        .frame(width: size.width, height: size.height)
        .overlay(alignment: .bottomTrailing) {
            Button {
                scrollToDetails(pageHeight: size.height)
            } label: {
                Image(systemName: "chevron.compact.down")
                    .font(.system(size: 22, weight: .semibold))
                    .foregroundStyle(.white.opacity(0.6))
                    .frame(width: 44, height: 28)
            }
            .buttonStyle(.plain)
            .padding(.trailing, 14)
            .padding(.bottom, max(safeArea.bottom, 16) + 1)
            .modifier(FadeBelowChrome(chromeHeight: safeArea.top + 56))
            .opacity(mapIsOpen ? 0 : 1)
            .accessibilityLabel("Show details")
        }
        .contentShape(Rectangle())
        .onTapGesture {
            if showsRouteBackdrop {
                onOpenMap()
            } else {
                scrollToDetails(pageHeight: size.height)
            }
        }
    }

    @ViewBuilder
    private func heroBackdrop(size: CGSize) -> some View {
        if showsPhotos {
            ZStack {
                heroPlaceholder
                HeroPhotoSlideshow(filenames: previewFilenames, isActive: isActive) {
                    photosUnavailable = true
                }
            }
        } else if showsRouteBackdrop, let detail {
            ZStack {
                heroPlaceholder
                JourneyRouteSnapshotView(
                    journeyID: summary.id,
                    coordinates: detail.routeCoordinates,
                    insets: Self.heroRouteInsets(pageHeight: size.height, safeArea: safeArea),
                    lineWidth: 4
                )
            }
        } else {
            heroPlaceholder
        }
    }

    private var heroPlaceholder: some View {
        LinearGradient(colors: [Color(hex: "#1E272C"), .black], startPoint: .top, endPoint: .bottom)
            .overlay {
                if detail == nil && !store.loadFailed(summary.id) {
                    ProgressView()
                        .tint(.white.opacity(0.7))
                }
            }
    }

    private var heroCaption: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 10) {
                JourneyCategoryPill(travelMode: detail?.travelMode ?? summary.travelMode)

                if let startDate = summary.startDate {
                    Text(Self.dateFormatter.string(from: startDate).uppercased())
                        .font(.montserrat(size: 11, weight: .medium))
                        .tracking(1.2)
                        .foregroundStyle(.white.opacity(0.75))
                }
            }

            Text(detail?.name ?? summary.displayName)
                .font(.montserrat(size: 34, weight: .heavy))
                .lineHeight(.exact(points: 37))
                .foregroundStyle(.white)
                .lineLimit(3)
                .shadow(color: .black.opacity(0.25), radius: 12, y: 2)

            JourneyMetadataRow(summary: summary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func deleteMedia(_ item: JourneyPhoto) {
        Task {
            do {
                try await store.deleteMedia(item, from: summary.id)
            } catch {
                deleteError = error.localizedDescription
            }
        }
    }

    private func scrollToDetails(pageHeight: CGFloat) {
        showsDetails = true
        withAnimation(.smooth(duration: 0.55)) {
            scrollPosition.scrollTo(y: pageHeight - safeArea.top - 60)
        }
    }
}

private struct FadeBelowChrome: ViewModifier {
    let chromeHeight: CGFloat

    func body(content: Content) -> some View {
        content.visualEffect { content, proxy in
            let bottom = proxy.frame(in: .scrollView).maxY
            return content.opacity(min(max((bottom - chromeHeight) / 220, 0), 1))
        }
    }
}

private struct HeroPhotoSlideshow: View {
    let filenames: [String]
    let isActive: Bool
    let onUnavailable: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var index = 0
    @State private var failed: Set<String> = []
    @State private var direction = 1

    private struct Tick: Equatable {
        let index: Int
        let isActive: Bool
        let photoCount: Int
    }

    private var current: Int { min(index, filenames.count - 1) }

    private var showableCount: Int {
        filenames.filter { !failed.contains($0) }.count
    }

    var body: some View {
        let filename = filenames[current]

        ZStack {
            KenBurnsPhoto(filename: filename, animate: isActive && !reduceMotion) {
                handleFailure(of: filename)
            }
            .id(filename)
            .transition(.opacity)
        }
        .overlay {
            if showableCount > 1 {
                HStack(spacing: 0) {
                    tapZone("Previous photo") { step(by: -1) }
                    tapZone("Next photo") { step(by: 1) }
                }
            }
        }
        .task(id: Tick(index: index, isActive: isActive, photoCount: filenames.count)) {
            guard isActive, showableCount > 1 else { return }

            let next = neighbor(of: current, by: 1)
            let previous = neighbor(of: current, by: -1)
            for neighbor in next == previous ? [next] : [next, previous] {
                _ = await JourneyPhotoCache.shared.image(for: filenames[neighbor], maxPixelSize: JourneyPhotoCache.heroPixelSize)
            }

            try? await Task.sleep(for: .seconds(6))
            guard !Task.isCancelled else { return }
            direction = 1
            withAnimation(.easeInOut(duration: 1.2)) { index = next }
        }
    }

    private func tapZone(_ label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Color.clear
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }

    private func step(by offset: Int) {
        let target = neighbor(of: current, by: offset)
        guard target != current else { return }
        direction = offset
        withAnimation(.easeOut(duration: 0.3)) { index = target }
    }

    private func neighbor(of start: Int, by offset: Int) -> Int {
        let count = filenames.count
        var candidate = start
        for _ in 0..<count {
            candidate = ((candidate + offset) % count + count) % count
            if !failed.contains(filenames[candidate]) { return candidate }
        }
        return start
    }

    private func handleFailure(of filename: String) {
        failed.insert(filename)
        if showableCount == 0 {
            onUnavailable()
        } else {
            index = neighbor(of: current, by: direction)
        }
    }
}

private struct KenBurnsPhoto: View {
    let filename: String
    let animate: Bool
    let onFailure: () -> Void

    @State private var zoomed = false

    var body: some View {
        JourneyPhotoView(filename: filename, onFailure: onFailure)
            .scaleEffect(zoomed ? 1.08 : 1)
            .task(id: animate) {
                guard animate, !zoomed else { return }
                withAnimation(.linear(duration: 9)) { zoomed = true }
            }
    }
}

private struct JourneyStoryDetails: View {
    let detail: JourneyDetail?
    let journeyID: String
    let media: [JourneyPhoto]
    let localPreviews: [String: UIImage]
    let pendingUploads: [JourneyDetailStore.PendingUpload]
    let loadFailed: Bool
    let showsRoutePreview: Bool
    let onRetry: () -> Void
    let onOpenMap: () -> Void
    let onOpenRouteCard: () -> Void
    let onOpenMedia: (String) -> Void
    let onDeleteMedia: (JourneyPhoto) -> Void
    let onAddPhotos: () -> Void

    @AppStorage(AppConstants.useMetricUnitsKey) private var useMetricUnits = false
    @State private var unviewableItem: JourneyPhoto?

    private enum ProfileChart: Hashable {
        case elevation, speed, acceleration
    }

    private static let dayFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "EEE, MMM d"
        return formatter
    }()

    private static let timeFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm"
        return formatter
    }()

    var body: some View {
        Group {
            if let detail {
                summary(detail)

                if showsRoutePreview, detail.routeCoordinates.count >= 2 {
                    routePreview(detail)
                }

                charts(for: detail)

                photosSection
            } else if loadFailed {
                failureView
            } else {
                ProgressView()
                    .tint(AppConstants.journeyGreen)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 80)
            }
        }
        .padding(.horizontal, 24)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.black)
    }

    private func summary(_ detail: JourneyDetail) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            distanceLede(detail)

            hairline

            LazyVGrid(
                columns: Array(repeating: GridItem(.flexible(), spacing: 12, alignment: .topLeading), count: 3),
                alignment: .leading,
                spacing: 22
            ) {
                ForEach(stats(for: detail)) { stat in
                    StoryStatCell(stat: stat)
                }
            }

            hairline

            actions
        }
        .padding(.top, 12)
    }

    private func routePreview(_ detail: JourneyDetail) -> some View {
        section("ROUTE") {
            JourneyRouteSnapshotView(journeyID: journeyID, coordinates: detail.routeCoordinates, lineWidth: 4)
                .frame(height: 220)
                .background(AppConstants.darkCardBackground)
                .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
                .overlay(alignment: .topTrailing) {
                    Image(systemName: "arrow.up.left.and.arrow.down.right")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(.white)
                        .frame(width: 32, height: 32)
                        .background(Circle().fill(Color.black.opacity(0.6)))
                        .padding(12)
                }
                .contentShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
                .onTapGesture(perform: onOpenMap)
        }
    }

    private func distanceLede(_ detail: JourneyDetail) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            sectionLabel("DISTANCE")
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(DistanceFormatter.format(detail.distanceDouble, useMetric: useMetricUnits))
                    .font(.montserrat(size: 56, weight: .heavy))
                    .foregroundStyle(.white)
                Text(DistanceFormatter.unit(useMetric: useMetricUnits))
                    .font(.montserrat(size: 20, weight: .semibold))
                    .foregroundStyle(.white.opacity(0.5))
            }
            if let timeline = timeline(for: detail) {
                Text(timeline)
                    .font(.montserrat(size: 13))
                    .foregroundStyle(.white.opacity(0.6))
            }
        }
    }

    private var actions: some View {
        Button(action: onOpenRouteCard) {
            Label("Route Card", systemImage: "map.fill")
                .font(.montserrat(size: 15, weight: .semibold))
                .foregroundStyle(.black)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 14)
                .background(Capsule().fill(AppConstants.journeyGreen))
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder
    private func charts(for detail: JourneyDetail) -> some View {
        let charts = profileCharts(for: detail)
        if !charts.isEmpty {
            sectionLabel("PROFILES")
                .padding(.top, 36)

            ForEach(Array(charts.enumerated()), id: \.element) { index, chart in
                profileChart(chart, detail: detail)
                    .padding(.top, index == 0 ? 12 : 16)
            }
        }
    }

    private func profileCharts(for detail: JourneyDetail) -> [ProfileChart] {
        guard let distMi = detail.profileDistMi, distMi.count >= 2 else { return [] }
        var charts: [ProfileChart] = []
        if detail.profileElevM != nil { charts.append(.elevation) }
        if detail.profileSpeedMph != nil { charts.append(.speed) }
        if detail.profileSpeedMph != nil, detail.profileTimeMs != nil { charts.append(.acceleration) }
        return charts
    }

    @ViewBuilder
    private func profileChart(_ chart: ProfileChart, detail: JourneyDetail) -> some View {
        let distMi = detail.profileDistMi ?? []
        let timesMs = detail.profileTimeMs ?? []
        switch chart {
        case .elevation:
            ElevationChart(
                distancesMi: distMi,
                elevationsM: detail.profileElevM ?? [],
                timesMs: timesMs,
                topElevationM: detail.topElevation.flatMap(Double.init),
                lowestElevationM: detail.lowestElevation.flatMap(Double.init)
            )
            .equatable()
        case .speed:
            SpeedChart(
                distancesMi: distMi,
                speedsMph: detail.profileSpeedMph ?? [],
                timesMs: timesMs,
                topSpeedMph: detail.topSpeed.flatMap(Double.init),
                averageSpeedMph: detail.avgSpeed.flatMap(Double.init)
            )
            .equatable()
        case .acceleration:
            AccelerationChart(distancesMi: distMi, speedsMph: detail.profileSpeedMph ?? [], timesMs: timesMs)
                .equatable()
        }
    }

    private var mediaLabel: String {
        guard !media.isEmpty else { return "PHOTOS" }
        let title = media.contains(where: \.isVideo) ? "PHOTOS & VIDEOS" : "PHOTOS"
        return "\(title) \u{00B7} \(media.count)"
    }

    private var photosSection: some View {
        let isEmpty = media.isEmpty && pendingUploads.isEmpty

        return VStack(alignment: .leading, spacing: 12) {
            HStack {
                sectionLabel(mediaLabel)

                Spacer()

                if !isEmpty {
                    Button(action: onAddPhotos) {
                        Label("Add", systemImage: "plus")
                            .font(.montserrat(size: 13, weight: .semibold))
                            .foregroundStyle(AppConstants.journeyGreen)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Add Photos and Videos")
                }
            }

            if isEmpty {
                addPhotosPlaceholder
            } else {
                photoStrip
            }
        }
        .padding(.top, 36)
        .confirmationDialog(
            unviewableItem.map(unviewableTitle) ?? "",
            isPresented: Binding(get: { unviewableItem != nil }, set: { if !$0 { unviewableItem = nil } }),
            titleVisibility: .visible,
            presenting: unviewableItem
        ) { item in
            Button(item.isVideo ? "Delete Video" : "Delete Photo", role: .destructive) {
                onDeleteMedia(item)
            }
        }
    }

    private func unviewableTitle(_ item: JourneyPhoto) -> String {
        switch (item.isFailed, item.isVideo) {
        case (true, true): "This video couldn't be converted."
        case (true, false): "This photo couldn't be processed."
        case (false, true): "This video is still being converted for playback."
        case (false, false): "This photo is still being processed."
        }
    }

    private var addPhotosPlaceholder: some View {
        Button(action: onAddPhotos) {
            VStack(spacing: 10) {
                Image(systemName: "photo.badge.plus")
                    .font(.system(size: 28))
                Text("Add photos and videos from this journey")
                    .font(.montserrat(size: 14, weight: .semibold))
            }
            .foregroundStyle(.white.opacity(0.6))
            .frame(maxWidth: .infinity)
            .frame(height: 140)
            .background(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .fill(AppConstants.darkCardBackground)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .strokeBorder(Color.white.opacity(0.14), style: StrokeStyle(lineWidth: 1, dash: [6, 5]))
            )
            .contentShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        }
        .buttonStyle(.plain)
    }

    private var photoStrip: some View {
        ScrollView(.horizontal) {
            LazyHStack(spacing: 10) {
                ForEach(media, id: \.id) { item in
                    Button {
                        if item.isViewable {
                            onOpenMedia(item.id)
                        } else {
                            unviewableItem = item
                        }
                    } label: {
                        if item.isViewable {
                            MediaTile(item: item)
                        } else {
                            MediaStatusTile(item: item, preview: localPreviews[item.id])
                        }
                    }
                    .buttonStyle(.plain)
                }

                ForEach(pendingUploads) { upload in
                    PendingUploadTile(upload: upload)
                }
            }
        }
        .scrollIndicators(.hidden)
        .scrollClipDisabled()
    }

    private var failureView: some View {
        VStack(spacing: 14) {
            Text("Couldn't load this journey")
                .font(.montserrat(size: 15, weight: .semibold))
                .foregroundStyle(.white.opacity(0.8))
            Button(action: onRetry) {
                Text("Retry")
                    .font(.montserrat(size: 14, weight: .semibold))
                    .foregroundStyle(.black)
                    .padding(.horizontal, 22)
                    .padding(.vertical, 10)
                    .background(Capsule().fill(AppConstants.journeyGreen))
            }
            .buttonStyle(.plain)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 60)
    }

    private var hairline: some View {
        Rectangle()
            .fill(Color.white.opacity(0.1))
            .frame(height: 0.5)
            .padding(.vertical, 24)
    }

    private func sectionLabel(_ text: String) -> some View {
        Text(text)
            .font(.montserrat(size: 12, weight: .bold))
            .foregroundColor(.gray)
            .tracking(1)
    }

    private func section<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            sectionLabel(title)
            content()
        }
        .padding(.top, 36)
    }

    private func stats(for detail: JourneyDetail) -> [StoryStat] {
        let speedUnit = JourneyUnits.speedUnit(useMetric: useMetricUnits)
        let elevationUnit = JourneyUnits.elevationUnit(useMetric: useMetricUnits)

        var stats = [
            durationStat(detail.duration),
            StoryStat(label: "Avg Speed", value: speed(detail.avgSpeedDouble), unit: speedUnit),
            StoryStat(label: "Top Speed", value: speed(detail.topSpeedDouble), unit: speedUnit),
            StoryStat(label: "Top Elev.", value: elevation(detail.topElevationDouble), unit: elevationUnit)
        ]
        if let gain = detail.elevationGain {
            stats.append(StoryStat(label: "Elev. Gain", value: "+\(elevation(gain))", unit: elevationUnit))
        }
        if let weather = detail.weather, let tempF = weather.temp {
            let temp = useMetricUnits ? (tempF - 32) * 5 / 9 : tempF
            stats.append(StoryStat(
                label: "Weather",
                value: "\(Int(temp.rounded()))\u{00B0}",
                unit: useMetricUnits ? "C" : "F",
                caption: (weather.condition ?? weather.description)?.capitalized
            ))
        }
        return stats
    }

    private func durationStat(_ duration: String?) -> StoryStat {
        guard let duration else { return StoryStat(label: "Duration", value: "\u{2014}") }
        let seconds = DurationFormatter.parseCompact(duration)
        let hours = seconds / 3600
        let minutes = (seconds % 3600) / 60
        if hours > 0 {
            return StoryStat(label: "Duration", value: "\(hours)h \(String(format: "%02d", minutes))m")
        }
        return StoryStat(label: "Duration", value: "\(minutes)", unit: "min")
    }

    private func speed(_ mph: Double) -> String {
        "\(Int(JourneyUnits.speed(fromMph: mph, useMetric: useMetricUnits).rounded()))"
    }

    private func elevation(_ meters: Double) -> String {
        "\(Int(JourneyUnits.elevation(fromMeters: meters, useMetric: useMetricUnits).rounded()))"
    }

    private func timeline(for detail: JourneyDetail) -> String? {
        var parts: [String] = []
        switch detail.travelMode {
        case "foot": parts.append("Walked")
        case "scooter": parts.append("Rode")
        case "drive": parts.append("Drove")
        case "flight": parts.append("Flew")
        default: break
        }
        if let start = detail.startDate {
            parts.append(Self.dayFormatter.string(from: start))
            var times = Self.timeFormatter.string(from: start)
            if let end = detail.endDate {
                times += " \u{2013} " + Self.timeFormatter.string(from: end)
            }
            parts.append(times)
        }
        return parts.isEmpty ? nil : parts.joined(separator: " \u{00B7} ")
    }
}

private struct StoryStat: Identifiable {
    let label: String
    let value: String
    var unit = ""
    var caption: String? = nil

    var id: String { label }
}

private struct StoryStatCell: View {
    let stat: StoryStat

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(stat.label.uppercased())
                .font(.montserrat(size: 10, weight: .semibold))
                .tracking(1)
                .foregroundStyle(AppConstants.journeyGreen)
                .lineLimit(1)

            HStack(alignment: .firstTextBaseline, spacing: 3) {
                Text(stat.value)
                    .font(.montserrat(size: 22, weight: .bold))
                    .foregroundStyle(.white)
                if !stat.unit.isEmpty {
                    Text(stat.unit)
                        .font(.montserrat(size: 12, weight: .medium))
                        .foregroundStyle(.white.opacity(0.5))
                }
            }
            .lineLimit(1)
            .minimumScaleFactor(0.7)

            if let caption = stat.caption {
                Text(caption)
                    .font(.montserrat(size: 11))
                    .foregroundStyle(.white.opacity(0.5))
                    .lineLimit(1)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct MediaTile: View {
    let item: JourneyPhoto

    var body: some View {
        Color.clear
            .overlay {
                if let preview = item.previewFilename {
                    JourneyPhotoView(filename: preview, maxPixelSize: 480, thumbnail: true)
                } else {
                    Image(systemName: "film")
                        .font(.system(size: 30))
                        .foregroundStyle(.white.opacity(0.35))
                }
            }
            .overlay(alignment: .bottomLeading) {
                if item.isVideo {
                    videoBadge
                        .padding(8)
                }
            }
            .frame(width: 128, height: 168)
            .background(AppConstants.darkCardBackground)
            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(item.isVideo ? "Video\(item.durationText.map { ", \($0)" } ?? "")" : "Photo")
    }

    private var videoBadge: some View {
        HStack(spacing: 4) {
            Image(systemName: "play.fill")
                .font(.system(size: 9, weight: .bold))
            if let duration = item.durationText {
                Text(duration)
                    .font(.montserrat(size: 11, weight: .semibold))
                    .monospacedDigit()
            }
        }
        .foregroundStyle(.white)
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .background(.black.opacity(0.5), in: Capsule())
    }
}

private struct MediaStatusTile: View {
    let item: JourneyPhoto
    let preview: UIImage?

    var body: some View {
        Color.clear
            .overlay {
                if let preview {
                    Image(uiImage: preview)
                        .resizable()
                        .aspectRatio(contentMode: .fill)
                        .opacity(0.45)
                }
            }
            .clipped()
            .overlay {
                VStack(spacing: 8) {
                    if item.isFailed {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .font(.system(size: 20))
                    } else {
                        ProgressView()
                            .tint(.white)
                    }
                    if let caption {
                        Text(caption)
                            .font(.montserrat(size: 11, weight: .semibold))
                            .multilineTextAlignment(.center)
                    }
                }
                .foregroundStyle(.white.opacity(0.85))
                .padding(.horizontal, 10)
            }
            .frame(width: 128, height: 168)
            .background(AppConstants.darkCardBackground)
            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(accessibilityText)
    }

    private var caption: String? {
        if item.isFailed { return item.isVideo ? "Couldn't convert" : "Couldn't process" }
        return item.isVideo ? "Converting" : nil
    }

    private var accessibilityText: String {
        switch (item.isFailed, item.isVideo) {
        case (true, true): "Video that couldn't be converted"
        case (true, false): "Photo that couldn't be processed"
        case (false, true): "Video being converted"
        case (false, false): "Photo being processed"
        }
    }
}

private struct PendingUploadTile: View {
    let upload: JourneyDetailStore.PendingUpload

    var body: some View {
        Color.clear
            .overlay {
                if let preview = upload.preview {
                    Image(uiImage: preview)
                        .resizable()
                        .aspectRatio(contentMode: .fill)
                        .opacity(0.45)
                        .transition(.opacity)
                }
            }
            .clipped()
            .overlay {
                if let progress = upload.progress, progress < 1 {
                    UploadProgressRing(progress: progress)
                } else {
                    ProgressView()
                        .tint(.white)
                }
            }
            .frame(width: 128, height: 168)
            .background(AppConstants.darkCardBackground)
            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
            .animation(.easeOut(duration: 0.3), value: upload.preview != nil)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(upload.isVideo ? "Uploading video" : "Uploading photo")
            .accessibilityValue(upload.progress.map { "\(Int($0 * 100)) percent" } ?? "")
            .accessibilityAction(named: "Cancel Upload") { upload.cancel() }
            .contextMenu {
                Button("Cancel Upload", systemImage: "xmark", role: .destructive) { upload.cancel() }
            }
    }
}

private struct UploadProgressRing: View {
    let progress: Double

    var body: some View {
        ZStack {
            Circle()
                .stroke(.white.opacity(0.25), lineWidth: 3)
            Circle()
                .trim(from: 0, to: progress)
                .stroke(.white, style: StrokeStyle(lineWidth: 3, lineCap: .round))
                .rotationEffect(.degrees(-90))
        }
        .frame(width: 28, height: 28)
        .animation(.linear(duration: 0.2), value: progress)
    }
}

private struct JourneyMediaViewer: View {
    let journeyID: String
    let store: JourneyDetailStore

    @State private var selection: String
    @State private var showDeleteConfirmation = false
    @State private var isDeleting = false
    @State private var deleteError: String?
    @Environment(\.dismiss) private var dismiss

    init(journeyID: String, store: JourneyDetailStore, startID: String) {
        self.journeyID = journeyID
        self.store = store
        _selection = State(initialValue: startID)
    }

    private var media: [JourneyPhoto] {
        store.detail(journeyID)?.viewableMedia ?? []
    }

    private var selectedIndex: Int? {
        media.firstIndex { $0.id == selection }
    }

    private var selectedIsVideo: Bool {
        selectedIndex.map { media[$0].isVideo } ?? false
    }

    var body: some View {
        GeometryReader { proxy in
            ZStack(alignment: .top) {
                Color.black.ignoresSafeArea()

                TabView(selection: $selection) {
                    ForEach(media, id: \.id) { item in
                        page(for: item, safeArea: proxy.safeAreaInsets)
                            .tag(item.id)
                    }
                }
                .tabViewStyle(.page(indexDisplayMode: .never))
                .ignoresSafeArea()

                toolbar
            }
        }
        .alert(
            "Couldn't Delete",
            isPresented: Binding(get: { deleteError != nil }, set: { if !$0 { deleteError = nil } }),
            presenting: deleteError
        ) { _ in
            Button("OK", role: .cancel) {}
        } message: { message in
            Text(message)
        }
    }

    @ViewBuilder
    private func page(for item: JourneyPhoto, safeArea: EdgeInsets) -> some View {
        if let filename = item.filename {
            if item.isVideo {
                JourneyVideoPage(video: item, filename: filename, isSelected: item.id == selection)
                    .padding(.top, safeArea.top + 52)
                    .padding(.bottom, safeArea.bottom)
            } else {
                JourneyPhotoView(filename: filename, contentMode: .fit)
            }
        }
    }

    private var toolbar: some View {
        HStack(spacing: 12) {
            if let selectedIndex {
                Text("\(selectedIndex + 1) / \(media.count)")
                    .font(.montserrat(size: 13, weight: .semibold))
                    .foregroundStyle(.white.opacity(0.8))
            }

            Spacer()

            Button {
                showDeleteConfirmation = true
            } label: {
                Group {
                    if isDeleting {
                        ProgressView()
                            .controlSize(.small)
                            .tint(.white)
                    } else {
                        Image(systemName: "trash")
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(.white)
                    }
                }
                .frame(width: 26, height: 26)
            }
            .disabled(isDeleting || selectedIndex == nil)
            .accessibilityLabel(selectedIsVideo ? "Delete Video" : "Delete Photo")
            .confirmationDialog(
                selectedIsVideo ? "Delete this video?" : "Delete this photo?",
                isPresented: $showDeleteConfirmation,
                titleVisibility: .visible
            ) {
                Button(selectedIsVideo ? "Delete Video" : "Delete Photo", role: .destructive, action: deleteSelected)
            } message: {
                Text("It will be removed from this journey.")
            }

            Button {
                dismiss()
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: 26, height: 26)
            }
            .accessibilityLabel("Close")
        }
        .buttonStyle(.glass)
        .buttonBorderShape(.circle)
        .padding(.horizontal, 20)
        .padding(.top, 8)
    }

    private func deleteSelected() {
        guard let index = selectedIndex else { return }
        let item = media[index]
        isDeleting = true
        Task {
            do {
                try await store.deleteMedia(item, from: journeyID)
                let remaining = media.map(\.id)
                if remaining.isEmpty {
                    dismiss()
                } else {
                    selection = remaining[min(index, remaining.count - 1)]
                }
            } catch {
                deleteError = error.localizedDescription
            }
            isDeleting = false
        }
    }
}

private struct JourneyVideoPage: View {
    let video: JourneyPhoto
    let filename: String
    let isSelected: Bool

    @State private var player: AVPlayer?
    @State private var isReady = false
    @State private var failed = false
    @State private var holdsAudio = false

    var body: some View {
        ZStack {
            if !isReady, let poster = video.posterFilename {
                JourneyPhotoView(filename: poster, contentMode: .fit)
            }

            if let player {
                VideoPlayer(player: player)
                    .opacity(isReady ? 1 : 0)
            }

            if failed {
                Text("Couldn't play this video")
                    .font(.montserrat(size: 14, weight: .semibold))
                    .foregroundStyle(.white.opacity(0.8))
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
                    .background(.black.opacity(0.6), in: Capsule())
            } else if isSelected && !isReady {
                ProgressView()
                    .tint(.white)
            }
        }
        .task(id: isSelected) {
            guard isSelected else {
                stop()
                return
            }
            guard let player = player ?? makePlayer() else {
                failed = true
                return
            }
            self.player = player
            if !holdsAudio {
                VideoPlaybackAudio.begin()
                holdsAudio = true
            }
            player.play()

            guard !isReady, let item = player.currentItem else { return }
            for await status in item.publisher(for: \.status).values {
                if status == .readyToPlay {
                    withAnimation(.easeOut(duration: 0.25)) { isReady = true }
                    break
                }
                if status == .failed {
                    print("Video playback failed: \(item.error?.localizedDescription ?? "unknown error")")
                    failed = true
                    break
                }
            }
        }
        .onDisappear(perform: stop)
    }

    private func makePlayer() -> AVPlayer? {
        guard let asset = try? APIService.shared.videoAsset(filename: filename) else { return nil }
        return AVPlayer(playerItem: AVPlayerItem(asset: asset))
    }

    private func stop() {
        player?.pause()
        if holdsAudio {
            VideoPlaybackAudio.end()
            holdsAudio = false
        }
    }
}

private enum VideoPlaybackAudio {
    private static var holders = 0

    static func begin() {
        holders += 1
        guard holders == 1 else { return }
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playback, mode: .moviePlayback)
        try? session.setActive(true)
    }

    static func end() {
        guard holders > 0 else { return }
        holders -= 1
        guard holders == 0 else { return }
        let session = AVAudioSession.sharedInstance()
        try? session.setActive(false, options: .notifyOthersOnDeactivation)
        try? session.setCategory(.soloAmbient)
    }
}

private extension Array {
    subscript(safe index: Int) -> Element? {
        indices.contains(index) ? self[index] : nil
    }
}
