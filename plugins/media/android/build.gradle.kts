// The media plugin's Android side.
plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "dev.zeronative.plugins.media"
    compileSdk = 37

    defaultConfig {
        minSdk = 24
    }

    buildFeatures {
        buildConfig = true // BuildConfig.DEBUG keeps the test photo functions out of release builds
        compose = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_21
        targetCompatibility = JavaVersion.VERSION_21
    }
}

dependencies {
    implementation(project(":runtime"))
    // Reads the photo's rotation. Android's own class has bugs on old phones. Already in every app through Coil.
    implementation("androidx.exifinterface:exifinterface:1.4.2")
    testImplementation("junit:junit:4.13.2")
    // Android's org.json is a stub in JVM unit tests; this is the real one.
    testImplementation("org.json:json:20250517")
}
