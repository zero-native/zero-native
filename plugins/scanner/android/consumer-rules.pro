# R8 rules for apps that use the scanner plugin (applied to the app's release build).
#
# ML Kit (com.google.mlkit:common) finds its parts through ComponentRegistrar classes, which it creates by reflection
# with their empty constructor. ML Kit pulls in firebase-components 16.1.0, whose rule keeps only the class names.
# In R8 full mode (the default since AGP 8) that also drops the constructors and the methods, so in a release build
# the code reader never starts: "Could not instantiate com.google.mlkit.common.internal.CommonComponentRegistrar",
# and the scanner shows its camera error (found on the Lava with the ZeroBill pilot app, 2026-11-05).
# firebase-components 20.0.0 ships this same rule, so an app that also uses Firebase was fine by accident.
# It keeps only the empty constructor of these few registrar classes (3 for the scanner), nothing else.
-keep class * implements com.google.firebase.components.ComponentRegistrar { void <init>(); }
