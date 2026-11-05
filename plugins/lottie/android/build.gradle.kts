// The lottie plugin's Android side: Airbnb's lottie-compose, inside the APK (nothing is downloaded from Play).
plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "dev.zeronative.plugins.lottie"
    compileSdk = 37

    defaultConfig {
        minSdk = 24
    }

    buildFeatures {
        compose = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_21
        targetCompatibility = JavaVersion.VERSION_21
    }
}

dependencies {
    implementation(project(":runtime"))
    // The same Lottie as lottie-react-native 7.x on Android (6.x), so the same files draw the same. 6.7.1: 2025-10-31.
    // It brings `lottie` (the parser and drawing) and appcompat 1.6.1; R8 drops what the app doesn't use.
    implementation("com.airbnb.android:lottie-compose:6.7.1")
    // LocalLifecycleOwner, to read the animator scale again when the app comes back. Already in every app (ZnActivity).
    implementation("androidx.activity:activity-compose:1.13.0")
    testImplementation("junit:junit:4.13.2")
}
