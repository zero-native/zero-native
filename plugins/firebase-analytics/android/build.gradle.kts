// The Analytics plugin's Android side: Google Analytics for Firebase. It is bundled, but on a phone with Play services
// Firebase hands the events to Play services' own measurement service (fewer uploads, less battery).
plugins {
    id("com.android.library")
}

android {
    namespace = "dev.zeronative.plugins.firebase.analytics"
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
    // The Firebase version (BoM) comes from plugins/firebase-app.
    implementation(project(":plugin-firebase-app"))
    implementation("com.google.firebase:firebase-analytics")
    testImplementation("junit:junit:4.13.2")
}
