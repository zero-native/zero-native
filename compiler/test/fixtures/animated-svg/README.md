# Animated SVG corpus (step S.14)

Real animated SVGs from two popular MIT-licensed loader sets, used by `compiler/test/svg-anim.test.ts` to check that
the SMIL / CSS import (`compiler/src/svg-anim.ts`, `docs/svg.md` §15) works on files people actually download.
The files are unchanged copies; each set keeps its licence file next to it.

| Folder | Source | Licence | Files |
|---|---|---|---|
| `svg-spinners/svg-smil` | [n3r4zzurr0/svg-spinners](https://github.com/n3r4zzurr0/svg-spinners) `svg-smil/`, commit `abfa05c` | MIT, Utkarsh Verma (`svg-spinners/LICENSE`) | 46 (SMIL) |
| `svg-spinners/svg-css` | same repo, `svg-css/` | same | 46 (CSS `@keyframes`) |
| `svg-loaders` | [SamHerbert/SVG-Loaders](https://github.com/SamHerbert/SVG-Loaders) `svg-loaders/`, commit `561eaca` | MIT, Sam Herbert (`svg-loaders/LICENSE.md`) | 12 (SMIL) |

Fetched 2026-11-03. Expected result: 95 of 104 compile; the other 9 fail with a hint (filters, dash animations,
stroke width, and growing shapes that have a stroke). The test lists them by name, so a change shows up in review.
