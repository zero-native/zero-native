// The scanner plugin's Android side.
plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "dev.zeronative.plugins.scanner"
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
    // The same CameraX as the React Native app (react-native-camera-kit), so the same phones are known to work.
    val camerax = "1.4.2"
    implementation("androidx.camera:camera-camera2:$camerax")
    implementation("androidx.camera:camera-lifecycle:$camerax")
    implementation("androidx.camera:camera-view:$camerax")
    // Bundled: the model is inside the APK. NOT play-services-mlkit-barcode-scanning, whose download fails on full phones.
    implementation("com.google.mlkit:barcode-scanning:17.3.0")
    // The permission dialog from Compose. Already in every app (ZnActivity needs it).
    implementation("androidx.activity:activity-compose:1.13.0")
    testImplementation("junit:junit:4.13.2")
}
