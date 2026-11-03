// The location plugin's Android side. Fixes and the geocoder come from Android's own LocationManager and Geocoder.
plugins {
    id("com.android.library")
}

android {
    namespace = "dev.zeronative.plugins.location"
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
    // Also gives androidx.core (LocationManagerCompat, LocationRequestCompat), through the runtime's androidx.activity.
    implementation(project(":runtime"))
    // Only for Google's "turn on location" dialog (SettingsClient). Fixes don't use Play's fused provider.
    implementation("com.google.android.gms:play-services-location:21.4.0")
    testImplementation("junit:junit:4.13.2")
}
