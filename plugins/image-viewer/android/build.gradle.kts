// The image viewer plugin's Android side. Pictures load with Coil, the same version the runtime ships, so it adds no
// library to the app.
plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "dev.zeronative.plugins.imageviewer"
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
    // The same Coil as the runtime's <Image>: one memory and disk cache, so a picture shown in a list opens at once.
    implementation("io.coil-kt.coil3:coil-compose:3.6.3")
    // Request headers for https pictures (httpHeaders). The runtime ships it with Coil's network loader.
    implementation("io.coil-kt.coil3:coil-network-core:3.6.3")
    // Back closes the viewer (BackHandler). Already in every app (ZnActivity needs it).
    implementation("androidx.activity:activity-compose:1.13.0")
    // The close button's ripple, without Material. The runtime ships it (version from its Compose BOM).
    implementation("androidx.compose.material:material-ripple")
    // EXIF turns for the sharp zoom. Coil 3.6.3 already ships this version.
    implementation("androidx.exifinterface:exifinterface:1.4.2")
    testImplementation("junit:junit:4.13.2")
    // Android's org.json is a stub in JVM unit tests; this is the real one (tests only, as in the runtime).
    testImplementation("org.json:json:20250517")
}
