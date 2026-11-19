# @zeronative/template

The component registry of [zero-native](https://github.com/zero-native/zero-native): every element, its props and
their binary ids, shared by the compiler (which writes templates) and the runtime (which reads them). Apps don't
import it; `@zeronative/compiler` does.

The rules for changing it, so OTA bundles keep running on older apps:
[docs/adding-components.md](https://github.com/zero-native/zero-native/blob/main/docs/adding-components.md).
Apache-2.0.
