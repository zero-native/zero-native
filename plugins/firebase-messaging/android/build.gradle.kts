// The push plugin's Android side: Firebase Cloud Messaging (bundled; receiving needs the phone's own Play services).
// Notifications are plugins/notifications, which this plugin adds.
plugins {
    id("com.android.library")
}

android {
    namespace = "dev.zeronative.plugins.firebase.messaging"
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
    // Notifications and PushEvents (the path every push service's messages take to JS). No Firebase in it.
    // `api`: this plugin hands Notifications on to the app (PushPlugin() adds NotificationsPlugin()), so the app's
    // manifest can name its classes (ZnNotificationBoot) and lint finds them.
    api(project(":plugin-notifications"))
    // The Firebase version (BoM) comes from plugins/firebase-app.
    implementation(project(":plugin-firebase-app"))
    implementation("com.google.firebase:firebase-messaging")
    testImplementation("junit:junit:4.13.2")
}
