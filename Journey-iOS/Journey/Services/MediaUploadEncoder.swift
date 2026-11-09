// Prepares picked photos and videos for upload.

import SwiftUI
import PhotosUI
import ImageIO
import AVFoundation
import UniformTypeIdentifiers

nonisolated struct MediaUploadFile: Sendable {
    let data: Data
    let filename: String
    let mimeType: String
}

enum MediaUploadEncoder {
    struct Prepared {
        enum Contents {
            case photo(MediaUploadFile)
            case video(PickedVideo)
        }

        let contents: Contents
        let preview: UIImage?
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

    nonisolated static let videoExtensions: Set<String> = ["mov", "mp4", "m4v", "webm", "mkv", "avi"]

    static func isVideo(_ item: PhotosPickerItem) -> Bool {
        item.supportedContentTypes.contains { $0.conforms(to: .movie) }
    }

    static func prepare(_ item: PhotosPickerItem) async throws -> Prepared {
        try await isVideo(item) ? prepareVideo(item) : preparePhoto(item)
    }

    private static func preparePhoto(_ item: PhotosPickerItem) async throws -> Prepared {
        guard let data = try await item.loadTransferable(type: Data.self) else {
            throw EncodingError.unreadable
        }
        let baseName = "IMG_\(UUID().uuidString.prefix(8))"
        let encoded = await Task.detached(priority: .userInitiated) {
            encode(data, baseName: baseName)
        }.value
        guard let encoded else { throw EncodingError.unreadable }
        return Prepared(contents: .photo(encoded.file), preview: encoded.preview)
    }

    private static func prepareVideo(_ item: PhotosPickerItem) async throws -> Prepared {
        let picked: PickedMovie?
        do {
            picked = try await item.loadTransferable(type: PickedMovie.self)
        } catch where ChunkedUploadError.isOutOfSpace(error) {
            throw ChunkedUploadError.insufficientStorage
        }
        guard let movie = picked else {
            throw EncodingError.unreadable
        }
        let ext = movie.url.pathExtension.lowercased()
        guard videoExtensions.contains(ext) else {
            try? FileManager.default.removeItem(at: movie.url)
            throw EncodingError.unsupportedVideo(ext)
        }
        let video = PickedVideo(
            url: movie.url,
            filename: "VID_\(UUID().uuidString.prefix(8)).\(ext)",
            mimeType: UTType(filenameExtension: ext)?.preferredMIMEType ?? "application/octet-stream"
        )
        return Prepared(contents: .video(video), preview: await videoPreview(movie.url))
    }

    nonisolated private static func encode(_ data: Data, baseName: String) -> (file: MediaUploadFile, preview: UIImage?)? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let typeID = CGImageSourceGetType(source),
              let type = UTType(typeID as String) else { return nil }

        let file: MediaUploadFile
        if type.conforms(to: .jpeg) {
            file = MediaUploadFile(data: data, filename: "\(baseName).jpg", mimeType: "image/jpeg")
        } else if type.conforms(to: .heic) {
            file = MediaUploadFile(data: data, filename: "\(baseName).heic", mimeType: "image/heic")
        } else if type.conforms(to: .heif) {
            file = MediaUploadFile(data: data, filename: "\(baseName).heif", mimeType: "image/heif")
        } else {
            guard let jpeg = jpegData(from: source) else { return nil }
            file = MediaUploadFile(data: jpeg, filename: "\(baseName).jpg", mimeType: "image/jpeg")
        }
        return (file, preview(from: source))
    }

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

    static func videoPreview(_ url: URL) async -> UIImage? {
        let generator = AVAssetImageGenerator(asset: AVURLAsset(url: url))
        generator.appliesPreferredTrackTransform = true
        generator.maximumSize = CGSize(width: 480, height: 480)
        guard let frame = try? await generator.image(at: .zero) else { return nil }
        return UIImage(cgImage: frame.image)
    }
}

nonisolated private struct PickedMovie: Transferable {
    let url: URL

    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(importedContentType: .movie) { received in
            let copy = VideoUploadStorage.directory
                .appendingPathComponent("picked-\(UUID().uuidString)")
                .appendingPathExtension(received.file.pathExtension)
            try FileManager.default.copyItem(at: received.file, to: copy)
            return PickedMovie(url: copy)
        }
    }
}
