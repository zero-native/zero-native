// The webview plugin's Android side.
plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "dev.zeronative.plugins.webview"
    compileSdk = 37

    defaultConfig {
        minSdk = 24
    }

    buildFeatures {
        buildConfig = true // BuildConfig.DEBUG: page debugging, http to this computer and the lab's dead renderer stay out of release builds
        compose = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_21
        targetCompatibility = JavaVersion.VERSION_21
    }
}

dependencies {
    implementation(project(":runtime"))
    // addWebMessageListener, safe browsing on old phones and the renderer calls.
    implementation("androidx.webkit:webkit:1.15.0")
    // BackHandler. Already in every app through the host Activity.
    implementation("androidx.activity:activity-compose:1.13.0")
    testImplementation("junit:junit:4.13.2")
}
