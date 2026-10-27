# The story of zero-native

## Before zero-native

ZeroBill is a payments and cashback app used in India, mostly on low-end Android phones. Over the years we built it
again and again, each time on what looked like the right tool.

1. **Android XML views and Java.** The first version.
2. **Jetpack Compose and Kotlin.** A rewrite for modern Android: declarative UI, state in, screen out.
3. **Flutter**, for Android and iOS from one code base. Its ideas felt close to Compose. It drew the app exactly as
   designed. But Crashlytics kept showing Dart errors that the compiler never caught.

The bigger problem with Flutter was over-the-air updates (OTA). ZeroBill has two moving parts:

- a **payment flow** that moves slowly and must not break, and
- **stores and offers screens** that change all the time and need fresh content.

So we moved the fast-changing screens into a small React web app that ran inside a Flutter WebView. That solved part
of it, but the slowdown was clear on old, low-end phones, and those phones are most of our users.

4. **React Native.** It solved the problems we had: native-looking UI, OTA, a big ecosystem. It also brought its own:
   - A large app. We optimised it, but it stayed large.
   - Dependencies with little return (Reanimated, worklets, Nitro modules). They added size and, worse, start-up
     time: many native modules to load, many of them depending on each other.
   - We chose bare React Native. No OTA library that was well maintained fit our needs, so we built our own. And OTA
     had a compatibility problem nobody had solved: a bundle could not say which native code it needed, so the only
     safe rule was "same native build, or nothing".

## A Wednesday question

One random Wednesday, 2026-10-27, Pavan asked Gemini 4 Argon:

> If you were a senior software engineer who worked on React Native or Flutter in their early days, and now it is
> 2026, what is one thing you would do differently from first principles? Use what we learned from native
> declarative UI like Compose and SwiftUI, and remember that we want interfaces that can be updated over the air.

Its first answer is in [`experiments/gemini4argon-1st-reply.md`](experiments/gemini4argon-1st-reply.md). That answer is
where this project began.

_The rest of the story is written at the end of this history._
