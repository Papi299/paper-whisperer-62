/**
 * The canonical PaperLume brand asset contract.
 *
 * `assets/brand/` holds one mark rendered five ways. The five files repeat the
 * same page, fold and beam path data because each has to stand alone as a
 * design file — a designer opens one SVG, not a build graph — and that
 * repetition is exactly how four variants of a logo quietly stop being the same
 * logo. This module states the geometry once so a test can hold every file to
 * it.
 *
 * Pure string/parse helpers over file contents, so nothing here needs a
 * renderer, a browser, or the PNGs to have been generated.
 */

// `readPngHeader` used to live here. It moved to `png.mjs` when the Chrome Web
// Store package contract needed the same 26 bytes read for a different reason
// (see that module); two byte-offset parsers that both keep returning *a*
// number is how they quietly stop agreeing.
export { readPngHeader } from "./png.mjs";

/** The shared 64-unit design grid. Every canonical raster size divides it evenly. */
export const VIEWBOX = "0 0 64 64";

/** The page outline: portrait leaf, 3-unit corners, top-right corner taken by the fold. */
export const PAGE_PATH =
  "M12 8 A3 3 0 0 1 15 5 H39 L52 18 V56 A3 3 0 0 1 49 59 H15 A3 3 0 0 1 12 56 Z";

/** The folded corner. Its height is the clear-space unit X. */
export const FOLD_PATH = "M39 5 L52 18 H39 Z";

/** The beam, apex at the fold's inner corner, spreading down-left. */
export const BEAM_PATH = "M39 18 L12 41 V59 H29 Z";

/**
 * How far the beam is held back from the page edge.
 *
 * The page outline scaled about its own centre, used as a clip. See
 * `assets/brand/brand-spec.md` §5 for why the beam does not reach the edge.
 */
export const BEAM_INSET_SCALE = "0.88";

/**
 * The beam gradient, in the direction light actually travels.
 *
 * Order is the whole point. The fold opens an aperture, the light is brightest
 * where it comes through, and it cools outward into the blue-violet family.
 * Reversed, the mark reads as a page *absorbing* light — the same four colours,
 * the opposite idea — and nothing about the file looks wrong, which is exactly
 * why it is pinned here rather than left to review.
 */
export const BEAM_GRADIENT_STOPS = ["#FFFFFF", "#B7C6FF", "#7B5CFF", "#4F66FF"];

/** The brightest stop belongs at the beam's apex, not merely somewhere in the run. */
export const BEAM_APEX = { x: "39", y: "18" };

/** The wordmark's two-tone treatment. */
export const WORDMARK_COLORS = { paper: "#0B1220", lume: "#7B5CFF" };

/** Every SVG in the pack, and whether it carries the full mark geometry. */
export const SVG_FILES = [
  "paperlume-symbol.svg",
  "paperlume-symbol-flat.svg",
  "paperlume-symbol-monochrome-dark.svg",
  "paperlume-symbol-monochrome-light.svg",
  "paperlume-logo-horizontal.svg",
];

/** The canonical raster sizes, matching Chrome's `icons` sizes plus a master. */
export const PNG_SIZES = [16, 32, 48, 128, 1024];

/** Colours that may appear in the pack, from the approved board. */
export const PALETTE = {
  deepNavy: "#0B1220",
  indigo: "#2A2A8F",
  luminousBlue: "#4F66FF",
  violet: "#7B5CFF",
  periwinkle: "#B7C6FF",
  lightGray: "#F2F4FB",
  white: "#FFFFFF",
  charcoal: "#1A1F2B",
  pageTop: "#20294A",
  foldEnd: "#C9D3FF",
};

/** Every `d="…"` in an SVG, in document order. */
export function pathData(svg) {
  return [...svg.matchAll(/\sd="([^"]+)"/g)].map((m) => m[1]);
}

/** Every hex colour in an SVG, uppercased and de-duplicated. */
export function hexColors(svg) {
  return [...new Set([...svg.matchAll(/#[0-9a-fA-F]{6}\b/g)].map((m) => m[0].toUpperCase()))];
}

/**
 * The `<stop>` colours of a named gradient, in document order.
 *
 * Document order is what matters: a gradient carrying all four approved colours
 * in the wrong sequence passes any "are the brand colours present?" check while
 * inverting the mark's meaning.
 */
export function gradientStops(svg, id) {
  const block = svg.match(new RegExp(`<linearGradient[^>]*id="${id}"[\\s\\S]*?</linearGradient>`))?.[0];
  if (!block) return null;
  return [...block.matchAll(/stop-color="(#[0-9a-fA-F]{6})"/g)].map((m) => m[1].toUpperCase());
}

/** The `x1`/`y1` of a named gradient — the end that `offset="0"` is anchored to. */
export function gradientOrigin(svg, id) {
  const block = svg.match(new RegExp(`<linearGradient[^>]*id="${id}"[^>]*>`))?.[0];
  if (!block) return null;
  return { x: block.match(/x1="([^"]+)"/)?.[1], y: block.match(/y1="([^"]+)"/)?.[1] };
}
