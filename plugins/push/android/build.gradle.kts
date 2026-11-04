// The push plugin's Android side: Firebase Cloud Messaging (bundled; receiving needs the phone's own Play services) and
// notifications shown with Android's NotificationCompat.
plugins {
    id("com.android.library")
}

android {
    namespace = "dev.zeronative.plugins.push"
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
    // Also gives androidx.core (NotificationCompat, NotificationManagerCompat), through the runtime's androidx.activity.
    implementation(project(":runtime"))
    implementation(platform("com.google.firebase:firebase-bom:35.1.0"))
    implementation("com.google.firebase:firebase-messaging")
    testImplementation("junit:junit:4.13.2")
}
