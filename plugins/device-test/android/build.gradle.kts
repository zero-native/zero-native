// The device-test plugin's Android side: a small library on top of the runtime. Copy this for a new plugin.
plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.plugin.compose") // only for a plugin with native screens or views
}

android {
    namespace = "dev.zeronative.plugins.devicetest"
    compileSdk = 37

    defaultConfig {
        minSdk = 24
    }

    buildFeatures {
        buildConfig = true // BuildConfig.DEBUG keeps the crash and mock UPI functions out of release builds
        compose = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_21
        targetCompatibility = JavaVersion.VERSION_21
    }
}

dependencies {
    implementation(project(":runtime"))
}
