// <Image> and <Shimmer> on iOS, as android/runtime's ZnRenderer.kt IMAGE branch and ZnShimmer.kt.
//
// Image: src "asset:<path>" (a file in the bundle folder, as Android's assets), http(s) URLs, or a file URL. Per src,
// one way only: src → fallbackSrc (if any) → an empty box; never back to src (on Android the two once swapped
// forever). contentScale cover (default) / contain / fill; tintColor draws the picture's shape in one colour; RN
// onLoad { source: { width, height, uri } } (pixels), onError { error }, and onLoadEnd after either, for src only.
// loading="shimmer" shimmers the box until the picture is in. A picture that wasn't in memory fades in over 150 ms
// (Coil's crossfade on Android); one in memory shows at once, in the same frame as a src change. `zn://file/<name>` handles (a file a plugin made, as a
// scanned page) load from ZnHandles.fileDir; other `zn://` kinds (Android's app icons) are not on iOS.
//
// Shimmer: a base colour with a lighter band sweeping across, every Shimmer on screen in step (one shared clock,
// the time since boot modulo the period), as on Android.
import CryptoKit
import SwiftUI
import UIKit

/// Pictures by URL: decoded once, kept in memory while there is room. A remote picture's bytes are also kept on disk
/// (ZnImageDisk), as Android's image loader keeps them (Coil's disk cache), so a picture seen before, or loaded ahead
/// for a List row (ZnImagePreload.swift), comes from the file. Two askers for one URL share one download: an on-screen
/// picture joins the preload of its row (Android downloads it twice then).
@MainActor
final class ZnImageCache {
    static let shared = ZnImageCache()
    private let cache = NSCache<NSURL, UIImage>()
    let disk = ZnImageDisk()
    /// Remote pictures being fetched, and who waits for each: a stopped asker's download stops only when none waits.
    private var inflight: [URL: (task: Task<Data, Error>, waiters: Set<Int>)] = [:]
    private var lastWaiter = 0
    /// Downloads that started (not from disk, not joined), for the logs and the lab.
    private(set) var downloads = 0
    private(set) var joins = 0

    func cached(_ url: URL) -> UIImage? { cache.object(forKey: url as NSURL) }

    func load(_ url: URL) async throws -> UIImage {
        if let hit = cached(url) { return hit }
        let data: Data
        if url.isFileURL {
            data = try await Task.detached { try Data(contentsOf: url) }.value
        } else {
            data = try await remote(url)
        }
        guard let image = UIImage(data: data) else { throw ZnImageError("not a picture") }
        cache.setObject(image, forKey: url as NSURL)
        return image
    }

    /// A remote picture's bytes: from the disk, from a download already running, or downloaded now (then kept on disk).
    /// [preload]: a preload asks (it only wants the file; nothing is decoded).
    func remote(_ url: URL, preload: Bool = false) async throws -> Data {
        let task: Task<Data, Error>
        lastWaiter += 1
        let me = lastWaiter
        if let running = inflight[url] {
            task = running.task
            inflight[url]?.waiters.insert(me)
            if !preload {
                joins += 1
                print("zn t=\(ZnDebug.ms()) image: joins the download already running (\(joins) so far): \(url.absoluteString)")
            }
        } else {
            let disk = disk
            task = Task<Data, Error> { [weak self] in
                // The file is read off the main thread, and the picture doesn't wait for its bytes to be written.
                if let d = await Task.detached(priority: .userInitiated, operation: { disk.read(url) }).value { return d }
                self?.downloads += 1
                let (d, response) = try await URLSession.shared.data(from: url)
                if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
                    throw ZnImageError("HTTP \(http.statusCode)")
                }
                disk.write(d, for: url)
                return d
            }
            inflight[url] = (task, [me])
        }
        // The asker left (its view went, the preload was stopped): the download stops when no one else waits for it.
        return try await withTaskCancellationHandler {
            defer { leave(url, task, me, stop: false) }
            return try await task.value
        } onCancel: {
            Task { @MainActor in self.leave(url, task, me, stop: true) }
        }
    }

    /// [me] no longer waits for [url]'s download; [stop]: it was stopped, so the download stops too if it was the last.
    private func leave(_ url: URL, _ task: Task<Data, Error>, _ me: Int, stop: Bool) {
        guard var e = inflight[url], e.task == task, e.waiters.remove(me) != nil else { return }
        if e.waiters.isEmpty {
            inflight[url] = nil
            if stop { task.cancel() }
        } else {
            inflight[url] = e
        }
    }
}

/// Remote pictures' bytes on disk (Caches/zn-images, one file per URL, named by its SHA-256): up to 200 MB, the
/// least recently used go first. Caches/, so iOS may clear it when the phone is short of space. Kept whatever the
/// response's cache headers say, as Android's image loader does by default (Coil 3 ignores them).
/// Reads run on the caller's thread, side by side (call them off the main thread). Writes and the trim go one at a
/// time on a low-priority queue; a picture waiting there is read from memory until its file is written.
final class ZnImageDisk: @unchecked Sendable {
    static let maxBytes = 200 * 1024 * 1024
    private let dir: URL?
    private let queue = DispatchQueue(label: "zn.image-disk", qos: .utility)
    private let lock = NSLock()
    /// Bytes waiting for their file (under lock), and the writes since launch (on the queue).
    private var unwritten: [URL: Data] = [:]
    private var writes = 0

    init() {
        let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first
        dir = caches?.appendingPathComponent("zn-images", isDirectory: true)
        if let dir { try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true) }
    }

    private func file(_ url: URL) -> URL? {
        let hash = SHA256.hash(data: Data(url.absoluteString.utf8)).map { String(format: "%02x", $0) }.joined()
        return dir?.appendingPathComponent(hash)
    }

    func read(_ url: URL) -> Data? {
        if let d = lock.withLock({ unwritten[url] }) { return d }
        guard let f = file(url), let d = try? Data(contentsOf: f) else { return nil }
        // Used now: the trim keeps it longer.
        try? FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: f.path)
        return d
    }

    /// Keeps [data] for [url]: in memory at once, in its file soon. Returns at once.
    func write(_ data: Data, for url: URL) {
        guard let f = file(url) else { return }
        lock.withLock { unwritten[url] = data }
        queue.async { [self] in
            try? data.write(to: f, options: .atomic)
            lock.withLock { unwritten[url] = nil }
            writes += 1
            if writes % 32 == 1 { trim() }
        }
    }

    /// Over the limit: the oldest files go until it is at three quarters of it (on the queue).
    private func trim() {
        guard let dir, let files = try? FileManager.default.contentsOfDirectory(
            at: dir, includingPropertiesForKeys: [.fileSizeKey, .contentModificationDateKey]) else { return }
        var all = files.compactMap { f -> (URL, Int, Date)? in
            guard let v = try? f.resourceValues(forKeys: [.fileSizeKey, .contentModificationDateKey]) else { return nil }
            return (f, v.fileSize ?? 0, v.contentModificationDate ?? .distantPast)
        }
        var total = all.reduce(0) { $0 + $1.1 }
        guard total > Self.maxBytes else { return }
        all.sort { $0.2 < $1.2 }
        for (f, size, _) in all where total > Self.maxBytes * 3 / 4 {
            try? FileManager.default.removeItem(at: f)
            total -= size
        }
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
        return ZnApp.shared.bundleURL == nil ? nil : ZnBundles.assetURL(String(src.dropFirst(prefix.count)))
    }
    if src.hasPrefix("zn://") { return ZnHandles.fileOf(src) }
    guard let url = URL(string: src), let scheme = url.scheme else { return nil }
    return ["http", "https", "file"].contains(scheme) ? url : nil
}

struct ZnImageView: View {
    let ctx: ZnContext
    let s: ZnNodeSpec
    let inst: ZnInstance

    private enum Stage: Equatable { case src, fallback, none }
    /// [fade]: the picture wasn't in memory, so it fades in (Android: Coil's 150 ms crossfade, never for a memory hit).
    private struct Loaded: Equatable { let src: String?; let stage: Stage; let image: UIImage?; var fade = false }

    @State private var loaded = Loaded(src: nil, stage: .none, image: nil)

    var body: some View {
        let _ = ZnDebug.hit(name: "ImageLeaf", inst: inst, node: s.index)
        let src = s.srcSlot >= 0 ? inst.slot(s.srcSlot).value.string : s.src
        let tint = s.tintColorSlot >= 0 ? znColor(inst.slot(s.tintColorSlot).value) : s.tintColor
        // A new src starts again (a reused row); what is shown belongs to this src only. A src already in memory shows
        // in this same frame, as Coil draws a memory hit at once (the load below still sends its onLoad): before, a
        // changed src showed an empty box until the load ran.
        let image = loaded.src == src ? loaded.image : src.flatMap(Self.inMemory)
        let fade = loaded.src == src && loaded.fade
        let waiting = image == nil && (loaded.src != src || loaded.stage != .none)
        ZnPictureBox {
            if let image {
                picture(image, tint: tint).modifier(ZnImageFadeIn(on: fade))
            } else if waiting && s.loading == Registry.Loading.shimmer {
                ZnShimmerView(s: s)
            } else {
                Color.clear
            }
        }
        .clipped()
        .task(id: src) { await load(src) }
    }

    /// [src]'s picture if it is in memory now (the src only, not its fallback).
    @MainActor private static func inMemory(_ src: String) -> UIImage? {
        znImageURL(src).flatMap { ZnImageCache.shared.cached($0) }
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
            // In memory: shown at once with no fade (body may show it already), never an empty box in between.
            if let url = znImageURL(which), let hit = ZnImageCache.shared.cached(url) {
                if !url.isFileURL { ZnImagePreload.shared.onScreen(which) }
                loaded = Loaded(src: src, stage: stage, image: hit)
                if stage == .src { sendLoad(hit, src: which) }
                return
            }
            loaded = Loaded(src: src, stage: stage, image: nil)
            do {
                guard let url = znImageURL(which) else { throw ZnImageError("this kind of src is not supported on iOS yet: \(which)") }
                // On screen now: no preload for it from here on (a running one is joined).
                if !url.isFileURL { ZnImagePreload.shared.onScreen(which) }
                let image = try await ZnImageCache.shared.load(url)
                if Task.isCancelled { return }
                loaded = Loaded(src: src, stage: stage, image: image, fade: true)
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

/// A picture that wasn't in memory (from the disk, the network or a file) fades in over 150 ms, linear, as Coil's
/// crossfade on Android (ZnFetch.kt IMAGE_FADE_MS); one from memory shows at once. With animations off (Reduce Motion)
/// it shows at once too. A new picture in the box starts its own fade: the box shows nothing or the shimmer between two
/// pictures that aren't in memory, so this view is made again. A picture already shown (from memory) never fades
/// again in the same view, and a fade that turns on while the view is on screen starts there (not only on appear), so
/// a picture is never left at opacity 0 (a memory hit evicted before its load ran).
struct ZnImageFadeIn: ViewModifier {
    let on: Bool
    @State private var shown = false

    func body(content: Content) -> some View {
        content
            .opacity(on && !shown ? 0 : 1)
            .onAppear { start() }
            .onChange(of: on) { _, _ in start() }
    }

    private func start() {
        guard !shown else { return }
        if !on || znAnimationsOff() { shown = true } else { withAnimation(.linear(duration: 0.15)) { shown = true } }
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

/// An Image's box: the size it is offered (its width / height), with the picture centred in it, as Android's Image
/// (Alignment.Center). A ZStack took the picture's own size, so the node's frame put a `contain` picture at the top left
/// of its box and cropped a `cover` one from the top left. Offered no size on an axis, the box takes the picture's.
struct ZnPictureBox: Layout {
    private static func finite(_ v: CGFloat?) -> CGFloat? { v.flatMap { $0.isFinite ? $0 : nil } }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let fit = subviews.first?.sizeThatFits(proposal) ?? .zero
        return CGSize(width: Self.finite(proposal.width) ?? fit.width, height: Self.finite(proposal.height) ?? fit.height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        subviews.first?.place(at: CGPoint(x: bounds.midX, y: bounds.midY), anchor: .center,
                              proposal: ProposedViewSize(width: bounds.width, height: bounds.height))
    }
}
