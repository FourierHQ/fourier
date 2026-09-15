#!/usr/bin/env node
/**
 * Builds every brand asset in the repository from `brand.mjs`.
 *
 *   pnpm brand
 *
 * Icons, favicons and app icons are pure Node and run anywhere. The two assets
 * that carry the wordmark as pixels — the README lockups and the social card —
 * need a text rasteriser, and macOS ships one (`sips`), so those are skipped
 * with a note on other platforms. Everything is committed, so a clean checkout
 * never has to run this.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { iconSvg, lockupParts, lockupSvg, markHeightFor, markSvg, markBox, bars, palette, layoutMark, tile } from "./brand.mjs";
import { encodeIco, encodePng, render } from "./raster.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const web = join(root, "apps", "web");
const demo = join(root, "examples", "nextjs-demo");

const written = [];
function write(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
  written.push(path.replace(root + "/", ""));
}

/** One square icon as PNG bytes. */
function iconPng(size, { fg, bg, rounded = true, heightRatio }) {
  const ratio = heightRatio ?? markHeightFor(size);
  const shapes = [];
  if (bg) shapes.push({ x: 0, y: 0, w: size, h: size, r: rounded ? size * tile.radius : 0, fill: bg });
  for (const b of layoutMark(size, ratio)) shapes.push({ ...b, fill: fg });
  // Below 32px every edge has to land on a pixel boundary or the bars blur.
  const pixels = render(size, size, shapes, { samples: size <= 64 ? 16 : 8, pixelSnap: size <= 32 });
  return encodePng(size, size, pixels);
}

const mintOnOnyx = { fg: palette.mint, bg: palette.onyx };
const onyxOnPlatinum = { fg: palette.onyx, bg: palette.platinum };

// ---------------------------------------------------------------- brand/
write(join(here, "mark.svg"), markSvg());
write(join(here, "icon-mint-on-onyx.svg"), iconSvg(mintOnOnyx));
write(join(here, "icon-onyx-on-platinum.svg"), iconSvg(onyxOnPlatinum));
write(join(here, "lockup-on-onyx.svg"), lockupSvg({ fg: palette.platinum, markFill: palette.mint, bg: palette.onyx }));
write(join(here, "lockup-on-platinum.svg"), lockupSvg({ fg: palette.onyx, markFill: palette.mintInk, bg: palette.platinum }));
write(join(here, "lockup-mono.svg"), lockupSvg({ fg: "currentColor" }));

// ------------------------------------------------------- apps/web (mint)
write(
  join(web, "app", "favicon.ico"),
  encodeIco([16, 32, 48].map((size) => ({ size, png: iconPng(size, mintOnOnyx) }))),
);
write(join(web, "app", "icon.svg"), iconSvg(mintOnOnyx));
// iOS applies its own mask, so this one is square to the edge.
write(join(web, "app", "apple-icon.png"), iconPng(180, { ...mintOnOnyx, rounded: false }));
write(join(web, "public", "icon-192.png"), iconPng(192, mintOnOnyx));
write(join(web, "public", "icon-512.png"), iconPng(512, mintOnOnyx));
// Android may crop a maskable icon to any shape inside the outer 20%.
write(
  join(web, "public", "icon-maskable-512.png"),
  iconPng(512, { ...mintOnOnyx, rounded: false, heightRatio: tile.maskableMarkHeight }),
);

// ------------------------------------------------ examples/nextjs-demo (onyx)
write(
  join(demo, "app", "favicon.ico"),
  encodeIco([16, 32, 48].map((size) => ({ size, png: iconPng(size, onyxOnPlatinum) }))),
);
write(join(demo, "app", "icon.svg"), iconSvg(onyxOnPlatinum));
write(join(demo, "app", "apple-icon.png"), iconPng(180, { ...onyxOnPlatinum, rounded: false }));

// ------------------------------------------------------- wordmark rasters
const hasSips = (() => {
  try {
    execFileSync("sips", ["--help"], { stdio: "ignore" });
    return process.platform === "darwin";
  } catch {
    return false;
  }
})();

/** Rasterise an SVG through macOS ImageIO, which has real fonts. */
function svgToPng(svg, out) {
  const tmp = join(here, ".tmp.svg");
  writeFileSync(tmp, svg);
  try {
    execFileSync("sips", ["-s", "format", "png", tmp, "--out", out], { stdio: "ignore" });
    written.push(out.replace(root + "/", ""));
  } finally {
    rmSync(tmp, { force: true });
  }
}

/**
 * The wordmark as pixels, for README-shaped places where no font stack can be
 * relied on. Helvetica Neue is the closest face macOS ships to Geist; the live
 * SVG lockups and the in-app component use the real thing.
 */
const bakedStack = "Helvetica Neue, Helvetica, Arial, sans-serif";

/**
 * The wordmark as pixels, for README-shaped places where no font stack can be
 * relied on. Helvetica Neue is the closest face macOS ships to Geist; the live
 * SVG lockups and the in-app component use the real thing.
 */
function bakedLockup(opts) {
  return lockupSvg({ ...opts, fontStack: bakedStack });
}

/** 1200×630, the size every social card unfurls at. */
function socialCard() {
  const W = 1200;
  const H = 630;
  const margin = 88;
  const F = 108;
  const p = lockupParts(F);
  const scale = p.markH / markBox.h;
  const top = 196; // the lockup's own top edge
  const rects = bars.map(
    (b) =>
      `<rect x="${((b.x - markBox.x) * scale + margin).toFixed(2)}" y="${((b.y - markBox.y) * scale + top).toFixed(2)}" width="${(b.w * scale).toFixed(2)}" height="${(b.h * scale).toFixed(2)}" rx="${(b.r * scale).toFixed(2)}" fill="${palette.mint}"/>`,
  );
  const baseline = top + p.markH / 2 + (F * 0.72) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="${palette.onyx}"/>
  ${rects.join("\n  ")}
  <text x="${(margin + p.textX).toFixed(2)}" y="${baseline.toFixed(2)}" font-family="${bakedStack}" font-size="${F}" font-weight="500" letter-spacing="${(-0.02 * F).toFixed(2)}" fill="${palette.platinum}">Fourier</text>
  <text x="${margin}" y="400" font-family="${bakedStack}" font-size="36" font-weight="400" fill="#8B9199">Open source product analytics on ClickHouse</text>
  <text x="${margin}" y="452" font-family="${bakedStack}" font-size="36" font-weight="400" fill="#8B9199">The analytics.js API you already use, self-hosted.</text>
  <rect x="${margin}" y="524" width="${W - margin * 2}" height="1" fill="#2A2A2A"/>
  <text x="${margin}" y="574" font-family="${bakedStack}" font-size="27" font-weight="400" fill="${palette.mint}">github.com/FourierHQ/fourier</text>
</svg>
`;
}

if (hasSips) {
  svgToPng(bakedLockup({ fg: palette.platinum, markFill: palette.mint, bg: palette.onyx, fontSize: 96 }), join(here, "lockup-on-onyx.png"));
  svgToPng(bakedLockup({ fg: palette.onyx, markFill: palette.mintInk, bg: palette.paper, fontSize: 96 }), join(here, "lockup-on-paper.png"));
  const card = socialCard();
  svgToPng(card, join(web, "app", "opengraph-image.png"));
  svgToPng(card, join(here, "social-card.png"));
} else {
  console.warn("! Skipped the wordmark rasters: they need macOS `sips` to set type. The committed copies are unchanged.");
}

console.log(`Wrote ${written.length} files:`);
for (const f of written.sort()) console.log(`  ${f}`);
