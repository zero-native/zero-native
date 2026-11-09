// The Remote Config plugin's Android side: Firebase Remote Config, bundled (no Play services needed).
plugins {
    id("com.android.library")
}

android {
    namespace = "dev.zeronative.plugins.firebase.remoteconfig"
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
    // The runtime: ZnModuleBase and the plugin API.
    implementation(project(":runtime"))
    // The Firebase version (BoM) comes from plugins/firebase-app.
    implementation(project(":plugin-firebase-app"))
    implementation("com.google.firebase:firebase-config")
    testImplementation("junit:junit:4.13.2")
}
