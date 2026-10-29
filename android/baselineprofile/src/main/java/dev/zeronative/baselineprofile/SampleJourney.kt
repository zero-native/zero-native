package dev.zeronative.baselineprofile

import androidx.benchmark.macro.MacrobenchmarkScope
import androidx.test.uiautomator.By
import androidx.test.uiautomator.Until

const val PACKAGE = "dev.zeronative.sample"

/** Waits until JS has filled the screen: the Pay button's text comes from JS state, not from the template. */
fun MacrobenchmarkScope.waitForAmountScreen() {
    check(device.wait(Until.hasObject(By.text("Enter Amount")), 10_000)) { "amount screen did not load" }
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
    device.waitForIdle()
    tapBackspace(holdMs = 1_500)
}
