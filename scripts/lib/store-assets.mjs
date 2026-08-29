/**
 * The Chrome Web Store listing asset contract.
 *
 * `assets/store/` holds the images a human uploads to the Developer Dashboard.
 * Unlike the extension package, nothing validates them at upload time except
 * Google, and a listing image is the one artefact where "it looked fine when I
 * made it" is the whole of the usual quality process. So the sizes, the sources
 * and the *claims* each image makes are stated here once, and
 * `scripts/lib/__tests__/store-assets.test.mjs` holds the committed files to
 * them.
 *
 * Every dimension below was read from Chrome's own first-party documentation on
 * **2026-08-29** and is cited on the constant that carries it. Store
 * requirements change without notice: re-verify before any submission, the same
 * standing rule `docs/chrome-web-store-readiness.md` applies to its policy
 * citations.
 *
 * ## Why a contract module rather than assertions in the test
 *
 * `scripts/export-store-assets.mjs` generates these files and this test suite
 * checks them, and a generator that reads its own expectations from the test is
 * not being checked by it. Both import this module, so the two agree by
 * construction about *what* an asset is — and disagree loudly, in the suite,
 * about whether the bytes on disk match.
 */

/** Where the committed listing images live, relative to the repository root. */
export const STORE_ASSET_DIR = "assets/store";

/**
 * The Store-icon *candidate* canvas, and the box the mark must fit inside it.
 *
 * *"You must provide a 128x128-pixel extension icon image… The actual icon size
 * should be 96x96 (for square icons); an additional 16 pixels per side should be
 * transparent padding, adding up to 128x128 total image size."*
 *
 * **This is a candidate, not a confirmed upload.** The same sentence says the
 * 128px icon is supplied *"in the ZIP file of your extension"*, and
 * `icons/icon-128.png` in the release package already is that file. Whether the
 * Developer Dashboard additionally takes a separately uploaded store icon is
 * unresolved — nobody in this phase is authorised to open the Dashboard and
 * look. So this asset is generated because it is cheap, deterministic and ready
 * if such a field exists; nothing here claims it is the image the Store will
 * use. See `docs/chrome-web-store-listing.md` §9.
 *
 * The PaperLume mark is not square — it is a portrait page, 40 × 54 on the
 * 64-unit grid — so "96×96" is read as the content box it must fit *within*,
 * with at least 16 px of transparent padding on every side. Fitting the taller
 * axis puts the mark at 96 px tall and 71.1 px wide, giving 16 px of padding
 * top and bottom and 28.4 px left and right. Both satisfy the minimum; neither
 * changes the geometry.
 *
 * @see https://developer.chrome.com/docs/webstore/images
 */
export const STORE_ICON = {
  canvas: 128,
  contentBox: 96,
  minPadding: 16,
};

/**
 * The mark's bounding box on the 64-unit design grid.
 *
 * Read off the page outline in `assets/brand/svg/paperlume-symbol.svg`: the
 * page spans x 12→52 and y 5→59, and nothing else in the file extends past it
 * (the beam is clipped to the page, the fold sits inside the top-right corner).
 * `scripts/lib/__tests__/brand-assets.test.mjs` pins that path data, so these
 * six numbers cannot silently stop describing the mark.
 */
export const MARK_BOUNDS = { x: 12, y: 5, width: 40, height: 54, grid: 64 };

/**
 * Every listing image, what it must be, and what it is allowed to claim.
 *
 * `depicts` is the load-bearing field. A Store screenshot that shows behaviour
 * the extension does not have is a policy problem, not a design one, so each
 * entry records whether its pixels came from the real running extension or from
 * a composition — and the composed ones name the real capture they embed.
 */
export const STORE_ASSETS = [
  {
    file: "store-icon-128.png",
    width: 128,
    height: 128,
    /** Transparent padding is required, so the corners must be empty. */
    transparent: true,
    role: "Store icon",
    depicts: "vector render of the canonical PaperLume symbol — no UI, no claim",
    /**
     * Whether first-party documentation guarantees this file is what the Store
     * uses. It does not: the guaranteed 128px icon is the one in the package.
     * See the `STORE_ICON` comment above.
     */
    submissionPath: "candidate — the packaged icons/icon-128.png is the guaranteed one",
  },
  {
    file: "promo-tile-small-440x280.png",
    width: 440,
    height: 280,
    transparent: false,
    role: "Small promo tile",
    depicts: "brand composition — the canonical lockup on a brand gradient, no UI, no feature claim",
  },
  {
    file: "screenshot-1-pubmed-1280x800.png",
    width: 1280,
    height: 800,
    transparent: false,
    role: "Screenshot 1 of 3",
    depicts: "real popup captured from the built extension on a PubMed record URL, composed onto a caption panel",
  },
  {
    file: "screenshot-2-doi-1280x800.png",
    width: 1280,
    height: 800,
    transparent: false,
    role: "Screenshot 2 of 3",
    depicts: "real popup captured from the built extension on a doi.org URL, composed onto a caption panel",
  },
  {
    file: "screenshot-3-unsupported-1280x800.png",
    width: 1280,
    height: 800,
    transparent: false,
    role: "Screenshot 3 of 3",
    depicts: "real popup captured from the built extension on an unsupported page, composed onto a caption panel",
  },
];

/**
 * The Store's screenshot dimensions.
 *
 * *"1280x800 or 640x400 pixels"*, *"Square corners, no padding (full bleed)"*,
 * at least 1 and at most 5. The larger size is used: 640×400 exists for
 * extensions whose UI is too small to fill the frame, which is a description of
 * a low-resolution game and not of this listing.
 *
 * @see https://developer.chrome.com/docs/webstore/images
 */
export const SCREENSHOT = { width: 1280, height: 800, min: 1, max: 5 };

/**
 * The promotional video is deliberately absent from `STORE_ASSETS`.
 *
 * Not because it was judged optional — because Google's own pages disagree about
 * whether it is required at all, and this repository cannot settle that without
 * the live Developer Dashboard. `docs/chrome-web-store-listing.md` §10 records
 * the conflict verbatim. Generating filler media to retire a row that may not
 * exist would be worse than the gap.
 */

/** The tab URLs each screenshot's popup capture is taken against. */
export const CAPTURE_URLS = {
  pubmed: "https://pubmed.ncbi.nlm.nih.gov/33301246/",
  doi: "https://doi.org/10.1038/s41586-020-2649-2",
  unsupported: "https://www.nature.com/articles/s41586-020-2649-2",
};

/**
 * Chrome Web Store listing text limits.
 *
 * The extension name and the "short description" both come from the manifest
 * (`name`, `description`) unless overridden in the Dashboard, and Chrome's
 * manifest reference gives the hard numbers: *"a short, plain text string…  no
 * more than 75 characters"* for the name and *"no more than 132 characters"*
 * for the description. The detailed description is a Dashboard field; the
 * Dashboard states its own limit at entry time, and the drafted copy in
 * `docs/chrome-web-store-listing.md` sits far below any published figure, so no
 * number is asserted here that could not be verified first-party.
 *
 * @see https://developer.chrome.com/docs/extensions/reference/manifest/name
 * @see https://developer.chrome.com/docs/extensions/reference/manifest/description
 */
export const MAX_NAME_LENGTH = 75;
export const MAX_SHORT_DESCRIPTION_LENGTH = 132;
