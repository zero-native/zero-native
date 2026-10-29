# Sample app rules. Runtime rules come from the runtime library's consumer-rules.pro.

# The sample is never published. Keep class and method names so release stack traces stay readable, while R8 still
# shrinks code (so release-only problems, like removed classes, still show up).
-dontobfuscate
