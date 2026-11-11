package dev.zeronative.runtime

import java.io.File
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The runtime's Baseline Profile (startup rule 6) is recorded by hand (tools/baseline-profile.ts) and committed.
 * When a class in it is renamed or removed, its rules stop helping. This test lists such classes: then record again.
 * An old profile does no harm; it only helps less.
 */
class ZnBaselineProfileTest {
    // Unit tests run in the module's folder (android/runtime).
    private val profile = File("src/main/generated/baselineProfiles/baseline-prof.txt")

    /** The class of one rule: "HSPLdev/zeronative/runtime/ZnRenderer;->render()V" → "dev/zeronative/runtime/ZnRenderer". */
    private fun classOf(rule: String): String? {
        // The flags in front are only H, S and P, so the first L starts the class name.
        val start = rule.indexOfFirst { it == 'L' }
        val end = rule.indexOf(';')
        if (start < 0 || end < start) return null
        return rule.substring(start + 1, end)
    }

    @Test
    fun everyClassInTheProfileStillExists() {
        assertTrue("no profile at ${profile.absolutePath}: run tools/baseline-profile.ts", profile.isFile)
        val classes = profile.readLines()
            .map { it.trim() }
            .filter { it.isNotEmpty() && !it.startsWith("#") }
            .mapNotNull { classOf(it) }
            // Lambda and helper classes made by D8 / R8: their numbers change with every build, so they are skipped.
            .filter { !it.contains("$\$ExternalSynthetic") }
            .toSortedSet()
        assertTrue("the profile has no rules", classes.isNotEmpty())
        // Only looks for the .class file (no loading), so a class that needs a real phone to load is still found.
        val loader = javaClass.classLoader!!
        val missing = classes.filter { loader.getResource("$it.class") == null }
        assertTrue(
            "${missing.size} of ${classes.size} classes in the profile no longer exist (record again: " +
                "bun run tools/baseline-profile.ts). First ones: ${missing.take(20)}",
            missing.isEmpty(),
        )
    }
}
