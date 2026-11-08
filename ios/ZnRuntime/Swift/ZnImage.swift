// <Image> and <Shimmer> on iOS, as android/runtime's ZnRenderer.kt IMAGE branch and ZnShimmer.kt.
//
// Image: src "asset:<path>" (a file in the bundle folder, as Android's assets), http(s) URLs, or a file URL. Per src,
// one way only: src → fallbackSrc (if any) → an empty box; never back to src (on Android the two once swapped
// forever). contentScale cover (default) / contain / fill; tintColor draws the picture's shape in one colour; RN
// onLoad { source: { width, height, uri } } (pixels), onError { error }, and onLoadEnd after either, for src only.
// loading="shimmer" shimmers the box until the picture is in. Not on iOS yet: `zn://` handles (ZnHandles.kt).
//
// Shimmer: a base colour with a lighter band sweeping across, every Shimmer on screen in step (one shared clock,
// the time since boot modulo the period), as on Android.
import SwiftUI
import UIKit

/// Pictures by URL: decoded once, kept in memory while there is room.
@MainActor
final class ZnImageCache {
    static let shared = ZnImageCache()
    private let cache = NSCache<NSURL, UIImage>()

    func cached(_ url: URL) -> UIImage? { cache.object(forKey: url as NSURL) }

    func load(_ url: URL) async throws -> UIImage {
        if let hit = cached(url) { return hit }
        let data: Data
        if url.isFileURL {
            data = try await Task.detached { try Data(contentsOf: url) }.value
        } else {
            let (d, response) = try await URLSession.shared.data(from: url)
            if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
                throw ZnImageError("HTTP \(http.statusCode)")
            }
            data = d
        }
        guard let image = UIImage(data: data) else { throw ZnImageError("not a picture") }
        cache.setObject(image, forKey: url as NSURL)
        return image
    }
}

struct ZnImageError: LocalizedError {
    let message: String
    init(_ m: String) { message = m }
    var errorDescription: String? { message }
}

/// The URL for an image src, or nil when iOS can't load that kind yet.
@MainActor
func znImageURL(_ src: String) -> URL? {
    for prefix in ["asset://", "asset:"] where src.hasPrefix(prefix) {
        return ZnApp.shared.bundleURL?.appendingPathComponent(String(src.dropFirst(prefix.count)))
    }
    guard let url = URL(string: src), let scheme = url.scheme else { return nil }
    return ["http", "https", "file"].contains(scheme) ? url : nil
}

struct ZnImageView: View {
    let ctx: ZnContext
    let s: ZnNodeSpec
    let inst: ZnInstance

    private enum Stage: Equatable { case src, fallback, none }
    private struct Loaded: Equatable { let src: String?; let stage: Stage; let image: UIImage? }

    @State private var loaded = Loaded(src: nil, stage: .none, image: nil)

    var body: some View {
        let _ = ZnDebug.hit(name: "ImageLeaf", inst: inst, node: s.index)
        let src = s.srcSlot >= 0 ? inst.slot(s.srcSlot).value.string : s.src
        let tint = s.tintColorSlot >= 0 ? znColor(inst.slot(s.tintColorSlot).value) : s.tintColor
        // A new src starts again (a reused row); what is shown belongs to this src only.
        let image = loaded.src == src ? loaded.image : nil
        let waiting = image == nil && (loaded.src != src || loaded.stage != .none)
        ZStack {
            if let image {
                picture(image, tint: tint)
            } else if waiting && s.loading == Registry.Loading.shimmer {
                ZnShimmerView(s: s)
            } else {
                Color.clear
            }
        }
        .clipped()
        .task(id: src) { await load(src) }
    }

    @ViewBuilder
    private func picture(_ image: UIImage, tint: Color?) -> some View {
        let base = Image(uiImage: image).renderingMode(tint == nil ? .original : .template).resizable()
        let tinted = base.foregroundStyle(tint ?? .clear)
        switch s.contentScale {
        case Registry.ContentScale.contain: tinted.scaledToFit()
        case Registry.ContentScale.fill: tinted
        default: tinted.scaledToFill()  // cover
        }
    }

    private func load(_ src: String?) async {
        let fallback = s.fallbackSrc
        var stage: Stage = src != nil ? .src : fallback != nil ? .fallback : .none
        while stage != .none {
            let which = stage == .src ? src! : fallback!
            loaded = Loaded(src: src, stage: stage, image: nil)
            do {
                guard let url = znImageURL(which) else { throw ZnImageError("this kind of src is not supported on iOS yet: \(which)") }
                let image = try await ZnImageCache.shared.load(url)
                if Task.isCancelled { return }
                loaded = Loaded(src: src, stage: stage, image: image)
                if stage == .src { sendLoad(image, src: which) }
                return
            } catch {
                if Task.isCancelled { return }
                print("zn t=\(ZnDebug.ms()) image failed: \(stage == .src ? which : "fallback \(which)") — \(error.localizedDescription)")
                if stage == .src { sendError(error.localizedDescription.isEmpty ? "\(error)" : error.localizedDescription) }
                stage = stage == .src && fallback != nil ? .fallback : .none
            }
        }
        loaded = Loaded(src: src, stage: .none, image: nil)
    }

    // Events wait until JS has drawn: a picture in the first screen's skeleton can load before that (ZnApp.afterJSDrew).
    private func sendLoad(_ image: UIImage, src: String) {
        let w = image.cgImage?.width ?? Int(image.size.width * image.scale)
        let h = image.cgImage?.height ?? Int(image.size.height * image.scale)
        let (ctx, s, id) = (ctx, s, inst.id)
        ZnApp.shared.afterJSDrew {
            if s.onLoad != 0, let json = ZnModules.json(["source": ["width": w, "height": h, "uri": src]]) {
                ctx.send(id, s.onLoad, .string(json))
            }
            if s.onLoadEnd != 0 { ctx.send(id, s.onLoadEnd, .none) }
        }
    }

    private func sendError(_ message: String) {
        let (ctx, s, id) = (ctx, s, inst.id)
        ZnApp.shared.afterJSDrew {
            if s.onError != 0, let json = ZnModules.json(["error": message]) { ctx.send(id, s.onError, .string(json)) }
            if s.onLoadEnd != 0 { ctx.send(id, s.onLoadEnd, .none) }
        }
    }
}

/// <Shimmer>, and an Image's loading="shimmer": the base colour with a band of the highlight colour sweeping across
/// (a diagonal gradient 1.5 × the width, from off the left edge to off the right), on a clock shared by every shimmer.
struct ZnShimmerView: View {
    let s: ZnNodeSpec

    var body: some View {
        let base = s.baseColor ?? Color(.sRGB, red: 0xE5 / 255, green: 0xE7 / 255, blue: 0xEB / 255)
        let period = max(s.period ?? 1200, 100) / 1000
        TimelineView(.animation) { timeline in
            Canvas { g, size in
                let now = timeline.date.timeIntervalSinceReferenceDate
                let progress = now.truncatingRemainder(dividingBy: period) / period
                let rect = CGRect(origin: .zero, size: size)
                g.fill(Path(rect), with: .color(base))
                let sweep = size.width * 1.5
                let startX = -sweep + progress * (size.width + sweep)
                g.fill(Path(rect), with: .linearGradient(
                    Gradient(colors: [base, s.shimmerHighlight, base]),
                    startPoint: CGPoint(x: startX, y: 0), endPoint: CGPoint(x: startX + sweep, y: size.height)))
            }
        }
    }
}
