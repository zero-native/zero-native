package dev.zeronative.baselineprofile

import androidx.benchmark.macro.BaselineProfileMode
import androidx.benchmark.macro.CompilationMode
import androidx.benchmark.macro.FrameTimingMetric
import androidx.benchmark.macro.StartupMode
import androidx.benchmark.macro.junit4.MacrobenchmarkRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** Frame times while typing an amount, deleting and holding backspace (the screen's main use). */
@RunWith(AndroidJUnit4::class)
class TypingBenchmark {
    @get:Rule
    val rule = MacrobenchmarkRule()

    @Test
    fun typing() = rule.measureRepeated(
        packageName = PACKAGE,
        metrics = listOf(FrameTimingMetric()),
        compilationMode = CompilationMode.Partial(BaselineProfileMode.Require),
        startupMode = StartupMode.WARM,
        iterations = 5,
        setupBlock = {
            startActivityAndWait()
            waitForAmountScreen()
        },
    ) {
        typeAndPay()
    }
}
