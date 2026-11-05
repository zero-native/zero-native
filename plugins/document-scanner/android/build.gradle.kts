// The document scanner plugin's Android side.
plugins {
    id("com.android.library")
}

android {
    namespace = "dev.zeronative.plugins.documentscanner"
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
    implementation(project(":runtime"))
    // NOT bundled: ML Kit has no bundled document scanner. The scanner (models, screens) is a Google Play services
    // module that Play downloads the first time; this library is only the small client. The one exception to our
    // "bundle, don't download from Play" rule (Pavan, 2026-11-05; docs/second-opinions.md entry 139).
    implementation("com.google.android.gms:play-services-mlkit-document-scanner:16.0.0")
    testImplementation("junit:junit:4.13.2")
    // Android's org.json is a stub in JVM unit tests; this is the real one.
    testImplementation("org.json:json:20250517")
}
