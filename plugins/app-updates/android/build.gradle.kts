// The app-updates plugin's Android side: Google Play's in-app updates (Play Core app-update) on the zero-native runtime.
// Ported from ZeroBill's own plugin (which ported RN's ZInAppUpdatesModule).
plugins {
    id("com.android.library")
}

android {
    namespace = "dev.zeronative.plugins.appupdates"
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
    // The same version as the RN app and ZeroBill's zn plugin. No ktx.
    implementation("com.google.android.play:app-update:2.1.0")
    testImplementation("junit:junit:4.13.2")
}
