// The device-info plugin's Android side: react-native-device-info's values, from Android's own APIs (no extra library).
plugins {
    id("com.android.library")
}

android {
    namespace = "dev.zeronative.plugins.deviceinfo"
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
    testImplementation("junit:junit:4.13.2")
}
