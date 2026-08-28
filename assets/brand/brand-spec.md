# PaperLume brand assets — canonical

> **These are the canonical PaperLume brand assets.** The files in this
> directory are the source of truth for the PaperLume mark and wordmark. Any
> surface that needs the logo — the Chrome extension, the web app favicon, a
> Chrome Web Store listing, a document — takes it from here rather than
> re-drawing it.

**Brand:** PaperLume
**Direction:** **A1.3 — Illuminated Paper** (approved)
**Concept:** *Illuminating research. Bringing clarity to every paper.*

The mark is a geometric page with a folded corner and a luminous beam reading
out through the aperture the fold opens. Page = the research paper; beam =
illumination, clarity, insight. Deep navy ground, restrained blue-violet
luminance — intelligent and premium, never playful.

---

## 1. Files

| File | What it is |
|---|---|
| `svg/paperlume-symbol.svg` | **Primary symbol.** Full gradient. The master everything else derives from. |
| `svg/paperlume-symbol-flat.svg` | Flat fills, no gradient. For print, single-pass rendering, and anywhere a gradient is unwelcome. |
| `svg/paperlume-symbol-monochrome-dark.svg` | One colour (`#0B1220`) for light backgrounds. |
| `svg/paperlume-symbol-monochrome-light.svg` | One colour (`#FFFFFF`) for dark backgrounds. |
| `svg/paperlume-logo-horizontal.svg` | Symbol + wordmark lockup. |
| `png/paperlume-{16,32,48,128,1024}.png` | Transparent PNG exports of the primary symbol. **Generated** — see §6. |
| `brand-tokens.json` | The same values, machine-readable. |

All five SVGs share **identical path data** for the page, fold and beam. That is
deliberate and is asserted by
[`scripts/lib/__tests__/brand-assets.test.mjs`](../../scripts/lib/__tests__/brand-assets.test.mjs):
a geometry change must be applied to every variant or the suite fails, because
four marks that quietly diverge are worse than one mark.

## 2. Colour

### Primary

| Name | Hex | RGB |
|---|---|---|
| Deep Navy | `#0B1220` | 11, 18, 32 |
| Indigo | `#2A2A8F` | 42, 42, 143 |
| Luminous Blue | `#4F66FF` | 79, 102, 255 |
| Violet | `#7B5CFF` | 123, 92, 255 |
| Periwinkle | `#B7C6FF` | 183, 198, 255 |

### Neutral

| Name | Hex | RGB |
|---|---|---|
| Light Gray | `#F2F4FB` | 242, 244, 251 |
| White | `#FFFFFF` | 255, 255, 255 |
| Charcoal | `#1A1F2B` | 26, 31, 43 |

> Transcribed from the approved brand board. Where the board's hex label and its
> RGB triplet disagreed (Indigo, Periwinkle), **the RGB triplet was taken as
> authoritative** and the hex recomputed from it. Confirm both against the
> original design source before any print run.

### Gradients

**Beam** (apex → aperture mouth), the signature gradient:

| Stop | Colour |
|---|---|
| 0% | `#4F66FF` |
| 45% | `#7B5CFF` |
| 75% | `#B7C6FF` |
| 100% | `#FFFFFF` |

**Page** `#20294A` → `#0B1220`.  **Fold** `#FFFFFF` → `#C9D3FF`.

## 3. Sizing and clear space

- **Minimum size: 16 px.** Below this the fold stops resolving and the mark
  reads as a plain page.
- **Recommended minimum: 24 px** for print and UI.
- Canonical raster sizes: 16, 32, 48, 128 (Chrome extension `icons`) and 1024
  (master). Every one is a power-of-two fraction or multiple of the 64-unit
  viewBox, so each export is a clean uniform scale of the same vectors rather
  than a resample of a larger bitmap.
- The mark fills **~51% of the icon canvas** by area, sitting on a 5-unit
  transparent margin (of 64). That is deliberate: a toolbar icon that floats in
  the middle of its box reads as smaller than its neighbours, and one with no
  margin at all collides with them.
- **Clear space = X on all four sides**, where **X is the height of the folded
  corner** — 13 units in the 64-unit viewBox, i.e. **~24% of the mark's
  height**. Nothing intrudes into it.

## 4. Light and dark usage

| Background | Use |
|---|---|
| Light (`#FFFFFF`, `#F2F4FB`) | `paperlume-symbol.svg`, or `-monochrome-dark` for one colour |
| Dark (`#0B1220`, `#1A1F2B`) | `paperlume-symbol.svg` (the navy page reads as a silhouette against the beam), or `-monochrome-light` for one colour |
| Photographic / busy | `-monochrome-light` or `-monochrome-dark`, whichever separates |

The primary symbol is designed to hold its silhouette on **both** light and dark
grounds — see §5 on the one production refinement that makes that true.

For the **Chrome toolbar specifically**: the transparent primary symbol is
correct at 16/32/48/128. On a dark toolbar the navy page recedes and the beam
and fold carry the mark; that is intended, and it is why the monochrome-light
variant exists for any surface where the mark must read as a solid shape.

## 5. Production refinement (documented deviation)

One adaptation was made turning the approved board into production files, and it
is the only one:

**The beam is inset from the page edge rather than running to it.** On the brand
board the beam reaches the lower-left edge of the page. Rendered as a
*transparent* asset on a *white* background, that severs the page outline — the
bright end of the beam and the background become the same value and the
silhouette breaks at the corner. Insetting the beam (clipped to the page outline
scaled `0.88` about its centre) keeps an unbroken page border on every
background while leaving the beam's angle, apex, spread and gradient untouched.

The same inset is what lets the monochrome variants work at all: their beam and
fold are *knocked out* of the page, and a knockout taken to the edge would cut
the silhouette in two.

Everything else — silhouette, page/fold geometry, beam direction, proportion,
wordmark relationship, colour family — is as approved.

## 6. Regenerating the PNGs

```sh
npm run brand:png
```

Rasterises `svg/paperlume-symbol.svg` to every canonical size with a transparent
background, via Playwright's Chromium — the same renderer Chrome uses, and
already a devDependency, so no image toolchain is added. **Never hand-edit a
PNG**: edit the SVG and re-run. See
[`scripts/export-brand-png.mjs`](../../scripts/export-brand-png.mjs).

## 7. Known gaps

These are real and must be closed before the assets are used commercially:

1. **The wordmark is live `<text>`, not outlines.** PaperLume has no licensed
   brand typeface yet, and outlining a proprietary system font into a committed
   asset would be a licensing problem. `paperlume-logo-horizontal.svg` therefore
   carries a font stack (`Inter, 'SF Pro Display', 'Helvetica Neue', Arial,
   sans-serif`) and **will render differently where none of those resolve**.
   Convert to outlines once the brand typeface is chosen and licensed.
2. **No stacked lockup.** The board shows one; it was out of scope here.
3. **No tiled app-icon PNG.** The board's "Master App Icon" is the symbol on a
   rounded navy tile. Composing it is trivial from these files, but every PNG
   here is transparent-background by requirement, so the tiled composition was
   not produced.
4. **Colour values need confirmation against the original design source** — see
   the note under §2.

## 8. Out of scope for these files

No Chrome Web Store screenshot, promo tile, or promotional video; no favicon
wiring; no privacy policy. Nothing here is registered as a trademark —
"Paperlume" is **not** a registered mark.
