// The base of every zero-native Firebase plugin (like RN Firebase's `app` module): the one Firebase version (BoM) they
// all use, the app's Firebase info, and Installations. Other Firebase plugins depend on this project.
plugins {
    id("com.android.library")
}

android {
    namespace = "dev.zeronative.plugins.firebase"
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
    // api: every Firebase plugin and the app take their Firebase versions from this one line.
    api(platform("com.google.firebase:firebase-bom:35.1.0"))
    api("com.google.firebase:firebase-common")
    implementation("com.google.firebase:firebase-installations")
    testImplementation("junit:junit:4.13.2")
}
