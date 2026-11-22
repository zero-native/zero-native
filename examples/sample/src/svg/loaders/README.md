# Loaders from svg-spinners and SVG-Loaders

Animated SVGs used by the SVG lab's Motion section to show that downloaded SMIL / CSS animations play as they are
(`docs/svg.md` §15, §16):

- nine from [n3r4zzurr0/svg-spinners](https://github.com/n3r4zzurr0/svg-spinners) (MIT, Utkarsh Verma, see
  `LICENSE`): `90-ring-with-bg`, `3-dots-bounce`, `bars-scale`, `pulse-rings-multiple`, `wifi`, `bouncing-ball`,
  `ring-resize`, and the two filtered ones in the Filters section, `gooey-balls-1` and `gooey-balls-2` (a blur, an
  alpha matrix and a blend melt the balls together; their SMIL copies from `compiler/test/fixtures`);
- three from [SamHerbert/SVG-Loaders](https://github.com/SamHerbert/SVG-Loaders) (MIT, Sam Herbert, see
  `LICENSE-svg-loaders.md`): `puff`, `rings`, `ball-triangle`.

The only change: `fill="currentColor"` or `stroke="currentColor"` on each `<svg>` (in place of black or white), so
`color` can tint them.
