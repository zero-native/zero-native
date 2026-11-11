package dev.zeronative.baselineprofile

import androidx.benchmark.macro.MacrobenchmarkScope
import androidx.test.uiautomator.By
import androidx.test.uiautomator.Direction
import androidx.test.uiautomator.UiObject2
import androidx.test.uiautomator.Until
import java.util.regex.Pattern

const val PACKAGE = "dev.zeronative.sample"

/** Waits until JS has filled the screen: the Pay button's text comes from JS state, not from the template. */
fun MacrobenchmarkScope.waitForAmountScreen() {
    check(device.wait(Until.hasObject(By.text("Enter Amount")), 10_000)) { "amount screen did not load" }
}

/** Waits for Home (the start screen, HomeScreen.tsx): its "Dev screens" button is drawn by JS. */
fun MacrobenchmarkScope.waitForHome() {
    check(device.wait(Until.hasObject(By.text("Dev screens")), 10_000)) { "home screen did not load" }
}

/** The biggest scrollable thing on screen: the screen's list (a rail inside it is smaller). */
private fun MacrobenchmarkScope.mainList(): UiObject2 {
    check(device.wait(Until.hasObject(By.scrollable(true)), 10_000)) { "no list on screen" }
    return device.findObjects(By.scrollable(true)).maxBy { it.visibleBounds.height() }
}

/** Flings the screen's list [down] times down, then [up] times up. Waits for each fling to end. */
fun MacrobenchmarkScope.flingList(down: Int, up: Int) {
    // A fling can move nodes under us, so the list is found again before each one.
    repeat(down) {
        mainList().fling(Direction.DOWN)
        device.waitForIdle()
    }
    repeat(up) {
        mainList().fling(Direction.UP)
        device.waitForIdle()
    }
}

/** Home's list: 5 flings down and 2 up (two row kinds, rows made and reused while scrolling). */
fun MacrobenchmarkScope.scrollHome() {
    waitForHome()
    flingList(down = 5, up = 2)
}

/** Presses Back until Home shows again (a sheet or a pushed screen may be on top). */
fun MacrobenchmarkScope.backToHome() {
    repeat(4) {
        if (device.hasObject(By.text("Dev screens"))) return
        device.pressBack()
        device.wait(Until.hasObject(By.text("Dev screens")), 2_000)
    }
    waitForHome()
}

/**
 * Taps a merchant row on Home and waits for the amount screen. A merchant's name ends in its number ("Sri Medicals 0");
 * an area header ("Arekere · stores 1–100") has a "·" and no action, so it is skipped. A row cut off at the list's
 * edge may not take the tap, so a few rows are tried.
 */
fun MacrobenchmarkScope.openAmountFromHome() {
    waitForHome()
    val names = device.findObjects(By.text(Pattern.compile("^[^·]+ \\d+$")))
    for (name in names.drop(1).take(3)) {
        name.click()
        if (device.wait(Until.hasObject(By.text("Enter Amount")), 3_000)) return
    }
    error("no merchant row opened the amount screen")
}

/** Gets to the amount screen after a start: a warm start may still show it, else it is opened from Home. */
fun MacrobenchmarkScope.openAmountScreen() {
    if (device.wait(Until.hasObject(By.text("Enter Amount")), 1_000)) return
    backToHome()
    openAmountFromHome()
}

/** Taps one keypad key by its label and waits until the screen settles. */
fun MacrobenchmarkScope.tapKey(label: String) {
    val key = device.findObject(By.text(label)) ?: error("key $label not found")
    key.click()
    device.waitForIdle()
}

/**
 * Taps backspace. It has no text (icon only), so it is found next to "0": same row, same spacing as "." → "0".
 * With [holdMs] it is held down, which runs the native repeat.
 */
fun MacrobenchmarkScope.tapBackspace(holdMs: Int = 0) {
    val dot = device.findObject(By.text(".")).visibleCenter
    val zero = device.findObject(By.text("0")).visibleCenter
    val x = zero.x + (zero.x - dot.x)
    if (holdMs > 0) {
        // swipe() takes ~5 ms per step; same start and end point = a long press.
        device.swipe(x, zero.y, x, zero.y, holdMs / 5)
    } else {
        device.click(x, zero.y)
    }
    device.waitForIdle()
}

/** The typical use of the screen: type an amount past the cashback limit, fix a digit, pay, clear. */
fun MacrobenchmarkScope.typeAndPay() {
    for (k in listOf("1", "2", "5", "0", "0")) tapKey(k)
    tapBackspace()
    tapKey("9")
    device.findObject(By.text("Pay Now →"))?.click()
    // "Pay Now" opens the UPI app picker, a bottom sheet over the keypad. Back closes it (never tap an app in it).
    if (device.wait(Until.hasObject(By.textStartsWith("Choose a UPI app")), 5_000)) {
        device.pressBack()
        check(device.wait(Until.hasObject(By.text(".")), 5_000)) { "UPI sheet did not close" }
    }
    device.waitForIdle()
    tapBackspace(holdMs = 1_500)
}

/**
 * The Offers screen (OffersScreen.tsx): 5 flings down, 2 sideways flings on a product rail, 2 up, then Back.
 * Four row kinds, rails inside rows, pictures and a carousel.
 */
fun MacrobenchmarkScope.scrollOffers() {
    waitForHome()
    device.findObject(By.text("Offers"))?.click() ?: error("Offers button not found")
    // A pushed screen takes Home out of the tree, so Home's button going away means Offers is up.
    check(device.wait(Until.gone(By.text("Dev screens")), 10_000)) { "offers screen did not open" }
    flingList(down = 5, up = 0)
    // A rail: a scrollable thing that is not the screen's list. Both ways, so it also scrolls back.
    val list = mainList()
    val rail = device.findObjects(By.scrollable(true))
        .filter { it.visibleBounds.height() < list.visibleBounds.height() / 2 }
        .maxByOrNull { it.visibleBounds.width() }
    if (rail != null) {
        rail.fling(Direction.RIGHT)
        device.waitForIdle()
        rail.fling(Direction.LEFT)
        device.waitForIdle()
    }
    flingList(down = 0, up = 2)
    backToHome()
}

/** Opens a deep link in the sample (routes.ts: deepLink routes). */
fun MacrobenchmarkScope.openLink(path: String) {
    device.executeShellCommand("am start -a android.intent.action.VIEW -d zn://sample$path $PACKAGE")
}

/** Finds a tab bar item by its accessibility label (BarItem in TabsLab.tsx), or by its text. */
private fun MacrobenchmarkScope.barItem(label: String): UiObject2? =
    device.findObject(By.desc(label)) ?: device.findObject(By.text(label))

/**
 * The tabs lab (TabsLab.tsx): taps each bar item and flings the Stores list. Its data comes over HTTP, so with no
 * test server the tabs show their error state; that is fine for the profile (the tab switch is what counts).
 */
fun MacrobenchmarkScope.useTabs() {
    openLink("/dev/tabs")
    check(device.wait(Until.hasObject(By.desc("Stores")), 10_000)) { "tabs lab did not load" }
    for (label in listOf("Stores", "Offers", "Rewards", "ZeroBill", "Stores")) {
        (barItem(label) ?: error("tab $label not found")).click()
        device.waitForIdle()
    }
    // The Stores list exists only when data came in.
    if (device.hasObject(By.scrollable(true))) flingList(down = 2, up = 1)
    backToHome()
}

/** The components screen (ComponentsScreen.tsx): many kinds of nodes in one Scroll, 3 flings down and 1 up. */
fun MacrobenchmarkScope.scrollComponents() {
    openLink("/dev/components")
    check(device.wait(Until.hasObject(By.textStartsWith("Components")), 10_000)) { "components screen did not load" }
    flingList(down = 3, up = 1)
    backToHome()
}

/** The input screen (InputScreen.tsx): focus "Your name", type, then Back (keyboard) and Back (screen). */
fun MacrobenchmarkScope.typeInInputs() {
    openLink("/dev/input")
    check(device.wait(Until.hasObject(By.text("Inputs")), 10_000)) { "input screen did not load" }
    val field = device.findObject(By.text("Your name")) ?: device.findObject(By.clazz("android.widget.EditText"))
        ?: error("name field not found")
    field.click()
    device.waitForIdle()
    device.executeShellCommand("input text Ravi%sKumar")
    device.waitForIdle()
    backToHome()
}
