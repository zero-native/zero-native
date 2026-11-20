// Versions pinned to what v0 verified on the Lava Blaze 2 5G (experiments/RESULTS.md).
plugins {
    id("com.android.application") version "9.2.1" apply false
    id("com.android.library") version "9.2.1" apply false
    id("com.android.test") version "9.2.1" apply false
    id("androidx.baselineprofile") version "1.5.0" apply false
    // Also sets the Kotlin compiler version (AGP 9's built-in Kotlin). 2.4+ is needed by Coil 3.6 (2026-10-30).
    id("org.jetbrains.kotlin.plugin.compose") version "2.4.21" apply false
    // Firebase (plugins/firebase-crashlytics, plugins/firebase-messaging). An app applies them only when it has its google-services.json.
    id("com.google.gms.google-services") version "4.5.0" apply false
    id("com.google.firebase.crashlytics") version "3.0.8" apply false
    // Maven Central publishing (docs/publishing-plan.md §2.2, §7). 0.37.0 is tested with AGP 9.2.1 and Gradle 9.6.
    id("com.vanniktech.maven.publish.base") version "0.37.0" apply false
}

// What goes to Maven Central: the runtime and the official plugins, as io.github.zero-native:<project name>.
// device-test is the sample's own test plugin and the sample is an app, so neither is published. One setup for all,
// so the plugins' own build files don't change.
//   ./gradlew publishToMavenLocal          for a check with an app outside the repo (mavenLocal()), nothing signed
//   ./gradlew publishToMavenCentral        the release job (§7): needs the release secrets below; uploads a deployment
//                                          that waits in the Central Portal until a maintainer publishes it
// The version is @zeronative/core's (packages/core/package.json): one version for everything (§6), kept in one place,
// so the release's version check has no Gradle file to change.
val znGroup = "io.github.zero-native"
val znVersion = Regex("\"version\"\\s*:\\s*\"([^\"]+)\"")
    .find(file("../packages/core/package.json").readText())?.groupValues?.get(1)
    ?: error("no version in packages/core/package.json")
subprojects {
    // `p`, not `name` / `file`: inside the nested blocks below those would mean the plugin or the extension.
    val p = this
    val published = p.name == "runtime" || (p.name.startsWith("plugin-") && p.name != "plugin-device-test")
    if (!published) return@subprojects
    group = znGroup
    version = znVersion
    pluginManager.withPlugin("com.android.library") {
        p.apply(plugin = "com.vanniktech.maven.publish.base")
        // A plugin's description is the one in its package.json; the runtime's is written here.
        val packageJson = p.file("../package.json")
        val description = if (p.name == "runtime") {
            "zero-native Android runtime: Hermes, the C++ core and the Compose renderer"
        } else {
            Regex("\"description\"\\s*:\\s*\"([^\"]+)\"").find(packageJson.readText())?.groupValues?.get(1)
                ?: error("${p.name}: no description in $packageJson")
        }
        p.extensions.configure<com.vanniktech.maven.publish.MavenPublishBaseExtension> {
            // Only the release variant (all four CPU types; never a build with -PznArm64Only), with a sources jar and
            // an empty javadoc jar (Central accepts an empty one).
            configure(com.vanniktech.maven.publish.AndroidSingleVariantLibrary(variant = "release"))
            coordinates(znGroup, p.name, znVersion)
            publishToMavenCentral()
            // Signed only when the release key is given (the release job's secrets, as ORG_GRADLE_PROJECT_ variables:
            // signingInMemoryKey, signingInMemoryKeyPassword; and mavenCentralUsername / mavenCentralPassword for
            // the upload). publishToMavenLocal needs none of them.
            if (p.providers.gradleProperty("signingInMemoryKey").isPresent) signAllPublications()
            // A version that comes from a BoM in another module (Firebase's, through plugin-firebase-app) would be
            // missing from the POM. Write the versions the build really used. Gradle apps read the .module file,
            // which keeps the BoM.
            p.extensions.configure<PublishingExtension> {
                publications.withType<MavenPublication>().configureEach {
                    // Android's components don't map with fromResolutionResult(); name the release classpath.
                    versionMapping { allVariants { fromResolutionOf("releaseRuntimeClasspath") } }
                }
            }
            pom {
                this.name.set("zero-native ${p.name}")
                this.description.set(description)
                url.set("https://github.com/zero-native/zero-native")
                inceptionYear.set("2026")
                licenses {
                    license {
                        this.name.set("Apache-2.0")
                        url.set("https://www.apache.org/licenses/LICENSE-2.0.txt")
                        distribution.set("repo")
                    }
                }
                developers {
                    developer {
                        id.set("p2pdops")
                        this.name.set("p2pdops")
                        url.set("https://github.com/p2pdops")
                    }
                }
                scm {
                    url.set("https://github.com/zero-native/zero-native")
                    connection.set("scm:git:https://github.com/zero-native/zero-native.git")
                    developerConnection.set("scm:git:ssh://git@github.com/zero-native/zero-native.git")
                }
            }
        }
    }
}
