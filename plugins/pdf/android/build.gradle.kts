// The pdf plugin's Android side. Drawing is Android's own PdfRenderer: no PDF library.
plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "dev.zeronative.plugins.pdf"
    compileSdk = 37

    defaultConfig {
        minSdk = 24
    }

    buildFeatures {
        buildConfig = true // BuildConfig.DEBUG: http to this computer and debugZoom stay out of release builds
        compose = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_21
        targetCompatibility = JavaVersion.VERSION_21
    }
}

dependencies {
    implementation(project(":runtime"))
    // Only to compile against ZnFetch.client, so downloads get the app's own OkHttp setup (pinning, interceptors). The
    // runtime already ships this same version, so it adds nothing to the app (docs/second-opinions.md entry 80).
    implementation("com.squareup.okhttp3:okhttp:5.5.1")
    testImplementation("junit:junit:4.13.2")
}
