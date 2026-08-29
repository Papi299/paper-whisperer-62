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

> These are the **canonical PaperLume v1 palette**, derived from the approved
> A1.3 reference. Where that reference's hex label and its RGB triplet disagreed
> (Indigo, Periwinkle), the RGB triplet was taken as authoritative and the hex
> recomputed from it. The resulting values are settled for v1 — build against
> them.

### Gradients

**Beam** — the signature gradient. It runs **from the aperture outward**, and
that direction is the whole idea: the fold opens a gap, the light is brightest
where it comes through, and it cools into the blue-violet family as it spreads.
Reversing it turns the mark from a page emitting light into a page absorbing it.

| Stop | Colour | Where |
|---|---|---|
| 0% | `#FFFFFF` | **the aperture** — highest luminance, at the fold's inner corner |
| 25% | `#B7C6FF` | |
| 55% | `#7B5CFF` | |
| 100% | `#4F66FF` | the far, wide end of the beam |

The gradient vector starts at the beam's apex (`39 18`) — the same point the
beam path starts from — so the white stop is anchored to the aperture rather
than merely being somewhere in the run. `scripts/lib/__tests__/brand-assets.test.mjs`
asserts both the endpoint colours and that anchoring, so a reversal fails.

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

## 5a. Typeface

The wordmark is set in **Inter SemiBold (weight 600)**, the approved PaperLume
wordmark typeface for v1. Inter is licensed under the
[SIL Open Font License](https://openfontlicense.org/).

`paperlume-logo-horizontal.svg` contains **no live text**: the wordmark is
converted to vector outlines, so the file renders identically on every machine
and needs no font installed, downloaded, or embedded. There is no font binary in
this repository and no runtime font dependency.

Set at 32 units against the 64-unit symbol, tracking `-0.005em`, with the cap
height straddling the symbol's vertical centre. Changing the wording means
re-setting it in Inter SemiBold and re-outlining — not editing path data by
hand.

`Paper` is Deep Navy `#0B1220`; `Lume` is Violet `#7B5CFF`. On dark backgrounds
`Paper` becomes `#FFFFFF` and `Lume` stays `#7B5CFF`.

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

The pack is canonical and usable as it stands. Two pieces of the original brand
board were simply not in scope, and remain to be produced:

1. **No stacked lockup.** The board shows one.
2. **No tiled app-icon PNG.** The board's "Master App Icon" is the symbol on a
   rounded navy tile. Composing it is trivial from these files, but every PNG
   here is transparent-background by requirement, so the tiled composition was
   not produced.

## 8. What derives from these files, and what is still out of scope

**Derived, elsewhere, from exactly these masters:**

- the Chrome extension's `icons/icon-{16,32,48,128}.png` — copied byte for byte
  out of `png/` by `vite.extension.config.ts` at build time, never committed a
  second time under `extension/`;
- the Chrome Web Store listing images in `assets/store/` — a 128×128 Store-icon
  **candidate** (the symbol re-fitted to the Store's documented 96 + 16 px
  transparent padding: one uniform scale and one offset, no geometry change), a
  440×280 promo tile, and three 1280×800 screenshots. Generated by
  `npm run store:assets`; provenance for each in
  [docs/chrome-web-store-listing.md](../../docs/chrome-web-store-listing.md) §9.
  The icon first-party documentation guarantees is used is the one **inside the
  extension package**; whether the Store also takes a separate upload is
  unresolved until the live Dashboard is inspected.

The promo tile uses the dark-ground treatment §5a prescribes — `Paper` recoloured
to `#FFFFFF`, `Lume` unchanged — applied as a single fill substitution on the
identical outlined geometry. There is no separate dark lockup file, and there
should not be one: the rule is one line of code, and a second file would be a
second wordmark waiting to drift.

**Still out of scope:** the stacked lockup and tiled app icon of §7; a Chrome Web
Store **promotional video** (whose requirement is an unresolved first-party
documentation conflict — see the listing document §10); favicon wiring; any
privacy policy. Nothing here is
registered as a trademark — "Paperlume" is **not** a registered mark.
