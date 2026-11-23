// Loads the pictures of <List> rows just past the screen before they are drawn, as android/runtime's ZnImagePreload.kt
// (image plan A).
//
// Why: an <Image> asks for its picture when it is drawn, and a list draws only the rows on screen, so each row's
// picture started loading as the row came in. The rows near the screen already have their instance (JS mounts a
// window of rows), so their `src` is known: for the next ROWS_AHEAD rows in the scroll direction, each http(s) `src`
// is downloaded into the disk cache (ZnImageCache / ZnImageDisk). When the row comes on screen its <Image> reads the
// file (a decode, no network), or joins the download still running (Android downloads it twice then).
// - Bytes on disk only, nothing decoded: the drawn size is known only to layout, and the download is the slow part.
// - 3 at once in all (ZnPreloadBook), at most 24 waiting or running; more are skipped (the next scroll asks again).
// - A list's waiting preloads stop when their row's instance is gone (scrolled far away) or the list leaves.
// - Off in Low Data Mode (iOS's Data Saver) and for a minute after a memory warning.
// Main actor only.
import Foundation
import Network
import UIKit

@MainActor
final class ZnImagePreload {
    static let shared = ZnImagePreload()
    /// Rows loaded ahead of the screen, in the scroll direction.
    static let rowsAhead = 8
    private static let lowMemoryPause: CFTimeInterval = 60

    private var book = ZnPreloadBook()
    private var tasks: [String: Task<Void, Never>] = [:]
    /// A waiting or running URL → the row instance it is for (gone: it is dropped).
    private var instanceOf: [String: UInt32] = [:]
    private var pausedUntil: CFTimeInterval = 0
    private var lowData = false
    private var monitor: NWPathMonitor?
    private var watching = false
    /// On-screen pictures asked for while their preload was waiting or running (they joined it, or it was dropped).
    private(set) var early = 0

    /// The rows [instances] (the next rows past the screen, nearest first) of the list [owner]: preload their pictures.
    /// Drops this list's preloads whose row instance is gone.
    func want(owner: Int, instances: [ZnInstance], ctx: ZnContext) {
        watch()
        dropGone(owner: owner, store: ctx.store)
        guard !instances.isEmpty, CACurrentMediaTime() >= pausedUntil, !lowData else { return }
        var started = 0
        for inst in instances {
            if book.pending >= book.maxPending { break }
            for url in Self.collect(inst, ctx) where book.want(url, owner: owner) {
                instanceOf[url] = inst.id
                started += 1
            }
        }
        if started > 0 { print("zn t=\(ZnDebug.ms()) image preload: \(started) asked for list \(owner) (\(book.pending) waiting or running)") }
        pump()
    }

    /// The list [owner] left the screen: its preloads stop.
    func cancel(owner: Int) {
        for url in book.drop(owner: owner) { tasks[url]?.cancel() }
        forgetDropped()
    }

    /// An on-screen <Image> asks for [url]: no preload for it from now on (a running one is joined by ZnImageCache).
    func onScreen(_ url: String) {
        guard znIsRemoteSrc(url) else { return }
        if book.onScreen(url) {
            early += 1
            print("zn t=\(ZnDebug.ms()) image preload: on screen before its preload ended (\(early) so far): \(url)")
        }
        forgetDropped()
    }

    /// The http(s) `src` of the <Image> nodes in [root]'s tree, at most 4 (ZnPreloadBook.maxPerRow), from its slot (or
    /// the template's). Not inside a nested <List> (its rows aren't the row's children).
    static func collect(_ root: ZnInstance, _ ctx: ZnContext) -> [String] {
        var out: [String] = []
        var queue = [root]
        var seen = 0
        while !queue.isEmpty, out.count < ZnPreloadBook.maxPerRow, seen < ZnPreloadBook.maxInstancesPerRow {
            let inst = queue.removeFirst()
            seen += 1
            guard let t = ctx.templates[safe: inst.templateId] else { continue }
            for n in t.nodes where n.type == Registry.Component.image {
                let src = n.srcSlot >= 0 ? (inst.hasSlot(n.srcSlot) ? inst.slot(n.srcSlot).value.string : nil) : n.src
                if let src, znIsRemoteSrc(src), !out.contains(src) {
                    out.append(src)
                    if out.count >= ZnPreloadBook.maxPerRow { return out }
                }
            }
            for id in inst.allChildren { if let c = ctx.store.find(id) { queue.append(c) } }
        }
        return out
    }

    private func pump() {
        for url in book.next() {
            guard let u = URL(string: url) else {
                book.finished(url, ok: false)
                continue
            }
            tasks[url] = Task { [weak self] in
                var ok = true
                do { _ = try await ZnImageCache.shared.remote(u, preload: true) } catch {
                    ok = false
                    if !(error is CancellationError) { print("zn t=\(ZnDebug.ms()) image preload failed: \(url) (\(error.localizedDescription))") }
                }
                self?.ended(url, ok: ok)
            }
        }
    }

    private func ended(_ url: String, ok: Bool) {
        tasks[url] = nil
        book.finished(url, ok: ok)
        forgetDropped()
        pump()
    }

    private func dropGone(owner: Int, store: ZnStore) {
        let gone = { [instanceOf] (url: String) in instanceOf[url].map { store.find($0) == nil } ?? true }
        for url in book.drop(owner: owner, keep: { !gone($0) }) { tasks[url]?.cancel() }
        forgetDropped()
    }

    private func forgetDropped() {
        for url in instanceOf.keys where !book.isWaitingOrRunning(url) { instanceOf[url] = nil }
    }

    /// Low memory: everything stops and the preload pauses for a minute (on-screen pictures still load). Low Data
    /// Mode: no preloads while it is on.
    private func watch() {
        guard !watching else { return }
        watching = true
        NotificationCenter.default.addObserver(forName: UIApplication.didReceiveMemoryWarningNotification, object: nil,
                                               queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.pause() }
        }
        let m = NWPathMonitor()
        m.pathUpdateHandler = { [weak self] path in
            let constrained = path.isConstrained
            DispatchQueue.main.async {
                guard let self, self.lowData != constrained else { return }
                self.lowData = constrained
                print("zn t=\(ZnDebug.ms()) image preload: Low Data Mode \(constrained ? "on, no preloads" : "off")")
            }
        }
        m.start(queue: DispatchQueue(label: "zn.image-preload.path"))
        monitor = m
    }

    private func pause() {
        pausedUntil = CACurrentMediaTime() + Self.lowMemoryPause
        let stopped = book.dropAll()
        for url in stopped { tasks[url]?.cancel() }
        forgetDropped()
        print("zn t=\(ZnDebug.ms()) image preload: memory warning, \(stopped.count) stopped, paused for a minute")
    }
}

extension ZnCollectionList.Coordinator {
    /// Asks for the pictures of the rows just past the screen (Android's ZnPreloadAhead): after a scroll, an update,
    /// or a row getting its instance near the screen. Cheap when the rows ahead and their instances didn't change.
    func preloadAhead(_ cv: UICollectionView) {
        guard let ctx, let list, !cv.bounds.isEmpty else { return }
        if preloadHooked !== list {
            preloadHooked = list
            // JS mounts rows ahead of the screen as it scrolls: once a batch of them is bound, look again.
            list.onBind = { [weak self, weak cv] in
                guard let self, !self.preloadSoon else { return }
                self.preloadSoon = true
                DispatchQueue.main.async { [weak self, weak cv] in
                    self?.preloadSoon = false
                    if let self, let cv { self.preloadAhead(cv) }
                }
            }
        }
        let rowsPart = ZnListPart.rows.rawValue
        let items = cv.indexPathsForVisibleItems.filter { $0.section == rowsPart }.map(\.item)
        guard let first = items.min(), let last = items.max() else { return }
        if preloadFirst >= 0, first != preloadFirst { preloadForward = first > preloadFirst }
        preloadFirst = first
        let ahead = znPreloadRows(first: first, last: last, forward: preloadForward, rows: rows.count, cols: shape.cols,
                                  ahead: ZnImagePreload.rowsAhead)
        let ids = ahead.compactMap { rows[safe: $0].flatMap { list.bound[$0.key] } }
        guard ids != preloadAsked else { return }
        preloadAsked = ids
        ZnImagePreload.shared.want(owner: preloadOwner, instances: ids.compactMap { ctx.store.find($0) }, ctx: ctx)
    }
}
