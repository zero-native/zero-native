// The media plugin's iOS side (plugins/media, as android/.../MediaModule.kt): photos from Photos (PHPicker, no
// permission), any file from Files (the document picker, as a copy), a photo from the camera (UIImagePickerController),
// all as files in ZnHandles.fileDir, through ZnLaunch, so the JS side is the same as on Android. Rules: MediaRules.swift,
// pictures: MediaImage.swift (both tested on the Mac: ios/tests/plugins/media).
//
// A pick, in three steps as on Android:
// 1. Before the picker opens, the job (sizes, limits) is on disk ("zn.media" / "job"), and ZnLaunch has a "waiting" record.
// 2. The picker answers. iOS's picked files live only while its callback runs (Photos) or in our temporary folder
//    (Files), so each is copied at once into fileDir under a dot name (no handle can name it), the job notes the copies,
//    names and types, then ZnLaunch saves its record and JS hears `result`.
// 3. JS calls `collect`. On the media queue each copy becomes our file: a photo is turned, made smaller and written as a
//    JPEG with no EXIF, a file is moved into place as it is. Calling it again is safe: a whole file already there is used.
//
// iOS differences:
// - A kill while a picker or the camera is open: the pickers run in our process, so the answer dies with it and the pick
//   is "lost" at the next start (Android brings the other app's answer back). Nothing like `access_lost` comes from a
//   link's read right: the copies are ours.
// - takePhoto needs the camera permission (NSCameraUsageDescription): not asked yet or refused, it answers
//   `camera_permission` and JS asks and tries again, as Android's trap. iOS asks once, so a "no" there is
//   `camera_blocked` (Android says `camera_denied` the first time). No camera (the simulator): `no_app`.
// - pickFile's `types`: each mime type as the document picker's content type ("image/*" is any picture); one iOS doesn't
//   know matches no file.
// - What the pick has up can go with no answer (ZnPopups closes what was presented over a Sheet or Modal that closes; a
//   swipe down): a watch while it is up, the next pick and the app's return to the front notice it, and the pick ends
//   as a cancel, as the document scanner's.
// - Debug builds with no camera (the simulator): ZN_MEDIA_FAKE_CAMERA=1 makes takePhoto answer with a drawn photo through
//   the same files, job and launch.
import AVFoundation
import PhotosUI
import UIKit
import UniformTypeIdentifiers
#if SWIFT_PACKAGE
import ZnRuntime
#endif

/// Add it with `ZnPlugins.register(..., MediaPlugin())`. JS: `Media` (plugins/media/src).
public struct MediaPlugin: ZnPlugin {
    public init() {}

    public func register(_ r: ZnPluginRegistry) {
        r.module(MediaModule())
    }
}

final class MediaModule: ZnModuleBase, @unchecked Sendable {
    /// The launch key. One key: one pick at a time, and every result takes the same path in JS.
    static let key = "media"
    private static let store = "zn.media", jobKey = "job", jpeg = "image/jpeg"
    /// One queue: two big photos at once would run a phone out of memory. Not the shared pool, which fetch needs.
    private let worker = DispatchQueue(label: "zn-media", qos: .userInitiated)
    private let lock = NSLock()
    private var count = 0
    // Main thread only: the pick whose picker is up or whose copies are being made, and what it has up.
    private var open: String?
    private lazy var delegate = PickerDelegate(self)
    private weak var shown: UIViewController?
    private var uiUp = false
    private var watch: Timer?
    private var goneTicks = 0
    private var appeared = false
    private var shownAt = Date.distantPast

    private static var fakeCamera: Bool {
        #if DEBUG
        return ProcessInfo.processInfo.environment["ZN_MEDIA_FAKE_CAMERA"] == "1" && AVCaptureDevice.default(for: .video) == nil
        #else
        return false
        #endif
    }

    init() {
        super.init("Media", version: 1)

        function("pickPhotos", onMain: true) { call in
            let max = Swift.min(Swift.max(try call.intOrNil("max") ?? 1, 1), MediaRules.maxPhotos)
            let job = MediaJob(id: self.newId(), kind: MediaJob.photos, maxSize: try self.maxSize(call), quality: try self.quality(call), max: max)
            MainActor.assumeIsolated {
                self.launch(call, job) {
                    // No permission: the picker runs out of our process and gives only what the user picked. `.current`
                    // keeps HEIC as it is (ImageIO reads it) instead of a converted copy.
                    var config = PHPickerConfiguration()
                    config.filter = .images
                    config.selectionLimit = max
                    config.preferredAssetRepresentationMode = .current
                    let picker = PHPickerViewController(configuration: config)
                    picker.delegate = self.delegate
                    return picker
                }
            }
        }

        function("pickFile", onMain: true) { call in
            let types = try self.types(call)
            let maxBytes = Swift.min(Swift.max(Int64((call.args["maxBytes"] as? NSNumber)?.int64Value ?? MediaRules.maxBytes), 1), MediaRules.maxBytes)
            let job = MediaJob(id: self.newId(), kind: MediaJob.file, maxBytes: maxBytes)
            MainActor.assumeIsolated {
                self.launch(call, job) {
                    let picker = UIDocumentPickerViewController(forOpeningContentTypes: Self.contentTypes(types), asCopy: true)
                    picker.allowsMultipleSelection = false
                    picker.delegate = self.delegate
                    return picker
                }
            }
        }

        function("takePhoto", onMain: true) { call in
            let maxSize = try self.maxSize(call), quality = try self.quality(call)
            MainActor.assumeIsolated {
                let fake = Self.fakeCamera
                // Both: the iOS 26 simulator says the camera source is there, with no camera behind it.
                let available = fake || (UIImagePickerController.isSourceTypeAvailable(.camera) && AVCaptureDevice.default(for: .video) != nil)
                let authorized = fake || AVCaptureDevice.authorizationStatus(for: .video) == .authorized
                if case .refuse(let reason) = MediaRules.camera(available: available, authorized: authorized) {
                    return call.resolve(["launched": false, "reason": reason])
                }
                let id = self.newId()
                var job = MediaJob(id: id, kind: MediaJob.camera, maxSize: maxSize, quality: quality)
                job.parts = [MediaRules.captureName(id)]
                self.launch(call, job) {
                    if fake {
                        print("zn media: no camera; a fake photo (ZN_MEDIA_FAKE_CAMERA)")
                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { self.fakePhoto(id) }
                        return nil
                    }
                    let camera = UIImagePickerController()
                    camera.sourceType = .camera
                    camera.mediaTypes = [UTType.image.identifier]
                    camera.delegate = self.delegate
                    camera.modalPresentationStyle = .fullScreen
                    return camera
                }
            }
        }

        function("collect") { call in
            let id = try call.string("id")
            self.work(call) { self.collect(call, id) }
        }

        // JS is done with this launch. The files stay until the trim or cleanup removes them; the copies go now.
        function("forget") { call in
            let id = try call.string("id")
            self.work(call) {
                guard let job = Self.read(), job.id == id else { return call.resolve(true) }
                for p in job.parts { try? FileManager.default.removeItem(at: ZnHandles.fileDir.appendingPathComponent(p)) }
                // Checked again on the main thread, where every new job is written: a pick started meanwhile has its
                // own job by now, and deleting it would make that pick come back "lost".
                DispatchQueue.main.async {
                    if Self.read()?.id == id {
                        ZNStorage.remove(Self.store, key: Self.jobKey)
                        ZNStorage.flush(Self.store)
                    }
                    call.resolve(true)
                }
            }
        }

        function("edit") { call in
            let source = ZnHandles.fileOf(try call.string("handle"))
            let maxSize = try self.maxSize(call), quality = try self.quality(call)
            let rotate = try self.rule { try MediaRules.rotate(try call.intOrNil("rotate")) }
            let crop = try self.crop(call)
            self.work(call) {
                guard let source else { throw MediaFailure("not_found", "no file for this handle") }
                let dir = ZnHandles.fileDir, id = self.newId()
                let target = dir.appendingPathComponent(MediaRules.fileName(id, 0, "jpg"))
                try MediaImage.write(source, work: dir.appendingPathComponent(MediaRules.partName(id, 0, "out")), target: target,
                                     maxSize: maxSize, quality: quality, rotate: rotate, crop: crop)
                call.resolve(Self.describe(target, target.lastPathComponent, Self.jpeg))
            }
        }

        function("cleanup") { call in
            let age = Swift.max((call.args["olderThanMs"] as? NSNumber)?.doubleValue ?? MediaRules.dayMs, 0)
            let keep = Set((call.args["keep"] as? [String] ?? []).compactMap { ZnHandles.fileOf($0)?.lastPathComponent })
            self.work(call) { call.resolve(self.trim(age, .max, keep)) }
        }

        // Debug builds: a big photo stored sideways with a location, so the phone test needs no hands.
        function("debugPhoto") { call in
            #if DEBUG
            self.work(call) {
                let target = ZnHandles.fileDir.appendingPathComponent(MediaRules.fileName(self.newId(), 0, "jpg"))
                try MediaImage.debugPhoto(target)
                call.resolve(Self.describe(target, target.lastPathComponent, Self.jpeg))
            }
            #else
            call.reject("debug_only", "debugPhoto is for debug builds only")
            #endif
        }

        function("debugExif") { call in
            #if DEBUG
            let file = ZnHandles.fileOf(try call.string("handle"))
            self.work(call) {
                guard let file, let exif = MediaImage.exif(file) else { throw MediaFailure("not_found") }
                call.resolve(["orientation": exif.degrees, "location": exif.location])
            }
            #else
            call.reject("debug_only", "debugExif is for debug builds only")
            #endif
        }

        NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { if self?.uiGone() == true { self?.dropGone() } }
        }
    }

    // MARK: Jobs and launches

    private static func read() -> MediaJob? { MediaJob.from(ZNStorage.string(store, key: jobKey)) }

    private static func write(_ job: MediaJob) {
        guard let json = ZnModules.json(job.json) else { return }
        ZNStorage.set(store, key: jobKey, string: json)
        ZNStorage.flush(store)
    }

    /// Main thread: the job on disk, the launch, then the picker [make] gives (nil: it answers by itself).
    @MainActor private func launch(_ call: ZnCall, _ job: MediaJob, _ make: () -> UIViewController?) {
        // Closed with no answer: that pick is over. Its own promise acks its "cancelled" in a moment, so until then this
        // one is busy (ZnLaunch would say "unacked", which a pick never is on Android).
        if uiGone() {
            dropGone()
            return call.resolve(["launched": false, "reason": "busy"])
        }
        guard let top = znTopController() else { return call.resolve(["launched": false, "reason": "no_activity"]) }
        let before = ZNStorage.string(Self.store, key: Self.jobKey)
        Self.write(job)
        let started = ZnLaunch.start(Self.key, id: job.id)
        guard started.launched else {  // a refused launch must not wipe a result still waiting for JS
            if let before { ZNStorage.set(Self.store, key: Self.jobKey, string: before) } else { ZNStorage.remove(Self.store, key: Self.jobKey) }
            ZNStorage.flush(Self.store)
            return call.resolve(["launched": false, "reason": started.reason ?? "failed", "id": job.id])
        }
        open = job.id
        call.resolve(["launched": true, "id": job.id])
        guard let vc = make() else { return }
        vc.presentationController?.delegate = delegate  // a swipe down: a cancel
        show(vc, over: top)
    }

    /// The picker's answer, after its copies were made: the job notes them, then ZnLaunch tells JS. [code]: -1 OK, 0
    /// cancelled.
    @MainActor fileprivate func answer(_ id: String, code: Int, copies: [Copy] = []) {
        guard open == id else { return }
        open = nil
        guard var job = Self.read(), job.id == id, job.resultCode == nil else { return }
        job.resultCode = code
        if job.kind != MediaJob.camera {
            job.parts = copies.map(\.part)
            job.names = copies.map(\.name)
            job.mimes = copies.map(\.mime)
            job.failed = copies.map(\.failed)
        }
        Self.write(job)
        print("zn media: result \(code), \(code == -1 ? (job.kind == MediaJob.camera ? 1 : copies.count) : 0) file(s)")
        ZnLaunch.finish(Self.key, id: id, resultCode: code, extras: ["count": code == -1 ? Swift.max(job.parts.count, 1) : 0])
    }

    /// One picked file, copied: [part] in fileDir, or [failed] with why.
    struct Copy {
        var part: String
        var name: String?
        var mime: String?
        var failed: String?
    }

    /// The copies of one pick while they are made (main thread).
    final class Copies: @unchecked Sendable {
        var list: [Copy]
        /// The items read (or failed), the loads still going, and whether the pick was answered.
        var done = Set<Int>()
        var loads: [Progress] = []
        var answered = false
        init(_ list: [Copy]) { self.list = list }
    }

    /// A photo not read in this time (an iCloud download that never ends) fails as read_failed, so the pick ends.
    static let photoReadLimit: TimeInterval = 60

    // MARK: The pickers' answers (main thread)

    @MainActor fileprivate func picked(photos results: [PHPickerResult]) {
        uiAnswered()
        guard let id = open, let job = Self.read(), job.id == id else { return }
        let results = Array(results.prefix(job.max))
        if results.isEmpty { return answer(id, code: 0) }
        let copies = Copies(results.indices.map { Copy(part: MediaRules.partName(id, $0, "in")) })
        let end = {
            guard !copies.answered else { return }
            copies.answered = true
            self.answer(id, code: -1, copies: copies.list)
        }
        for (i, r) in results.enumerated() {
            let provider = r.itemProvider
            let type = provider.registeredTypeIdentifiers.compactMap(UTType.init).first { $0.conforms(to: .image) } ?? .image
            copies.list[i].name = provider.suggestedName
            copies.list[i].mime = type.preferredMIMEType
            let part = copies.list[i].part, maxBytes = job.maxBytes
            // The file lives only while this callback runs: copied here, on its queue. An iCloud photo is downloaded
            // first (the promise waits, at most photoReadLimit).
            let load = provider.loadFileRepresentation(forTypeIdentifier: type.identifier) { url, error in
                let failed = url.map { Self.copy($0, to: part, maxBytes: maxBytes) } ?? "read_failed"
                if url == nil { print("zn media: a photo can't be read: \((error as NSError?)?.code ?? 0)") }
                DispatchQueue.main.async {
                    guard !copies.answered else {  // too late: it failed already
                        try? FileManager.default.removeItem(at: ZnHandles.fileDir.appendingPathComponent(part))
                        return
                    }
                    copies.list[i].failed = failed
                    copies.done.insert(i)
                    if copies.done.count == results.count { end() }
                }
            }
            copies.loads.append(load)
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.photoReadLimit) {
            guard !copies.answered else { return }
            let late = copies.list.indices.filter { !copies.done.contains($0) }
            print("zn media: \(late.count) photo(s) not read in \(Int(Self.photoReadLimit)) s (an iCloud download?): failed")
            for i in late { copies.list[i].failed = "read_failed" }
            copies.loads.forEach { $0.cancel() }
            end()
        }
    }

    @MainActor fileprivate func picked(files urls: [URL]) {
        uiAnswered()
        guard let id = open, let job = Self.read(), job.id == id else { return }
        guard let url = urls.first else { return answer(id, code: 0) }
        let part = MediaRules.partName(id, 0, "in"), maxBytes = job.maxBytes
        let mime = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType
        worker.async {
            // A copy already (asCopy: in our temporary folder), copied into fileDir; the temporary one goes.
            let failed = Self.copy(url, to: part, maxBytes: maxBytes)
            try? FileManager.default.removeItem(at: url)
            let copy = Copy(part: part, name: url.lastPathComponent, mime: mime, failed: failed)
            DispatchQueue.main.async { self.answer(id, code: -1, copies: [copy]) }
        }
    }

    @MainActor fileprivate func picked(photo image: UIImage?) {
        uiAnswered()
        guard let id = open else { return }
        guard let image else { return answer(id, code: 0) }
        worker.async {
            // The camera's photo is in memory: written once at high quality, made our JPEG in collect.
            let ok = (try? image.jpegData(compressionQuality: 0.95)?.write(to: ZnHandles.fileDir.appendingPathComponent(MediaRules.captureName(id)))) != nil
            if !ok { print("zn media: the camera's photo can't be written") }
            DispatchQueue.main.async { self.answer(id, code: -1) }
        }
    }

    @MainActor fileprivate func cancelled() {
        uiAnswered()
        if let id = open { answer(id, code: 0) }
    }

    /// Copies [from] to the part [name] in fileDir, at most [maxBytes]. nil, or the reason it failed.
    private static func copy(_ from: URL, to name: String, maxBytes: Int64) -> String? {
        let target = ZnHandles.fileDir.appendingPathComponent(name)
        try? FileManager.default.removeItem(at: target)
        let values = try? from.resourceValues(forKeys: [.fileSizeKey, .isDirectoryKey])
        // A package from Files (.pages, .key, .rtfd, a bundle) is a folder: no file to hand JS (Android has none).
        if values?.isDirectory == true {
            print("zn media: the picked item is a folder (a package), not a file")
            return "read_failed"
        }
        let size = values?.fileSize.map(Int64.init) ?? 0
        if size > maxBytes { return "too_big" }
        do {
            try FileManager.default.copyItem(at: from, to: target)
            try MediaImage.sync(target)
            return nil
        } catch {
            try? FileManager.default.removeItem(at: target)
            return (error as NSError).code == NSFileWriteOutOfSpaceError ? "no_space" : "read_failed"
        }
    }

    @MainActor private func fakePhoto(_ id: String) {
        let url = ZnHandles.fileDir.appendingPathComponent(MediaRules.captureName(id))
        do { try MediaImage.debugPhoto(url) } catch { print("zn media: the fake photo failed") }
        answer(id, code: -1)
    }

    // MARK: What the pick has up (the docscan plugin's watch)

    @MainActor private func show(_ vc: UIViewController, over top: UIViewController) {
        shown = vc
        uiUp = true
        goneTicks = 0
        appeared = false
        shownAt = Date()
        top.present(vc, animated: true)
        if watch == nil {
            watch = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
                MainActor.assumeIsolated { self?.tick() }
            }
        }
    }

    @MainActor private func uiAnswered() {
        uiUp = false
        shown = nil
        watch?.invalidate()
        watch = nil
    }

    /// The picker is gone (or no longer presented) and never answered. The Photos picker is presented only once its
    /// remote part answers, so it may not be up yet for a while: 10 s.
    @MainActor private func uiGone() -> Bool {
        guard open != nil, uiUp else { return false }
        guard let s = shown else { return true }
        let presented = s.presentingViewController != nil
        if presented { appeared = true }
        if presented || s.isBeingPresented { return false }
        return appeared || Date().timeIntervalSince(shownAt) >= 10
    }

    /// Gone on two ticks in a row: a delegate's answer comes just after the picker has gone.
    @MainActor private func tick() {
        goneTicks = uiGone() ? goneTicks + 1 : 0
        if goneTicks >= 2 { dropGone() }
    }

    @MainActor private func dropGone() {
        print("zn media: the \(shown.map { "\(type(of: $0))" } ?? "picker") went away with no answer: cancelled")
        cancelled()
    }

    /// The pickers' delegates must be NSObjects: this one forwards to the module.
    final class PickerDelegate: NSObject, PHPickerViewControllerDelegate, UIDocumentPickerDelegate, UIImagePickerControllerDelegate,
        UINavigationControllerDelegate, UIAdaptivePresentationControllerDelegate {
        weak var module: MediaModule?
        init(_ m: MediaModule) { module = m }

        func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
            picker.dismiss(animated: true)
            MainActor.assumeIsolated { module?.picked(photos: results) }
        }

        func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
            MainActor.assumeIsolated { module?.picked(files: urls) }
        }

        func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
            MainActor.assumeIsolated { module?.cancelled() }
        }

        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            picker.dismiss(animated: true)
            MainActor.assumeIsolated { module?.picked(photo: info[.originalImage] as? UIImage) }
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            picker.dismiss(animated: true)
            MainActor.assumeIsolated { module?.cancelled() }
        }

        func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
            MainActor.assumeIsolated { module?.cancelled() }
        }
    }

    // MARK: collect (the media queue)

    private func collect(_ call: ZnCall, _ id: String) {
        guard let job = Self.read(), job.id == id, let code = job.resultCode else {
            return call.resolve(["status": "lost", "files": [Any]()])
        }
        let dir = ZnHandles.fileDir
        if code != -1 {
            for p in job.parts { try? FileManager.default.removeItem(at: dir.appendingPathComponent(p)) }
            return call.resolve(["status": "cancelled", "files": [Any]()])
        }
        var files: [[String: Any]] = [], reason: String?, skipped = 0
        func one(_ block: () throws -> [String: Any]) {
            do {
                files.append(try block())
            } catch let f as MediaFailure {
                print("zn media: a file failed: \(f.code)")
                reason = reason ?? f.code
                skipped += 1
            } catch {
                reason = reason ?? "read_failed"
                skipped += 1
            }
        }
        switch job.kind {
        case MediaJob.camera: one { try camera(job) }
        case MediaJob.photos: for i in job.parts.indices where !call.isCancelled { one { try photo(job, i) } }
        default: if !job.parts.isEmpty { one { try file(job) } }
        }
        var out: [String: Any] = ["status": files.isEmpty ? "failed" : "ok", "files": files, "skipped": skipped]
        if files.isEmpty { out["reason"] = reason ?? "no_file" }
        call.resolve(out)
        _ = trim(MediaRules.keepMs, MediaRules.keepBytes, [])
    }

    private func camera(_ job: MediaJob) throws -> [String: Any] {
        let dir = ZnHandles.fileDir
        let target = dir.appendingPathComponent(MediaRules.fileName(job.id, 0, "jpg"))
        if !FileManager.default.fileExists(atPath: target.path) {
            let source = dir.appendingPathComponent(MediaRules.captureName(job.id))
            guard Self.bytes(source) > 0 else { throw MediaFailure("no_photo", "the camera gave no photo") }
            try MediaImage.write(source, work: dir.appendingPathComponent(MediaRules.partName(job.id, 0, "out")), target: target,
                                 maxSize: job.maxSize, quality: job.quality)
            try? FileManager.default.removeItem(at: source)
        }
        return Self.describe(target, target.lastPathComponent, Self.jpeg)
    }

    private func photo(_ job: MediaJob, _ i: Int) throws -> [String: Any] {
        let dir = ZnHandles.fileDir
        let target = dir.appendingPathComponent(MediaRules.fileName(job.id, i, "jpg"))
        let name = MediaRules.withExtension(MediaRules.displayName(job.names[i], target.lastPathComponent), "jpg")
        if !FileManager.default.fileExists(atPath: target.path) {
            if let f = job.failed[i] { throw MediaFailure(f) }
            let part = dir.appendingPathComponent(job.parts[i])
            guard FileManager.default.fileExists(atPath: part.path) else { throw MediaFailure("access_lost", "the copy is gone; pick again") }
            try MediaImage.write(part, work: dir.appendingPathComponent(MediaRules.partName(job.id, i, "out")), target: target,
                                 maxSize: job.maxSize, quality: job.quality)
            try? FileManager.default.removeItem(at: part)
        }
        return Self.describe(target, name, Self.jpeg)
    }

    private func file(_ job: MediaJob) throws -> [String: Any] {
        let dir = ZnHandles.fileDir, fm = FileManager.default
        let name = MediaRules.displayName(job.names.first ?? nil, "file")
        // A retry: the file already moved into place (its extension came from its type).
        let start = MediaRules.fileName(job.id, 0, "")
        if let done = (try? fm.contentsOfDirectory(atPath: dir.path))?.first(where: { $0.hasPrefix(start) }) {
            return Self.describe(dir.appendingPathComponent(done), name, MediaRules.mimeOr(job.mimes.first ?? nil, MediaRules.mimeOf(done)))
        }
        if let f = job.failed.first ?? nil { throw MediaFailure(f) }
        let part = dir.appendingPathComponent(job.parts[0])
        guard fm.fileExists(atPath: part.path) else { throw MediaFailure("access_lost", "the copy is gone; pick again") }
        let mime = MediaRules.mimeOr(job.mimes.first ?? nil, "application/octet-stream")
        let target = dir.appendingPathComponent(MediaRules.fileName(job.id, 0, MediaRules.extensionFor(mime, name)))
        guard rename(part.path, target.path) == 0 else {
            try? fm.removeItem(at: part)  // as Android: the copy goes, and the user picks again
            throw MediaFailure("write_failed", "can't move the copy into place")
        }
        return Self.describe(target, name, mime)
    }

    private static func describe(_ url: URL, _ name: String, _ mime: String) -> [String: Any] {
        let (w, h) = mime.hasPrefix("image/") ? MediaImage.size(url) : (0, 0)
        return ["handle": ZnHandles.file(url) ?? "", "uri": url.absoluteString, "width": w, "height": h, "size": bytes(url), "mime": mime, "name": name]
    }

    private static func bytes(_ url: URL) -> Int64 {
        (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? NSNumber)?.int64Value ?? 0
    }

    /// The folder's limit. Never a file of the current job, as its picker may still be writing.
    private func trim(_ maxAgeMs: Double, _ maxBytes: Int64, _ keep: Set<String>) -> [String: Any] {
        let fm = FileManager.default, dir = ZnHandles.fileDir
        let job = Self.read()?.id
        let urls = (try? fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.contentModificationDateKey, .fileSizeKey])) ?? []
        let files = urls.compactMap { u -> MediaStored? in
            guard let v = try? u.resourceValues(forKeys: [.contentModificationDateKey, .fileSizeKey]), let d = v.contentModificationDate else { return nil }
            return MediaStored(name: u.lastPathComponent, bytes: Int64(v.fileSize ?? 0), modified: d.timeIntervalSince1970 * 1000)
        }
        let names = Set(MediaRules.toDelete(files, now: Date().timeIntervalSince1970 * 1000, maxAgeMs: maxAgeMs, maxBytes: maxBytes) {
            keep.contains($0) || (job != nil && $0.contains(job!))
        })
        var deleted = 0, bytes: Int64 = 0
        for u in urls where names.contains(u.lastPathComponent) {
            let size = Self.bytes(u)
            if (try? fm.removeItem(at: u)) != nil { deleted += 1; bytes += size }
        }
        if deleted > 0 { print("zn media: cleanup removed \(deleted) files") }
        return ["deleted": deleted, "bytes": bytes]
    }

    // MARK: Small parts

    /// Runs [block] on the media queue. A MediaFailure rejects with its code.
    private func work(_ call: ZnCall, _ block: @escaping () throws -> Void) {
        worker.async {
            do {
                try block()
            } catch let f as MediaFailure {
                call.reject(f.code, f.message)
            } catch {
                print("zn media: failed: \(error)")
                call.reject("failed", "media failed: \(error)")
            }
        }
    }

    private func newId() -> String {
        let n = lock.withLock { () -> Int in
            count += 1
            return count
        }
        return String(Int64(Date().timeIntervalSince1970 * 1000), radix: 36) + "x" + String(n, radix: 36)
    }

    /// A rule's refusal, as a wrong argument.
    private func rule<T>(_ read: () throws -> T) throws -> T {
        do { return try read() } catch let a as MediaArgs { throw ZnInvalidArgs(a.message) }
    }

    private func maxSize(_ call: ZnCall) throws -> Int { try rule { try MediaRules.maxSize(try call.intOrNil("maxSize")) } }
    private func quality(_ call: ZnCall) throws -> Int { try rule { try MediaRules.quality(try call.intOrNil("quality")) } }

    private func crop(_ call: ZnCall) throws -> MediaCrop? {
        guard let raw = call.args["crop"], !(raw is NSNull) else { return nil }
        guard let c = raw as? [String: Any] else { throw ZnInvalidArgs("\"crop\" must be { x, y, width, height }") }
        func whole(_ name: String) throws -> Int {
            guard let n = c[name] as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() else { throw ZnInvalidArgs("\"crop.\(name)\" must be a number") }
            let d = n.doubleValue
            if d != d.rounded() || d < 0 || d > Double(Int32.max) { throw ZnInvalidArgs("\"crop.\(name)\" must be a whole number") }
            return Int(d)
        }
        return MediaCrop(x: try whole("x"), y: try whole("y"), width: try whole("width"), height: try whole("height"))
    }

    private func types(_ call: ZnCall) throws -> [String] {
        guard let list = call.args["types"] as? [Any] else { return ["*/*"] }
        let types = list.map { $0 as? String ?? "" }
        if let bad = types.first(where: { MediaRules.mimeOr($0, "") == "" }) { throw ZnInvalidArgs("\"\(bad)\" isn't a file type") }
        return types.isEmpty ? ["*/*"] : types
    }

    /// Mime types → the document picker's content types. "image/*" and the like are the family's base type; a type or
    /// family iOS doesn't know is a made-up type, which matches no file (as an Android type no app has). Broader than
    /// Android: "application/*" is any file (iOS has no type for every application/ one), and "text/*" is any text,
    /// JSON and XML too (application/ on Android).
    static func contentTypes(_ mimes: [String]) -> [UTType] {
        guard let list = MediaRules.pickTypes(mimes) else { return [.item] }
        let families: [String: UTType] = ["image": .image, "video": .movie, "audio": .audio, "text": .text, "application": .data,
                                          "font": .font, "model": .threeDContent, "message": .message]
        let types = list.compactMap { m -> UTType? in
            if m.hasSuffix("/*"), let family = families[String(m.dropLast(2))] { return family }
            return UTType(mimeType: m) ?? UTType(tag: m, tagClass: .mimeType, conformingTo: .data)
        }
        return types.isEmpty ? [.item] : types
    }
}
