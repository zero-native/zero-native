# Loaders from svg-spinners and SVG-Loaders

Animated SVGs used by the SVG lab's Motion section to show that downloaded SMIL / CSS animations play as they are
(`docs/svg.md` §15, §16):

- seven from [n3r4zzurr0/svg-spinners](https://github.com/n3r4zzurr0/svg-spinners) (MIT, Utkarsh Verma, see
  `LICENSE`): `90-ring-with-bg`, `3-dots-bounce`, `bars-scale`, `pulse-rings-multiple`, `wifi`, `bouncing-ball`,
  `ring-resize`;
- three from [SamHerbert/SVG-Loaders](https://github.com/SamHerbert/SVG-Loaders) (MIT, Sam Herbert, see
  `LICENSE-svg-loaders.md`): `puff`, `rings`, `ball-triangle`.

The only change: `fill="currentColor"` or `stroke="currentColor"` on each `<svg>` (in place of black or white), so
`color` can tint them.
