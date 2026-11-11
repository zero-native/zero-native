package dev.zeronative.baselineprofile

import androidx.benchmark.macro.junit4.BaselineProfileRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Records which classes and methods the sample uses. The plugin writes the result into runtime/ (the filter in
 * runtime/build.gradle.kts, shipped to every app) and sample/ (everything). Two tests: start-up (also kept as the
 * start-up profile) and the rest of a normal session (lists, sheets, tabs, typing). The plugin merges both.
 */
@RunWith(AndroidJUnit4::class)
class BaselineProfileGenerator {
    @get:Rule
    val rule = BaselineProfileRule()

    /** Cold start onto Home, then a scroll of its 10,000-row list. */
    @Test
    fun startup() = rule.collect(packageName = PACKAGE, includeInStartupProfile = true) {
        pressHome()
        startActivityAndWait()
        scrollHome()
    }

    /** What a user does after start: pay a merchant, scroll offers, switch tabs, type. */
    @Test
    fun journeys() = rule.collect(packageName = PACKAGE) {
        pressHome()
        startActivityAndWait()
        scrollHome()
        openAmountFromHome()
        typeAndPay()
        backToHome()
        scrollOffers()
        useTabs()
        scrollComponents()
        typeInInputs()
    }
}
