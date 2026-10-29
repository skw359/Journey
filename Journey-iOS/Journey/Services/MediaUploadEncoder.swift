import SwiftUI
import PhotosUI
import ImageIO
import AVFoundation
import UniformTypeIdentifiers

/// One photo or video ready to send to `/api/routes/:id/photos`.
nonisolated struct MediaUploadFile: Sendable {
    enum Contents: Sendable {
        case data(Data)
        /// A temporary copy of a video, too large to hold in memory.
        case file(URL)
    }

    let contents: Contents
    let filename: String
    let mimeType: String
}

/// Turns photos and videos picked from the library into files the server accepts. Like the
/// web uploader, JPEG, HEIC and videos go up untouched: the server converts HEIC to JPEG and
/// video to MP4 itself. Other image formats, such as PNG screenshots, are re-encoded as JPEG,
/// which the server would otherwise reject.
enum MediaUploadEncoder {
    struct Prepared {
        let file: MediaUploadFile
        let isVideo: Bool
        /// Small copy to show while the item uploads and converts.
        let preview: UIImage?

        /// A photo's bytes, so it can be shown after upload without downloading it back.
        var photoData: Data? {
            if case .data(let data) = file.contents { return data }
            return nil
        }

        /// Removes a video's temporary copy once it's been sent.
        func discard() {
            if case .file(let url) = file.contents {
                try? FileManager.default.removeItem(at: url)
            }
        }
    }

    enum EncodingError: LocalizedError {
        case unreadable
        case unsupportedVideo(String)

        var errorDescription: String? {
            switch self {
            case .unreadable: "The photo or video couldn't be read."
            case .unsupportedVideo(let ext): "Videos in .\(ext) format can't be uploaded."
            }
        }
    }

    /// The video formats the server takes (`ALLOWED_VIDEO_EXT` in its storage middleware).
    nonisolated static let videoExtensions: Set<String> = ["mov", "mp4", "m4v", "webm", "mkv", "avi"]

    static func isVideo(_ item: PhotosPickerItem) -> Bool {
        item.supportedContentTypes.contains { $0.conforms(to: .movie) }
    }

    static func prepare(_ item: PhotosPickerItem) async throws -> Prepared {
        try await isVideo(item) ? prepareVideo(item) : preparePhoto(item)
    }

    private static func preparePhoto(_ item: PhotosPickerItem) async throws -> Prepared {
        // The original file, possibly downloaded from iCloud first
        guard let data = try await item.loadTransferable(type: Data.self) else {
            throw EncodingError.unreadable
        }
        let baseName = "IMG_\(UUID().uuidString.prefix(8))"
        let encoded = await Task.detached(priority: .userInitiated) {
            encode(data, baseName: baseName)
        }.value
        guard let encoded else { throw EncodingError.unreadable }
        return Prepared(file: encoded.file, isVideo: false, preview: encoded.preview)
    }

    private static func prepareVideo(_ item: PhotosPickerItem) async throws -> Prepared {
        // A copy of the original file, possibly downloaded from iCloud first
        guard let movie = try await item.loadTransferable(type: PickedMovie.self) else {
            throw EncodingError.unreadable
        }
        let ext = movie.url.pathExtension.lowercased()
        guard videoExtensions.contains(ext) else {
            try? FileManager.default.removeItem(at: movie.url)
            throw EncodingError.unsupportedVideo(ext)
        }
        let file = MediaUploadFile(
            contents: .file(movie.url),
            filename: "VID_\(UUID().uuidString.prefix(8)).\(ext)",
            // The server goes by the extension when the type is generic
            mimeType: UTType(filenameExtension: ext)?.preferredMIMEType ?? "application/octet-stream"
        )
        return Prepared(file: file, isVideo: true, preview: await videoPreview(movie.url))
    }

    nonisolated private static func encode(_ data: Data, baseName: String) -> (file: MediaUploadFile, preview: UIImage?)? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let typeID = CGImageSourceGetType(source),
              let type = UTType(typeID as String) else { return nil }

        let file: MediaUploadFile
        if type.conforms(to: .jpeg) {
            file = MediaUploadFile(contents: .data(data), filename: "\(baseName).jpg", mimeType: "image/jpeg")
        } else if type.conforms(to: .heic) {
            file = MediaUploadFile(contents: .data(data), filename: "\(baseName).heic", mimeType: "image/heic")
        } else if type.conforms(to: .heif) {
            file = MediaUploadFile(contents: .data(data), filename: "\(baseName).heif", mimeType: "image/heif")
        } else {
            guard let jpeg = jpegData(from: source) else { return nil }
            file = MediaUploadFile(contents: .data(jpeg), filename: "\(baseName).jpg", mimeType: "image/jpeg")
        }
        return (file, preview(from: source))
    }

    /// Keeps the metadata, including orientation, at the quality the server uses for HEIC.
    nonisolated private static func jpegData(from source: CGImageSource) -> Data? {
        let output = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(output, UTType.jpeg.identifier as CFString, 1, nil) else {
            return nil
        }
        let options = [kCGImageDestinationLossyCompressionQuality: 0.9] as CFDictionary
        CGImageDestinationAddImageFromSource(destination, source, 0, options)
        guard CGImageDestinationFinalize(destination) else { return nil }
        return output as Data
    }

    nonisolated private static func preview(from source: CGImageSource) -> UIImage? {
        let options = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: 480
        ] as CFDictionary
        guard let cgImage = CGImageSourceCreateThumbnailAtIndex(source, 0, options) else { return nil }
        return UIImage(cgImage: cgImage)
    }

    /// The video's first frame, upright, until the server makes a poster.
    private static func videoPreview(_ url: URL) async -> UIImage? {
        let generator = AVAssetImageGenerator(asset: AVURLAsset(url: url))
        generator.appliesPreferredTrackTransform = true
        generator.maximumSize = CGSize(width: 480, height: 480)
        guard let frame = try? await generator.image(at: .zero) else { return nil }
        return UIImage(cgImage: frame.image)
    }
}

/// A picked video. The picker's file only lasts as long as the import, so it's copied to a
/// temporary file of our own.
nonisolated private struct PickedMovie: Transferable {
    let url: URL

    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(importedContentType: .movie) { received in
            let copy = FileManager.default.temporaryDirectory
                .appendingPathComponent("picked-\(UUID().uuidString)")
                .appendingPathExtension(received.file.pathExtension)
            try FileManager.default.copyItem(at: received.file, to: copy)
            return PickedMovie(url: copy)
        }
    }
}
