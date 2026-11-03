# Still and animated SVG features corpus (registry 13)

Real files that use the features added in registry 13 (`docs/svg.md` §17): filters, masks, patterns, focal points,
markers, blend modes, `paint-order`, nested `<svg>`, `<switch>`, `<text>`, and line-md / Meteocons animations. Used by
`compiler/test/svg.test.ts` ("the registry 13 corpus"). The files are unchanged copies; each set keeps its licence file
(`LICENSE.txt`) next to it. Picked by a corpus survey on 2026-11-03.

| Folder | Source | Licence | Files |
|---|---|---|---|
| `resvg` | [linebender/resvg](https://github.com/linebender/resvg) `crates/resvg/tests/tests`, commit `cd64e51` | MIT OR Apache-2.0, the Resvg Authors | 42 (one feature each) |
| `weather-icons` | Meteocons, npm `@meteocons/svg` 3.0.0-next.10, from [basmilius/weather-icons](https://github.com/basmilius/weather-icons) | MIT, Bas Milius | 12 (`fill/`, `line/`) |
| `line-md` | [cyberalien/line-md](https://github.com/cyberalien/line-md) `svg/`, commit `2ed2255` | MIT, Vjacheslav Trushkin | 18 (SMIL; `svg-style/` with CSS) |
| `fluentui-emoji` | [microsoft/fluentui-emoji](https://github.com/microsoft/fluentui-emoji) colour assets | MIT, Microsoft Corporation | 6 |

Expected result: 75 of 78 compile. The other 3 fail with a hint, on purpose (the test lists them by name):
- `resvg/filters/feComposite/operator=arithmetic.svg`: arithmetic with any k1..k4 (only the sum and Figma's inner shadow).
- `resvg/text/text/dx-and-dy-with-multiple-values.svg`: `dx` / `dy` with one value per character.
- `resvg/text/text/rotate.svg`: `rotate` on `<text>`.
