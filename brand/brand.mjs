/**
 * The Fourier brand, as data.
 *
 * Every logo, icon and favicon in this repository is derived from the numbers
 * below rather than drawn by hand, so the mark stays identical at 16px and at
 * 1200px and nothing drifts when a colour changes. `generate.mjs` turns this
 * into the SVG, PNG and ICO files that ship.
 */

/**
 * The palette. Three colours for now — this is deliberately small and will
 * grow. `ink` values are the same hue pushed darker so the mint stays legible
 * on a light background, where pure #00FFAE is close to invisible.
 */
export const palette = {
  onyx: "#141414",
  platinum: "#EEF0F2",
  mint: "#00FFAE",
  /** Mint at oklch L=0.62 — contrast-safe on white, for text, lines and charts. */
  mintInk: "#00A069",
  /** Mint at oklch L=0.75 — a mid step, for hovers and secondary marks. */
  mintDeep: "#00CE8A",
  paper: "#FFFFFF",
};

/** The same palette in oklch, which is what the app's CSS variables speak. */
export const paletteOklch = {
  onyx: "oklch(0.1913 0 0)",
  platinum: "oklch(0.9542 0.0034 247.86)",
  mint: "oklch(0.8833 0.1959 161.25)",
  mintInk: "oklch(0.6200 0.1470 161.25)",
  mintDeep: "oklch(0.7500 0.1740 161.25)",
  paper: "oklch(1 0 0)",
};

/**
 * The mark: three bars in a 64×64 box, exactly as drawn. The outer two share a
 * baseline and the middle one is lifted — a spectrum, which is the whole joke
 * of the name.
 */
export const VIEWBOX = 64;
export const bars = [
  { x: 15, y: 14, w: 6, h: 42, r: 1 },
  { x: 25, y: 6, w: 9, h: 42, r: 1 },
  { x: 38, y: 14, w: 13, h: 42, r: 1 },
];

/** The mark's true bounding box, which is not centred in the 64×64 box. */
export const markBox = { x: 15, y: 6, w: 36, h: 50 };

/** Rounded-square tile geometry, as fractions of the tile's edge. */
export const tile = {
  /** Corner radius. 22% reads as "app icon" without imitating a squircle. */
  radius: 0.21875,
  /** How tall the mark stands in a normal tile. */
  markHeight: 0.53125,
  /**
   * How tall it stands in an Android maskable icon, where the outer 20% can be
   * cropped to any shape the launcher likes.
   */
  maskableMarkHeight: 0.375,
};

/**
 * How tall the mark should stand at a given icon size.
 *
 * The normal 53% is right from 32px up. At 16px it puts the narrow bar under a
 * pixel wide, and once the rasteriser snaps that to 1px the middle bar snaps
 * to 1px too — three bars that should read 1:1.5:2.2 all come out the same
 * width and the mark turns into a picket fence. Standing the mark taller in a
 * tighter tile keeps the widths at a legible 1:2:3.
 */
export function markHeightFor(size) {
  return size <= 20 ? 0.72 : tile.markHeight;
}

/**
 * Place the mark inside a square of `size`, optically centred, at `heightRatio`
 * of the square's height. Returns the bars in the square's coordinates.
 */
export function layoutMark(size, heightRatio = tile.markHeight) {
  const scale = (size * heightRatio) / markBox.h;
  const tx = size / 2 - (markBox.x + markBox.w / 2) * scale;
  const ty = size / 2 - (markBox.y + markBox.h / 2) * scale;
  return bars.map((b) => ({
    x: b.x * scale + tx,
    y: b.y * scale + ty,
    w: b.w * scale,
    h: b.h * scale,
    r: b.r * scale,
  }));
}

/** The bars alone, in the 64×64 box, ready to drop inside an <svg>. */
export function barsMarkup(fill, indent = "  ") {
  return bars
    .map((b) => `${indent}<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="${b.r}" fill="${fill}"/>`)
    .join("\n");
}

function round(n) {
  return Number(n.toFixed(3));
}

/** A square icon: the mark on a rounded tile, as SVG source. */
export function iconSvg({ fg, bg, size = VIEWBOX, radius = tile.radius, heightRatio = tile.markHeight, rounded = true }) {
  const laid = layoutMark(size, heightRatio);
  const r = rounded ? round(size * radius) : 0;
  const rects = laid
    .map((b) => `  <rect x="${round(b.x)}" y="${round(b.y)}" width="${round(b.w)}" height="${round(b.h)}" rx="${round(b.r)}" fill="${fg}"/>`)
    .join("\n");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img" aria-label="Fourier">
  <rect width="${size}" height="${size}"${r ? ` rx="${r}"` : ""} fill="${bg}"/>
${rects}
</svg>
`;
}

/** The bare mark, inheriting colour from whatever it sits in. */
export function markSvg(fill = "currentColor") {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${VIEWBOX}" height="${VIEWBOX}" viewBox="0 0 ${VIEWBOX} ${VIEWBOX}" fill="none" role="img" aria-label="Fourier">
${barsMarkup(fill)}
</svg>
`;
}

/**
 * The horizontal lockup: mark, then wordmark.
 *
 * The text is live rather than outlined, so it sets in Geist wherever Geist is
 * loaded — the app — and in a near neighbour everywhere else. Where no font
 * stack can be trusted (a README, a social card) use the baked PNGs instead.
 */
export const wordmark = {
  fontStack: "Geist, 'Geist Sans', Inter, system-ui, -apple-system, 'Helvetica Neue', Arial, sans-serif",
  weight: 500,
  tracking: -0.02,
  /**
   * Metrics for "Fourier", in em, measured off a Helvetica-class face at
   * weight 500 with the tracking above. Geist lands within a couple of percent,
   * which only ever shows up as a hair of slack on the right of the box.
   */
  capHeight: 0.72,
  /** The "F" does not start at the text origin; the gap has to allow for that. */
  sideBearing: 0.075,
  /** Text origin to the right edge of the final "r". */
  advance: 3.145,
};

/**
 * Where everything sits in a lockup, given a font size. The mark stands a
 * little taller than the capitals, the way it does in the source artwork, and
 * the gap is measured from ink to ink rather than from box to box.
 */
export function lockupParts(fontSize, padding = 0) {
  const markH = fontSize * 0.86;
  const markW = (markH * markBox.w) / markBox.h;
  const gap = fontSize * 0.32;
  const height = Math.round(markH + padding * 2);
  const textX = padding + markW + gap - wordmark.sideBearing * fontSize;
  return {
    markH,
    markW,
    height,
    markX: padding,
    markY: (height - markH) / 2,
    textX,
    baseline: height / 2 + (wordmark.capHeight * fontSize) / 2,
    width: Math.ceil(textX + wordmark.advance * fontSize + padding),
  };
}

export function lockupSvg({ fg, bg = null, markFill = null, fontSize = 48, fontStack = wordmark.fontStack }) {
  const pad = bg ? fontSize * 0.42 : 0;
  const p = lockupParts(fontSize, pad);
  const scale = p.markH / markBox.h;
  const rects = bars
    .map((b) =>
      `  <rect x="${round((b.x - markBox.x) * scale + p.markX)}" y="${round((b.y - markBox.y) * scale + p.markY)}" width="${round(b.w * scale)}" height="${round(b.h * scale)}" rx="${round(b.r * scale)}" fill="${markFill ?? fg}"/>`,
    )
    .join("\n");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${p.width}" height="${p.height}" viewBox="0 0 ${p.width} ${p.height}" fill="none" role="img" aria-label="Fourier">
${bg ? `  <rect width="${p.width}" height="${p.height}" fill="${bg}"/>\n` : ""}${rects}
  <text x="${round(p.textX)}" y="${round(p.baseline)}" font-family="${fontStack}" font-size="${fontSize}" font-weight="${wordmark.weight}" letter-spacing="${wordmark.tracking}em" fill="${fg}">Fourier</text>
</svg>
`;
}
