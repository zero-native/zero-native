# Zero-Native Experimental Spikes & Capability Prototypes

This directory contains standalone, on-device empirical prototypes and architectural analyses validating core capabilities of the **Zero-Native (`zn`)** framework on physical hardware (Lava Blaze 2 5G, Dimensity 6020, Android 14).

---

## 🍽️ The Three Prepared Dishes

### 1. [Dish B: Sub-Second Fast Refresh via Bun & Hermes Bytecode Streaming](dish-b-fast-refresh.md)
* **Goal:** Zero-delay developer experience without Activity restarts or Metro bundler latency.
* **Result:** **127 ms end-to-end save-to-screen latency** (vs. 1,500–4,500 ms in React Native Metro).
* **Key Innovation:** Host-side `Bun.build` (5 ms) + `hermesc -O` (74 ms) streams pre-compiled `.hbc` over WebSocket to device. On-device Hermes teardown & reboot takes **1.2 ms**. Jetpack Compose invalidates and re-draws via `key(NodeStore.treeVersion.value)`.
* **Hardware Verified:** Live on physical phone with multiple real-time UI text/color edits retaining PID `31939`.

---

### 2. [Dish C: PrimJS (Lynx / ByteDance) vs. Hermes V1 Architectural Deep-Dive](dish-c-primjs-analysis.md)
* **Goal:** Evaluate whether TikTok/CapCut's PrimJS engine offers startup or runtime advantages over Meta's Hermes V1.
* **Verdict:** **Strictly Stay on Hermes V1.**
* **Decisive Finding:** Lynx requires PrimJS on the UI thread for "Main-Thread Scripting" (MTS) to handle gestures. In Zero-Native, **MTS is not needed because Jetpack Compose runs natively on the Android UI thread with hardware spring physics.** Hermes's zero-copy `mmap` code loading, superior JSI ergonomics, and rock-solid toolchain make it strictly superior.

---

### 3. [Dish A: 90Hz / 120Hz Zero-JSON Virtual List (1,000 Items)](dish-a-virtual-list.md)
* **Goal:** Eliminate the React Native `FlatList` white-flash / bridge serialization bottleneck for heavy transaction history screens (Passbook).
* **Result:** **4.0 ms p50 GPU frame time** at **90.0 Hz display mode** across 1,000 items with **0% white flashes** and **0% JS thread load during scroll**.
* **Key Innovation:** Compose's native `LazyColumn` pools and renders only the 9–10 visible rows on screen (17.5 KB RenderNode capacity), completely isolating scrolling from the JS thread.

