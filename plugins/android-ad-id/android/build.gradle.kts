// The ad-id plugin's Android side: the Google advertising id, from Google Play services.
plugins {
    id("com.android.library")
}

android {
    namespace = "dev.zeronative.plugins.android.adid"
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
    // Talks to Play services on the phone (nothing is downloaded at run time). Its manifest adds
    // com.google.android.gms.permission.AD_ID. 18.0.0: the version Firebase Analytics brings too.
    implementation("com.google.android.gms:play-services-ads-identifier:18.0.0")
    testImplementation("junit:junit:4.13.2")
}
