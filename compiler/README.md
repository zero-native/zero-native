# @zeronative/compiler

The [zero-native](https://github.com/zero-native/zero-native) compiler: an app's TSX screens become binary
templates (drawn before JS starts) and one JS bundle that Hermes turns into bytecode. It is a Bun plugin and runs on
Bun only. Apps use it through the `zn` command (`@zeronative/cli`), not directly. Apache-2.0.
