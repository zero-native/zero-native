// The auth plugin's Android side.
plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "dev.zeronative.plugins.auth"
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
    // The phone number hint (Identity).
    implementation("com.google.android.gms:play-services-auth:21.5.0")
    // The SMS Retriever.
    implementation("com.google.android.gms:play-services-auth-api-phone:18.0.2")
    testImplementation("junit:junit:4.13.2")
}
