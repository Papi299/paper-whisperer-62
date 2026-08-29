# Chrome Web Store listing — PaperLume extension

> **Status: submission-ready draft. Nothing here has been submitted.**
>
> This is the authoritative repository record of **what a human would enter into
> the Chrome Web Store Developer Dashboard** for the PaperLume extension: the
> listing copy, the single-purpose statement, the permission justifications, the
> privacy/data-use answers, and the listing images with their provenance.
>
> **No Store item exists.** No package has been uploaded, no listing created, no
> distribution chosen, no visibility set, no privacy answer entered in Google's
> form, no fee paid, and no video published. Every field below is text in this
> repository waiting for owner review. External Store mutation belongs to
> `CHROME-EXTENSION-IMPORT-001E3` and requires explicit owner authorization.
>
> Every requirement, limit and dimension below was read from Google's own
> first-party documentation on **2026-08-29** and is cited inline. Store
> requirements change without notice: **re-verify every citation against the
> primary source before submitting**, the same standing rule
> [chrome-web-store-readiness.md](chrome-web-store-readiness.md) applies to its
> policy citations.

**Companion document.** [chrome-web-store-readiness.md](chrome-web-store-readiness.md)
is the policy audit, the data-flow evidence, the packaging contract, the
real-browser verification record and the mandatory manual release gate. This
document is the *listing*: the fields and files. Facts are stated in one of
them and linked from the other, never duplicated.

---

## 1. What is being listed

The extension shipped by CHROME-EXTENSION-IMPORT-001B/C1/C2, unchanged in
behaviour. 001E2 added the production icon set and these listing materials; it
changed **no permission**, no detection rule, no route, and no product logic.

```text
user clicks the toolbar action  →  activeTab is granted by that click
    ↓
the extension reads the active tab's URL
    ↓
a local structural classifier: PubMed record, doi.org, or neither
    ↓
the popup shows the source and the identifier — or says there is none
    ↓  (a second, separate user decision)
"Continue in PaperLume"  →  chrome.tabs.create
    ↓
https://app.paperlume.app/extension-import?kind=…&value=…
    ↓
PaperLume authenticates the user, offers Projects and Tags,
and takes its own explicit confirmation before anything is written
```

The extension's responsibility ends at `chrome.tabs.create`. It never imports,
never writes, and never learns whether the import happened.

---

## 2. Item name

**`PaperLume`**

Unchanged, and matching `extension/manifest.json` exactly — the Dashboard
prefills the item name from the manifest. Chrome's limit is *"a short, plain
text string (maximum of 75 characters)"*
([name](https://developer.chrome.com/docs/extensions/reference/manifest/name));
`PaperLume` is 9. `scripts/lib/__tests__/store-assets.test.mjs` holds the
shipped manifest to that limit.

No `short_name` is declared and none is needed: the name is already short enough
that Chrome never has to truncate it.

---

## 3. Summary — the short description

The Dashboard's summary field is **prefilled from the manifest `description`**
and can be overridden there. Chrome's limit is *"no more than 132 characters"*
([description](https://developer.chrome.com/docs/extensions/reference/manifest/description)),
enforced on the shipping artefact by the package contract.

**What the extension ships today** (`extension/manifest.json`, 56 characters):

> Identify the scientific paper on the page you are viewing.

**Recommended Dashboard summary** (71 characters) — foregrounds the handoff,
which is half the single purpose and the half a reviewer assessing minimum
functionality reads first:

> Send a research paper's PubMed ID or DOI from your browser to PaperLume.

**Owner decision, not an engineering one.** Both lines are truthful and both fit
the limit. Adopting the second in the Dashboard needs no code change. Adopting
it *in the manifest as well* — so Chrome's extensions page and the Store show
one string — is a one-line edit to `extension/manifest.json`, deliberately not
made here: the shipped description is existing approved user-facing copy, and
this phase does not rewrite product copy on its own initiative.

---

## 4. Detailed description

Drafted for the Dashboard's detailed-description field. It opens with a plain
statement of functionality and contains no keyword list.

> PaperLume recognises a research paper from the address of the page you are
> already looking at, and hands that identifier to your PaperLume library so you
> can import it deliberately.
>
> **How it works**
>
> 1. Open a supported page — a PubMed record, or a DOI resolver link.
> 2. Click PaperLume in the Chrome toolbar. Only this click gives the extension
>    access to the tab, and only to that one tab.
> 3. The extension reads that tab's address, recognises the PMID or DOI in it,
>    and shows you what it found.
> 4. If it is the right paper, choose **Continue in PaperLume**. PaperLume opens
>    in a new tab carrying only that identifier.
> 5. PaperLume signs you in if needed, lets you choose Projects and Tags, and
>    asks you to confirm. Nothing is added to your library until you do.
>
> **What is supported**
>
> - PubMed record pages — `pubmed.ncbi.nlm.nih.gov/<PMID>`, and the legacy
>   `www.ncbi.nlm.nih.gov/pubmed/<PMID>` form. The PMID is read from the address.
> - DOI resolver links — `doi.org/<DOI>`, and the older `dx.doi.org` form. The
>   DOI is read from the address.
>
> On any other page, PaperLume tells you it did not identify a paper and offers
> no Continue button. It does not guess from the page title, and it does not
> read publisher pages.
>
> **What it does not do**
>
> - It does not read the page. No text, no abstract, no DOM, no title.
> - It does not run in the background. There is no service worker and no content
>   script; the extension runs only while its popup is open.
> - It does not store anything. It has no storage permission and keeps no
>   history.
> - It does not send anything on its own. It makes no network request of any
>   kind. The only thing that ever leaves the extension is the identifier you
>   chose to continue with.
> - It never sees your PaperLume account. Signing in happens in PaperLume's own
>   tab, and the extension cannot read it.
>
> **You need a PaperLume account to import a paper**, but not to use the
> extension's own function: recognising the identifier and showing it to you
> works signed out.
>
> Privacy policy: https://app.paperlume.app/privacy

**Claims deliberately not made**, because they would be false: automatic import ·
one-click import · works on any publisher · full-text capture · AI in the
extension · PDF download · reference management inside the popup · Projects or
Tags chosen in the popup · browsing history features.

---

## 5. Single purpose

Drafted for the Dashboard's single-purpose field. Google requires *"a single
purpose that is narrow and easy to understand"*
([quality guidelines](https://developer.chrome.com/docs/webstore/program-policies/quality-guidelines/)),
and the Dashboard asks for a description *"to help the reviewers understand the
focus of your extension"*
([privacy practices](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy)).

> PaperLume identifies a supported scholarly-paper identifier — a PubMed PMID or
> a DOI — from the URL of the tab the user is on, and hands that identifier to
> the PaperLume web application for a user-confirmed import. It has no other
> feature: no options page, no context menu, no keyboard command, no background
> task, and no capability unrelated to recognising and handing over that one
> identifier.

The behaviour-by-behaviour inventory backing this, and the minimum-functionality
risk assessment it has to survive, are in
[chrome-web-store-readiness.md](chrome-web-store-readiness.md) §2 and §3. That
assessment is unchanged by 001E2: no feature was added to make the extension
look more substantial, and none was removed.

---

## 6. Permission justification

The Dashboard requires a justification *"for each permission"* and an
explanation of *"why your extension needs to use each permission"*
([privacy practices](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy)).
The manifest declares exactly one.

### `activeTab` — the only permission

> PaperLume reads the URL of the active tab to recognise a PubMed PMID or a DOI
> in it. `activeTab` is the narrowest way to do that: Chrome grants it only in
> response to the user clicking the extension's toolbar action, it covers only
> the tab the user was looking at when they clicked, it is revoked when they
> navigate away, and it shows no install-time warning because it grants nothing
> until the user asks.
>
> The URL is read into a local function, classified, and discarded when the popup
> closes. It is not stored — the extension has no `storage` permission and no
> background context in which anything could persist. It is not transmitted: the
> extension makes no network request at all. If the user presses Continue, only
> the extracted identifier is carried into a PaperLume URL, never the source URL.
>
> Without `activeTab` the extension cannot see any URL and has no function.

**Evidence that the grant is genuinely gesture-bound.** With no toolbar click,
Chrome returns a `Tab` object with **no `url` property at all** — verified in a
real browser by `e2e-extension/popup.spec.ts`, *"holds no grant, so Chrome
reports no tab URL at all"*. The limit is Chrome's behaviour, not a promise
this extension makes about itself.

### Privileged APIs used

Two, and the packaged artefact is scanned to prove there is no third
(`scripts/lib/extension-package.mjs`, `ALLOWED_CHROME_MEMBERS`).

| API | Where | Why |
|---|---|---|
| `chrome.tabs.query({active:true,currentWindow:true})` | `extension/src/popup.ts` | Read the active tab's URL. Reading `Tab.url` is what `activeTab` is for; the `tabs` permission is **not** requested and is not needed for this |
| `chrome.tabs.create({url})` | `extension/src/popupView.ts` | Open PaperLume in a new tab when the user presses Continue. One press, at most one tab |

### Not requested, and asserted absent

`tabs` · `storage` · `scripting` · `identity` · `cookies` · `webRequest` ·
`declarativeNetRequest` · `contextMenus` · `notifications` · `alarms` ·
`sidePanel` · `history` · `bookmarks` · `downloads` · `nativeMessaging` · any
host permission · any optional permission · content scripts · a background
service worker · `web_accessible_resources` · `externally_connectable`.

Asserted three times over, because each catches a different failure: on the
committed manifest (`extension/src/__tests__/manifest.test.ts`), on the packaged
artefact (`scripts/lib/extension-package.mjs`), and on **what Chrome actually
granted**, read back from the browser (`e2e-extension/load.spec.ts`, *"is granted
exactly activeTab, and no host origin"*).

### Remote code

**None.** The package is self-contained: no remote script, stylesheet, font,
image, `url()`, `@import`, `eval`, or `new Function`. The manifest pins the
default MV3 content security policy, and the package scanner rejects any origin
other than `https://app.paperlume.app` appearing in any packaged file — including
in a comment, because a comment ships. See
[chrome-web-store-readiness.md](chrome-web-store-readiness.md) §4.

---

## 7. Privacy practices — drafted Dashboard answers

**These are drafts for the owner to review and enter by hand.** Nothing in this
repository can set them, and no answer below should be pasted without being
re-read against the live form.

### The boundary these answers are about

The Dashboard is asking about **the extension**, not about PaperLume. The two
are different programs with different data behaviour, and conflating them would
over-disclose on Google's form while under-describing PaperLume's own policy.

| | The extension | The PaperLume web app, after the tab opens |
|---|---|---|
| Reads the active tab's URL | Yes, on toolbar click only | No |
| Authenticates a user | No — it cannot | Yes |
| Stores anything | No | Yes — the user's library |
| Makes a network request | **Never** | Yes |
| Calls Supabase / NCBI / Crossref / Gemini | No | Yes |
| Writes to the library | No | Yes, after explicit confirmation |

Categories below are answered **for the extension only**. PaperLume's own
processing is described in the Privacy Policy (§8) and inventoried in
[privacy-data-flow-audit.md](privacy-data-flow-audit.md).

### Data the extension handles

- **Read** — the active tab's URL, and only after the user clicks the toolbar
  action. Nothing else: no DOM, no `<meta>`, no title, no page text, no cookies,
  no storage, no other tab.
- **Retained** — nothing. No `storage` permission, no background context, and no
  `localStorage` / `sessionStorage` / `indexedDB` / `chrome.storage` /
  `document.cookie` / Cache API reference in the built bundle.
- **Transmitted automatically** — nothing, ever. There is no request API in the
  bundle to issue one with. Asserted in a real browser by
  `e2e-extension/popup.spec.ts`, *"makes no network request of its own"*.
- **Transmitted after the user presses Continue** — exactly two query
  parameters, carried by a navigation the user asked for:
  `kind` (`pmid` or `doi`) and `value` (the identifier). Asserted exactly, in a
  real browser, including that the parameter set is precisely `["kind","value"]`
  (`e2e-extension/handoff.spec.ts`).
- **Never transmitted** — the source page URL · the page title · the abstract ·
  any DOM · cookies · any PaperLume or Supabase session token · the user id ·
  any Project id · any Tag id · any analytics identifier · the extension id · a
  timestamp.

### Category answers

Category definitions quoted from the
[user data FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq).

| Dashboard question | Answer | Basis |
|---|---|---|
| Personally identifiable information | **No** | *"a person's name, address, telephone number, email address, and username… any type of identification number"* — none is read or sent. A PMID identifies a publication |
| Health information | **No** | The identifier names a paper, not a person. No health record, condition or measurement is read |
| Financial and payment information | **No** | None accessed |
| Authentication information | **No** | *"logins, password, and authentication cookies"* — the extension has no auth, reads no cookie, and cannot see PaperLume's session, which lives in its own tab |
| Personal communications | **No** | None accessed |
| Location | **No** | None accessed. No geolocation API, no IP handling — the extension makes no request |
| **Web history** | **Yes** | Web browsing activity is *"any information about the websites or other web resources a user requests or interacts with, **including the domains or URLs the browser interacts with**"*. The extension reads the active tab's URL. See the note below |
| User activity | **No** | No clicks, mouse position, keystrokes, scroll or interaction telemetry is recorded or sent |
| Website content | **No** | No DOM, text, image or media is read. The address only |

### Certifications

| Statement | Answer | Basis |
|---|---|---|
| *I do not sell or transfer user data to third parties, apart from the approved use cases* | **Certify** | Nothing is sold or transferred. The identifier goes only to PaperLume, at the user's request, as the feature the user invoked |
| *I do not use or transfer user data for purposes unrelated to my item's single purpose* | **Certify** | The identifier **is** the single purpose |
| *I do not use or transfer user data to determine creditworthiness or for lending purposes* | **Certify** | Not applicable |

### Why "Web history = Yes" stays Yes

This answer is **locked**, and re-verified against first-party policy on
2026-08-29 with no material change found.

> The extension accesses the active-tab URL only after explicit user invocation
> and does not retain or transmit the full URL — only a derived public
> identifier, and only on a second explicit gesture. The Store disclosure still
> identifies **Web history**, because URL access qualifies under Google's own
> category definition regardless of what happens next.

Three arguments that must **not** be used to answer "No": that the access is
transient; that nothing is persisted; that the full URL is never transmitted.
All three are true, all three are documented above, and none of them changes
what the category *is*. Answering "No" would be indefensible against the quoted
definition.

What the limits do buy is the [Limited Use](https://developer.chrome.com/docs/webstore/program-policies/limited-use)
exception: *"Collection and use of web browsing activity is prohibited, except to
the extent required for a user-facing feature."* Reading the URL is the entirety
of the user-facing feature, it happens only on a gesture, and nothing is kept.

If a future reading of first-party policy materially changes this category, that
is a **stop-and-report** event, not an edit.

---

## 8. Privacy policy URL

```text
https://app.paperlume.app/privacy
```

Enter this exact string in both the item's privacy-policy field and, if
prompted, the developer account page — Google requires the item policy to be
*"consistent with the existing privacy policy URL that you provided… under your
developer account page"*
([privacy practices](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy)).

The policy is served by the application as the public, unauthenticated route
`/privacy` (PAPERLUME-PRIVACY-001B); its §4 is the extension section, and it was
re-read on 2026-08-29 against the shipping code with **no factual mismatch
found**. There is no second, Chrome-specific policy and there must not be one.

**Standing submission gate — open, and it does not close permanently.** Before
**every** Store submission, confirm that URL loads the policy **in Production,
signed out, from a clean browser** with no cached session. Deployment
protection, a routing regression or a rewrite change can each break it without
breaking anything else. See
[chrome-web-store-readiness.md](chrome-web-store-readiness.md) §8 item 12.

---

## 9. Listing images

Generated by `npm run store:assets`
([`scripts/export-store-assets.mjs`](../scripts/export-store-assets.mjs)),
committed under [`assets/store/`](../assets/store), and held to their contract by
`scripts/lib/__tests__/store-assets.test.mjs`. Dimensions verified against
[Chrome Web Store images](https://developer.chrome.com/docs/webstore/images) on
2026-08-29.

| Asset | File | Size | Source | Method | Deterministic? | Hand-edited? | Depicts real behaviour? |
|---|---|---|---|---|---|---|---|
| Store icon | `assets/store/store-icon-128.png` | 128×128 | `assets/brand/svg/paperlume-symbol.svg` | Vector render, uniform scale to the documented content box | Yes — pure vector, no type | No | n/a — brand mark, makes no claim |
| Small promo tile | `assets/store/promo-tile-small-440x280.png` | 440×280 | `paperlume-logo-horizontal.svg` on a brand gradient | Composition; wordmark recoloured for dark ground per brand spec §5a | Vector yes; the one text line uses the host UI font | No | n/a — brand composition, no UI shown |
| Screenshot 1 | `assets/store/screenshot-1-pubmed-1280x800.png` | 1280×800 | **Real popup**, `dist-extension/` in real Chromium | Captured at 2×, composed onto a caption panel | Layout yes; type uses the host UI font | No | **Yes** — real PubMed detection |
| Screenshot 2 | `assets/store/screenshot-2-doi-1280x800.png` | 1280×800 | **Real popup**, same lane | Same | Same | No | **Yes** — real DOI detection |
| Screenshot 3 | `assets/store/screenshot-3-unsupported-1280x800.png` | 1280×800 | **Real popup**, same lane | Same | Same | No | **Yes** — real unsupported state |
| Marquee promo tile | — | 1400×560 | — | Not produced | — | — | **Optional** per first-party docs; deliberately skipped |

### What "real popup" means, precisely

The popup in every screenshot is the **built extension**, loaded unpacked into a
real Chromium from a `chrome-extension://` origin, with the real classifier
deciding what it displays. No popup UI was drawn in HTML for the picture.

The single injected value is the *active tab's URL*, because Chrome populates
`Tab.url` only after a real toolbar click and nothing can simulate that grant —
the same one documented test double the real-browser lane uses. The injected
string is fed to the genuine classifier, so what the popup shows is the
extension's own answer. The frame around it — the caption panel and the brand
background — is marketing layout. It invents no browser chrome, no toolbar, no
window frame, and no UI element that does not exist.

The URLs the three captures classify:

| Screenshot | Tab URL given to the classifier | What the popup produced |
|---|---|---|
| 1 | `https://pubmed.ncbi.nlm.nih.gov/33301246/` | Paper detected · PubMed · PMID 33301246 |
| 2 | `https://doi.org/10.1038/s41586-020-2649-2` | Paper detected · DOI · `10.1038/s41586-020-2649-2` |
| 3 | `https://www.nature.com/articles/s41586-020-2649-2` | No paper identified · **no Continue control** |

Screenshot 3 exists on purpose. The unsupported state is not a failure to hide;
it is the extension declining to guess, and it is the clearest available answer
to a reviewer asking whether this is merely a link to a website.

### Why the Store icon is a separate file from the manifest's 128px icon

Chrome documents the two differently, so they are two files.

- **Manifest icons** (`icons/icon-{16,32,48,128}.png` in the package) are the
  canonical brand exports, byte for byte. The brand system deliberately gives the
  mark a 5-unit margin on a 64-unit grid — *"a toolbar icon that floats in the
  middle of its box reads as smaller than its neighbours"* (`brand-spec.md` §3) —
  and that is the right treatment for a toolbar and an extensions page.
- **The Store icon** follows the Store's own rule: *"The actual icon size should
  be 96x96 (for square icons); an additional 16 pixels per side should be
  transparent padding, adding up to 128x128 total image size."* The PaperLume
  mark is a portrait page, not a square, so 96×96 is read as the box it must fit
  *within*: the mark is scaled so its taller axis is exactly 96 px, giving 16 px
  of transparent padding top and bottom and 28 px left and right. Both exceed the
  documented minimum.

The difference is **one uniform scale and one offset**. No path data, colour,
proportion or gradient differs; the Store icon is the same mark, not a second
one. Measured on the produced files: manifest 128 → mark 80×108 with 24/10 px
margins; Store 128 → mark 72×96 with 28/16 px padding.

---

## 10. Promotional video — `OPEN OWNER CONTENT GATE`

**First-party determination, read on 2026-08-29.**
[Prepare your Store listing](https://developer.chrome.com/docs/webstore/cws-dashboard-listing)
states: *"In this section, you must provide the following promotional images and
video, with the exception of the Marquee promo tile, which is optional."* The
list it introduces contains the store icon, screenshots, the small promo tile,
the marquee promo tile and a **YouTube video**.

**Classification: required, and not distribution-dependent.** The visibility
documentation states that *"All visibility settings have the same policy
requirements and will go through the same review process"*
([distribution](https://developer.chrome.com/docs/webstore/cws-dashboard-distribution)),
and names no promotional-asset exemption for unlisted or private items. So
launching unlisted does not remove this.

**Status: not produced, and deliberately not faked.** It needs a script, a
recording of the real extension, and a hosted YouTube URL. None exists, this
repository contains no approved video-production workflow, and nothing was
uploaded to YouTube. A filler video made only to clear a checklist row would be
worse than an honest gap.

**This is an owner content gate on submission.** It is the largest remaining
listing item. Before submission the owner must either produce and host the
video, or confirm against the live Dashboard that the field is not enforced for
the chosen visibility — the published documentation and the form's actual
validation are not the same artefact, and only the owner can look at the form.

**Marquee promo tile (1400×560)** is explicitly optional in the same sentence
and is not produced.

---

## 11. Category, language, and contact fields

| Field | Value | Status |
|---|---|---|
| Category | Suggested: **Workflow & Planning** (research/reference tooling) | **Owner decision.** Verify the live category list at entry time |
| Language | **English (United States)** — the only language the popup ships | Ready |
| Support URL / contact email | — | **Owner input required.** PaperLume has no published Support page: C16 in [decisions-and-triggers.md](decisions-and-triggers.md) still governs Terms and Support, and both remain unimplemented launch blockers |
| Reviewer test instructions | Drafted in [chrome-web-store-readiness.md](chrome-web-store-readiness.md) §12 | Ready. No credentials are created or embedded, and none should be |
| Publisher account | Verified developer, 2SV enabled, one-time registration fee paid | **Owner action.** Not done; no account interaction has occurred |

---

## 12. Distribution paths

Documented, **not chosen**. The owner has made no distribution decision, and
these three do not carry the same gates.

### A. Owner / manual local installation

Load `dist-extension/` unpacked at `chrome://extensions` with Developer mode on,
or install the RC ZIP's contents the same way.

- No Store account, no registration fee, no review, no listing assets, no
  promotional video, no privacy questionnaire.
- Chrome shows a developer-mode warning, and the extension is not distributed to
  anyone else.
- **Legal/provider gates: none beyond what already applies to the owner using
  PaperLume.**
- This is what the manual acceptance checklist already exercises. It needs
  nothing from this document.

### B. Private or unlisted Store distribution (limited beta)

- **Same review, same policy requirements.** *"All visibility settings have the
  same policy requirements and will go through the same review process."* So the
  full listing package, the privacy questionnaire, the privacy-policy URL, the
  registration fee and — per §10 — the promotional video all apply.
- Private limits installation to named testers and Google Groups the owner
  manages; unlisted creates no browse-able listing but anyone with the URL can
  install.
- **Provider governance applies, and it is about PaperLume, not the extension.**
  External testers who reach `/extension-import` become external users of the
  PaperLume web application, which is Gemini-backed for AI features under the
  Free/Unpaid configuration held by C29. Exposing unrestricted external users to
  Gemini-backed functionality under that configuration, where doing so would
  conflict with provider terms, remains the standing constraint. **The extension
  import flow itself makes no Gemini call**, so this is an access/product
  decision about who may use PaperLume — never a reason to change extension code.
- **Support contact becomes real.** A tester who hits a problem needs somewhere
  to write; §11's missing support URL is a genuine gate here, not a form field.

### C. Public listing

Everything in B, plus:

- discoverability, support volume and review-response expectations;
- the minimum-functionality risk in
  [chrome-web-store-readiness.md](chrome-web-store-readiness.md) §3 is taken at
  full blast rather than in front of a known audience;
- commercial launch remains separately gated (C27), and Vercel/Supabase/Gemini
  plan decisions (C29, C30) are unchanged by this document and must not be
  changed to enable a listing.

**Recommendation, if the owner wants one:** B before C. It exercises the whole
submission pipeline — upload, review, install, update — with a small blast radius
if a policy question comes back, and it does not commit the product to a public
support surface it does not yet have. That is a recommendation, not a decision.

---

## 13. Explicitly not performed

- No Chrome Web Store Developer Dashboard session, of any kind.
- No package upload.
- No Store item created, saved, or drafted in Google's system.
- No distribution or visibility setting chosen in the Dashboard.
- No privacy answer or certification entered in Google's form.
- No registration fee paid.
- No screenshot, tile or icon uploaded to Google.
- No video produced or uploaded to YouTube.
- No GitHub Release, no tag, no version bump.
- No submission for review, and no publication.

`CHROME-EXTENSION-IMPORT-001E3` owns every one of these, and requires explicit
owner authorization.
