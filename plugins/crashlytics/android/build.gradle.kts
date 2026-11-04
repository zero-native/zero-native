// The Crashlytics plugin's Android side: Firebase Crashlytics, bundled (no Play services needed).
// Native crashes (Hermes, C++) need firebase-crashlytics-ndk too: the app adds it itself, opt-in (README).
plugins {
    id("com.android.library")
}

android {
    namespace = "dev.zeronative.plugins.crashlytics"
    compileSdk = 37

    defaultConfig {
        minSdk = 24
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_21
        targetCompatibility = JavaVersion.VERSION_21
    }
}

dependencies {
    // Also gives Compose's runtime (the top route, ZnNav.stack) and coroutines.
    implementation(project(":runtime"))
    // api: the app's own Crashlytics calls (and the opt-in -ndk line) take versions from the same BoM.
    api(platform("com.google.firebase:firebase-bom:35.1.0"))
    api("com.google.firebase:firebase-crashlytics")
    testImplementation("junit:junit:4.13.2")
}
