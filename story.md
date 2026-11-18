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

## Two models argue, one engineer decides (2026-10-27)

Argon's answer was bold. Drop the virtual DOM and the widget tree: Compose and SwiftUI already know, at compile time,
what can change. Send a compiled description of the UI plus a small logic bundle over the air, not a whole UI runtime.
Its follow-up spec ([`experiments/intro.md`](experiments/intro.md), [`intro2.md`](experiments/intro2.md)) went much
further, with a three-way compiler, a Rust layout engine, TypeScript compiled to Wasm, and resumable functions. It
named the project **zero-native**.

That same evening Claude Opus 5.5 read the spec and turned it into something that could be built:
[ARCHITECTURE.md](ARCHITECTURE.md). Argon reviewed the plan twice, and the two disagreed in writing
([`experiments/argon-to-opus-revert.md`](experiments/argon-to-opus-revert.md)). What was kept: a compiled template so
the screen can be drawn before JS starts, slots instead of a tree diff, and the name. What was dropped: Wasm (iOS
forbids JIT), the custom layout engine, resumable generators (unsafe across an OTA update), and every speed number
nobody had measured. Argon won some points: state is saved in a memory-mapped two-slot file, not plain file writes,
and small updates use integer slot ids, not JSON. Hermes stayed as the JS engine, behind a small interface.

## Four experiments in one night (2026-10-27 and 28)

Gemini 3.8 Flash then built four small apps to check the riskiest ideas on a real low-end phone, a Lava Blaze 2 5G:

1. **Size.** Compose, Hermes, ML Kit and Firebase without React Native: a 6.42 MB Play download, against 14.88 MB
   for the React Native build of the app.
2. **Renderer.** Hermes alone driving Compose: a keypad tap updated the screen in 0.97 ms (p50), and only the
   changed text was redrawn.
3. **Leaving for a UPI app.** Compose keeps drawing while the UPI app's dialog covers it, so no tricks were needed.
4. **Process death.** A payment flow saved to disk survived Android killing the app in 17 scenarios, never sending a
   second payment request. It also found a timer bug ("zombie timers") that shaped the design.

The next morning Flash tried Argon's chained modifiers. They caused bugs that depended on call order, so we chose
React Native-style `style` props with one fixed order owned by the renderer.

## Foundations in three days (2026-10-29 to 31)

With the experiments passed, the real repository started. Opus built the C++ core around Hermes, the TSX compiler,
the binary template format and the Compose renderer. A first screen started cold in about 200 ms on the Lava. Then
an app's needs, step by step: routes and navigation, virtual lists, sheets, native modules, live reload, `fetch`,
storage, animation, and error screens that keep the app alive.

On 2026-10-30 came the decision that answers the old React Native OTA problem. An update no longer has to match the
store build's native code exactly. Each bundle lists what it needs (registry version, bytecode format, host API,
native modules), each app lists what it has, and a phone only takes a bundle it can run. Signed bundles, signed
channel pointers, a release CLI, a reference server, updates applied while the app runs, and crash traces mapped back
to TSX were done by the next night.

## The real app (2026-11-02 to 07)

Outside reviews (Gemini 4 Argon, Claude Fable) led to a hardening pass and a plugin system: native modules, native
views and native screens. Then the ZeroBill app was ported from React Native screen by screen. Every gap it hit
became a framework feature: SVG, bottom tabs, pull to refresh, Lottie, Markdown, PDF, scanners, location, Firebase,
OTP input, a splash that waits for the first screens. The hard bugs came from real phones and real payments: a
connection that went silent after a trip to a UPI app, a sheet that swallowed the next tap, answers lost when Android
restarted the app.

## For everyone, not only for us

Along the way it became clear that this framework is not only for ZeroBill. The cheapest path for other teams is to
write what they already know. So zero-native took React Native's names where they make sense (`View`, `FlatList`,
`onPress`, `Modal`, `StatusBar`, `Linking` and more), and anything it does not support became a build error instead
of a silent difference. Gemini 3.8 Flash built two parity batches (WebSocket, fetch progress, Canvas, dynamic layout),
and Opus reviewed and fixed them.

## iOS in three days (2026-11-08 to 10)

All the Android lessons were written down, so the iOS port went quickly. Opus, on a Mac, ran the C++ core and Hermes
on the iOS simulator in the first hours, drew screens with SwiftUI, and used UIKit for the hard parts: lists, sheets,
navigation and text fields. Plugins, deep links, state restoration, push notifications and OTA updates followed. A
layout lab of 95 cases compared iOS with Android until they matched. Bugs found on one platform were checked on the
other, both ways.

The same days brought motion and gestures (motion values, gestures, shared elements, on the UI thread, reviewed by
Argon), our own update server `zn-updates` with a dashboard where releases are signed in the browser, bsdiff patches
of 3 to 93 KB, and bundle needs per OS.

## Shipping (2026-11-10 onwards)

On 2026-11-10 the ZeroBill app built on zero-native went to Google Play, and the iOS app was submitted to the App Store.
On the same Lava phone the full app starts in about 500 ms; the React Native app took 1,147 ms. A list that lagged
on an Android 9 phone became smooth once the runtime shipped its own baseline profile.

## What we learned

- **Know at build time what you can.** Templates, slots and per-bundle needs all come from the compiler, and that is
  what makes the screens fast and OTA updates safe.
- **OTA is a contract, not a file copy.** A bundle must say what it needs, and a phone must refuse what it can't run.
- **Test on the cheap phone.** Most of our users have one, and most of our bugs only showed up there.
- **The app will be killed.** Flows, answers and screens must come back as they were.
- **Meet developers where they are.** Familiar names and loud build errors cost little and save a lot.

## Credits

Pavan built zero-native with AI models: **Gemini 4 Argon** (the idea and design reviews), **Gemini 3.8 Flash**
(the v0 experiments and parity batches), **Claude Opus 5.5** (the spec and most of the code, Android and iOS) and
**Claude Fable** (reviews). Each commit in this history names the models that worked on it.
