// The notifications plugin's Android side: notifications the app shows itself, with Android's NotificationCompat. No
// Firebase and no push service in it (plugins/push adds FCM on top).
plugins {
    id("com.android.library")
}

android {
    namespace = "dev.zeronative.plugins.notifications"
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
    testImplementation("junit:junit:4.13.2")
}
