import SwiftUI
import ImageIO

// MARK: - Photo Cache

/// Downsampled journey photos kept in memory, keyed by server filename, copy and target size.
/// Recently downloaded originals are kept too, so the hero and its thumbnail share one download.
/// Gallery tiles otherwise load the reduced copy the server makes (`/photos/thumb/`).
final class JourneyPhotoCache {
    static let shared = JourneyPhotoCache()
    /// Long-edge size for full-screen photos; enough to cover-crop on Pro Max screens.
    static let heroPixelSize: CGFloat = 2400

    private let cache = NSCache<NSString, UIImage>()
    private let dataCache = NSCache<NSString, NSData>()
    private var inFlight: [NSString: Task<UIImage?, Never>] = [:]
    private var dataInFlight: [String: Task<Data?, Never>] = [:]
    /// Cache keys decoded so far per filename and size, so a view can show one while its
    /// own loads.
    private var decodedKeys: [String: [Int: NSString]] = [:]

    private init() {
        cache.totalCostLimit = 160 * 1024 * 1024
        dataCache.totalCostLimit = 64 * 1024 * 1024
    }

    func cachedImage(for filename: String, maxPixelSize: CGFloat, thumbnail: Bool = false) -> UIImage? {
        cache.object(forKey: cacheKey(filename, maxPixelSize, thumbnail: thumbnail))
    }

    /// The largest copy of `filename` already decoded at any size, e.g. a list card's photo
    /// while the full-screen page decodes its larger one.
    func largestCachedImage(for filename: String) -> UIImage? {
        let decoded = decodedKeys[filename] ?? [:]
        for size in decoded.keys.sorted(by: >) {
            if let key = decoded[size], let image = cache.object(forKey: key) { return image }
        }
        return nil
    }

    func image(for filename: String, maxPixelSize: CGFloat, thumbnail: Bool = false) async -> UIImage? {
        let key = cacheKey(filename, maxPixelSize, thumbnail: thumbnail)
        if let cached = cache.object(forKey: key) { return cached }
        if let pending = inFlight[key] { return await pending.value }

        let task = Task<UIImage?, Never> {
            guard let data = await self.data(for: filename, thumbnail: thumbnail) else { return nil }
            return await Task.detached(priority: .userInitiated) {
                Self.downsample(data, maxPixelSize: maxPixelSize)
            }.value
        }
        inFlight[key] = task
        let image = await task.value
        inFlight[key] = nil

        if let image, let cgImage = image.cgImage {
            cache.setObject(image, forKey: key, cost: cgImage.bytesPerRow * cgImage.height)
            decodedKeys[filename, default: [:]][Int(maxPixelSize)] = key
        }
        return image
    }

    /// Seeds the original for a photo just uploaded from this device, so it shows without
    /// downloading it back.
    func insertOriginal(_ data: Data, for filename: String) {
        dataCache.setObject(data as NSData, forKey: filename as NSString, cost: data.count)
    }

    /// Carries a seeded original over to the file the server converted it to. A HEIC upload
    /// becomes a JPEG with a new filename, but decodes to the same picture.
    func moveOriginal(from oldFilename: String, to newFilename: String) {
        guard let data = dataCache.object(forKey: oldFilename as NSString) else { return }
        dataCache.removeObject(forKey: oldFilename as NSString)
        dataCache.setObject(data, forKey: newFilename as NSString, cost: data.length)
    }

    private func data(for filename: String, thumbnail: Bool) async -> Data? {
        // An original already here (just uploaded, or shown full-screen) makes any smaller
        // copy without another download
        if let cached = dataCache.object(forKey: filename as NSString) { return cached as Data }
        let key = thumbnail ? "thumb/\(filename)" : filename
        if thumbnail, let cached = dataCache.object(forKey: key as NSString) { return cached as Data }
        if let pending = dataInFlight[key] { return await pending.value }

        let task = Task<Data?, Never> {
            try? await APIService.shared.fetchPhotoData(filename: filename, thumbnail: thumbnail)
        }
        dataInFlight[key] = task
        let data = await task.value
        dataInFlight[key] = nil

        if let data {
            dataCache.setObject(data as NSData, forKey: key as NSString, cost: data.count)
        }
        return data
    }

    private func cacheKey(_ filename: String, _ maxPixelSize: CGFloat, thumbnail: Bool) -> NSString {
        "\(thumbnail ? "thumb/" : "")\(filename)@\(Int(maxPixelSize))" as NSString
    }

    /// Decodes straight to the target size and applies EXIF orientation.
    nonisolated private static func downsample(_ data: Data, maxPixelSize: CGFloat) -> UIImage? {
        let sourceOptions = [kCGImageSourceShouldCache: false] as CFDictionary
        guard let source = CGImageSourceCreateWithData(data as CFData, sourceOptions) else { return nil }
        let options = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixelSize
        ] as CFDictionary
        guard let cgImage = CGImageSourceCreateThumbnailAtIndex(source, 0, options) else { return nil }
        return UIImage(cgImage: cgImage)
    }
}

// MARK: - Photo View

/// Fills its frame with a server photo using cover cropping, fading in once loaded.
struct JourneyPhotoView: View {
    let filename: String
    let maxPixelSize: CGFloat
    /// Loads the server's reduced copy (about 720px wide) rather than the original.
    let thumbnail: Bool
    let contentMode: ContentMode
    let onFailure: (() -> Void)?

    @State private var image: UIImage?
    /// False while `image` is a different-size copy standing in until the requested size loads.
    @State private var isRequestedSize: Bool

    init(
        filename: String,
        maxPixelSize: CGFloat = JourneyPhotoCache.heroPixelSize,
        thumbnail: Bool = false,
        contentMode: ContentMode = .fill,
        onFailure: (() -> Void)? = nil
    ) {
        self.filename = filename
        self.maxPixelSize = maxPixelSize
        self.thumbnail = thumbnail
        self.contentMode = contentMode
        self.onFailure = onFailure
        let cache = JourneyPhotoCache.shared
        let exact = cache.cachedImage(for: filename, maxPixelSize: maxPixelSize, thumbnail: thumbnail)
        // Show any copy already in memory so the photo is there from the first frame,
        // e.g. while zooming into a story from its list card
        _image = State(initialValue: exact ?? cache.largestCachedImage(for: filename))
        _isRequestedSize = State(initialValue: exact != nil)
    }

    var body: some View {
        Color.clear
            .overlay {
                if let image {
                    Image(uiImage: image)
                        .resizable()
                        .aspectRatio(contentMode: contentMode)
                        .transition(.opacity)
                }
            }
            .clipped()
            .task(id: filename) {
                guard !isRequestedSize else { return }
                let loaded = await JourneyPhotoCache.shared.image(
                    for: filename,
                    maxPixelSize: maxPixelSize,
                    thumbnail: thumbnail
                )
                guard !Task.isCancelled else { return }
                if let loaded {
                    if image == nil {
                        withAnimation(.easeOut(duration: 0.45)) { image = loaded }
                    } else {
                        image = loaded
                    }
                    isRequestedSize = true
                } else if image == nil {
                    onFailure?()
                }
            }
    }
}
