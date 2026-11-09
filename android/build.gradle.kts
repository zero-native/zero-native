// Versions pinned to what v0 verified on the Lava Blaze 2 5G (docs/v0-findings.md §A).
plugins {
    id("com.android.application") version "9.2.1" apply false
    id("com.android.library") version "9.2.1" apply false
    id("com.android.test") version "9.2.1" apply false
    id("androidx.baselineprofile") version "1.5.0" apply false
    // Also sets the Kotlin compiler version (AGP 9's built-in Kotlin). 2.4+ is needed by Coil 3.6 (2026-10-30).
    id("org.jetbrains.kotlin.plugin.compose") version "2.4.21" apply false
    // Firebase (plugins/firebase-crashlytics, plugins/firebase-messaging). An app applies them only when it has its google-services.json.
    id("com.google.gms.google-services") version "4.5.0" apply false
    id("com.google.firebase.crashlytics") version "3.0.8" apply false
}
