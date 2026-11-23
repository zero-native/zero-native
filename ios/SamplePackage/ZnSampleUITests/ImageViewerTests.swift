import XCTest

/// The TSX image viewer (plugins/image-viewer/src/ImageViewerScreen.tsx, route photoViewer), opened from the image
/// viewer lab (route imageViewerLab, examples/sample/src/ImageViewerLab.tsx). Found the way VoiceOver finds it: the
/// close button by its label, the counter and each photo by "Photo n of count". The lab writes what ImageViewer.open
/// answered into iv-status. The photos come from picsum.photos (a network is needed).
final class ImageViewerTests: ZnUITestCase {
    override func setUp() {
        super.setUp()
        // The viewer opens and closes by motion values (shown.to(1), shown.to(0).then(close)): the real motion engine,
        // in case this build still keeps it behind ZN_MOTION_ENGINE (the stub's to() never settles, so it never closes).
        let app = XCUIApplication()
        app.launchEnvironment["ZN_ROUTE"] = "imageViewerLab"
        app.launchEnvironment["ZN_MOTION_ENGINE"] = "1"
        app.launch()
        self.app = app
        XCTAssertTrue(appears(id("iv-status"), timeout: 30), "imageViewerLab: no iv-status after 30 s")
    }

    private func status(_ s: String, timeout: TimeInterval = 5, file: StaticString = #filePath, line: UInt = #line) {
        waitLabel(id("iv-status"), "status: \(s)", timeout: timeout, file: file, line: line)
    }

    /// The lab's thumbnail n (from 1): a button read as "Store photo n".
    private func thumb(_ n: Int) -> XCUIElement { app.buttons["Store photo \(n)"].firstMatch }

    private var close: XCUIElement { app.buttons.matching(NSPredicate(format: "label == %@", "Close")).firstMatch }

    /// The counter: a text read as "Photo n of count".
    private func counter(_ n: Int, of count: Int) -> XCUIElement { text("Photo \(n) of \(count)") }

    /// The photo on screen: one picture element, read as "Photo n of count".
    private func photo(_ n: Int, of count: Int) -> XCUIElement {
        app.images.matching(NSPredicate(format: "label == %@", "Photo \(n) of \(count)")).firstMatch
    }

    func testStripPagesAndCloses() {
        thumb(2).tap()
        status("strip opened (TSX screen)")
        XCTAssertTrue(appears(close, timeout: 10), "no close button")
        XCTAssertTrue(appears(counter(2, of: 4), timeout: 5), "the counter doesn't read photo 2 of 4")
        XCTAssertTrue(appears(photo(2, of: 4), timeout: 5), "photo 2 isn't one picture element")

        // A swipe pages; the counter follows when the page rests (onMomentumScrollEnd).
        photo(2, of: 4).swipeLeft()
        XCTAssertTrue(appears(counter(3, of: 4), timeout: 5), "the counter didn't move to photo 3")
        XCTAssertTrue(appears(photo(3, of: 4), timeout: 5))

        // The close button answers the photo on screen (index 2), not the one it opened on.
        close.tap()
        status("strip closed on 2")
        XCTAssertFalse(close.exists)
    }

    func testOnePhotoReadsItsAlt() {
        app.buttons["One photo (no count)"].tap()
        status("one opened (TSX screen)")
        XCTAssertTrue(appears(close, timeout: 10))
        // Its own alt, no counter with one photo.
        XCTAssertTrue(appears(app.images["Shop front"], timeout: 5), "the photo doesn't read its alt")
        XCTAssertFalse(counter(1, of: 1).exists)
        close.tap()
        status("one closed on 0")
    }

    func testOptionsLabels() {
        reveal(app.buttons["Options: no swipe close, no double tap, Hindi words, grey"]).tap()
        status("options opened (TSX screen)")
        // The app's own words: the close label and the photo label template.
        let band = app.buttons.matching(NSPredicate(format: "label == %@", "Band karein")).firstMatch
        XCTAssertTrue(appears(band, timeout: 10), "no close button with the app's label")
        XCTAssertTrue(appears(text("Photo 2 / 4"), timeout: 5), "the counter doesn't use photoLabel")
        // swipeToCloseEnabled false: a drag down leaves it open.
        let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.35))
        start.press(forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: 0, dy: 350)))
        RunLoop.current.run(until: Date().addingTimeInterval(1))
        XCTAssertTrue(band.exists, "a drag down closed a viewer with swipeToCloseEnabled false")
        band.tap()
        status("options closed on 1")
    }

    func testDragDownCloses() {
        thumb(1).tap()
        status("strip opened (TSX screen)")
        XCTAssertTrue(appears(photo(1, of: 4), timeout: 10))
        let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.35))
        start.press(forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: 0, dy: 350)))
        status("strip closed on 0")
    }

    func testErrorShowsRetry() {
        reveal(app.buttons["Broken, refused, then good"]).tap()
        status("broken opened (TSX screen)")
        // The picsum 404: the error words and the retry button, which loads again.
        let retry = app.buttons["Try again"].firstMatch
        XCTAssertTrue(appears(retry, timeout: 15), "no retry button")
        XCTAssertTrue(text("Couldn't load this photo").exists)
        retry.tap()
        XCTAssertTrue(appears(app.buttons["Try again"].firstMatch, timeout: 15), "the retry button went for a 404")
        close.tap()
        status("broken closed on 0")
    }
}
