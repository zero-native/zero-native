// The Performance plugin's Android side: Firebase Performance Monitoring, bundled (no Gradle plugin needed).
plugins {
    id("com.android.library")
}

android {
    namespace = "dev.zeronative.plugins.perf"
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
    // Also gives Compose's runtime (ZnNav.stack) and coroutines.
    implementation(project(":runtime"))
    // The Firebase version (BoM) comes from plugins/firebase-app.
    implementation(project(":plugin-firebase-app"))
    implementation("com.google.firebase:firebase-perf")
    // The same OkHttp as core (android/runtime): the interceptor goes on core's fetch client.
    implementation("com.squareup.okhttp3:okhttp:5.5.1")
    testImplementation("junit:junit:4.13.2")
}
