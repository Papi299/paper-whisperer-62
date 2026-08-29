# Chrome Web Store readiness — PaperLume extension

> **Status: audit and engineering record. Not a legal opinion, and not an approval.**
>
> Nothing here states or implies that Google has reviewed, accepted, or will
> accept this extension. Every policy claim below was read from Google's own
> first-party documentation on **2026-08-28** and is cited inline. Chrome Web
> Store policy changes without notice: **re-verify every citation in this
> document against the primary source within 30 days of submission**, the same
> rule [store-launch-checklist.md](store-launch-checklist.md) applies to the
> mobile stores.
>
> **Nothing has been published.** No Store listing exists, no package has been
> uploaded, no GitHub Release has been created, and no version has been bumped.
> The artefact this document describes is a local, gitignored release candidate.

---

## 1. What is being assessed

The extension shipped by CHROME-EXTENSION-IMPORT-001B/C1/C2, unchanged. 001E1
added distribution tooling, real-browser tests and this audit; it changed **no
product behaviour**, no permission, and no manifest key.

The complete user-visible flow:

```text
user clicks the toolbar action
    ↓  (this click, and only this click, grants activeTab)
extension reads the active tab's URL
    ↓
local structural classifier — PubMed record, doi.org, or neither
    ↓
popup displays the source and the identifier it recognised
    ↓  (a second, separate user decision)
"Continue in PaperLume" → chrome.tabs.create
    ↓
https://app.paperlume.app/extension-import?kind=…&value=…
    ↓
PaperLume authenticates the user if needed
    ↓
user chooses Projects / Tags
    ↓
user confirms the import — this is where anything is first written
```

The extension's responsibility ends at `chrome.tabs.create`. It never imports,
never writes, and never learns whether the import happened.

---

## 2. Single purpose

**Policy.** *"An extension must have a single purpose that is narrow and easy to
understand."* — [Quality guidelines](https://developer.chrome.com/docs/webstore/program-policies/quality-guidelines/)

**Declared single purpose** (proposed text for the Developer Dashboard's single
purpose field):

> Identify a supported scientific paper from the current tab's URL and hand that
> identifier to PaperLume for user-confirmed import.

**Behaviour inventory.** Every capability the extension has, and the part of the
purpose it serves:

| Behaviour | Serves the purpose? | Evidence |
|---|---|---|
| Reads the active tab's URL after a toolbar click | Yes — the identifier's only source | [`popup.ts`](../extension/src/popup.ts) `readActiveTabUrl` |
| Recognises a PubMed record URL → PMID | Yes — *identify* | [`detectPaperFromUrl.ts`](../extension/src/detectPaperFromUrl.ts) |
| Recognises a doi.org URL → DOI | Yes — *identify* | same |
| Rejects everything else locally | Yes — the boundary of *supported* | same (`unsupported` / `restricted`) |
| Displays the source and identifier | Yes — tells the user what was identified | [`popup.html`](../extension/popup.html) |
| Opens PaperLume with the identifier | Yes — *hand to PaperLume* | [`paperLumeHandoff.ts`](../extension/src/paperLumeHandoff.ts) |

**Nothing else exists.** There is no second feature, no settings page, no
options UI, no context menu, no keyboard command, no side panel, no background
task, and no unrelated utility bolted on. The manifest's absence of every one of
those keys is asserted by
[`manifest.test.ts`](../extension/src/__tests__/manifest.test.ts) and again on
the packaged artefact by [`extension-package.mjs`](../scripts/lib/extension-package.mjs).

**Risk: LOW.** The purpose is one sentence, every behaviour is inside it, and
the surface is small enough that a reviewer can read the whole extension in a
few minutes.

---

## 3. Minimum functionality

This is the **highest policy risk in the submission** and deserves to be read
carefully rather than skimmed.

**Policy.** *"Do not post an extension with a single purpose of installing or
launching another app, theme, webpage, or extension."* Listed common violations
include *"Extensions with no functionality or utility"* and — the one that
matters here — *"Extensions with functionality that is not directly provided by
the extension (e.g. file converters which only link to other file conversion
services)."*
— [Minimum functionality](https://developer.chrome.com/docs/webstore/program-policies/minimum-functionality/)

### The case that this is not a launcher

The extension is not a bookmark with an icon. Before any navigation happens, and
whether or not the user ever presses Continue, it independently:

- reads and parses the active tab's URL with the WHATWG URL parser;
- applies two structural grammars — PubMed host + path shape → PMID; doi.org
  host + `10.<registrant>/<suffix>` → DOI name;
- **fails closed** on non-`http(s)` schemes, unparseable URLs, and unknown
  hosts, distinguishing "this page names no paper I support" (`unsupported`)
  from "there is no inspectable page here at all" (`restricted`);
- displays the recognised source and the extracted identifier to the user;
- **offers no continuation at all** when nothing was recognised — the button is
  not merely disabled, it is absent, and firing its event directly does nothing
  ([`handoff.spec.ts`](../e2e-extension/handoff.spec.ts), *"has no control to
  press when nothing was identified"*).

So on an unsupported page the extension does its whole job and produces a
useful, correct answer — *no paper here* — while launching nothing. A pure
launcher cannot decline to launch, because it has nothing to decide with.

### The case against, stated honestly

The analogy in the policy text is uncomfortably close. A *"file converter which
only links to another file conversion service"* is a violation, and the user's
actual goal here — getting the paper into their library — is likewise completed
by the web app, not by the extension. A reviewer who reads "identifies a paper,
then sends you to a website to do the real work" as the same shape would be
applying the policy as written.

Two things distinguish it, and both are matters of degree rather than kind:

1. **The local computation is the product, not a pretext.** The identifier is
   the deliverable. The extension resolves it entirely on-device and shows it;
   the file-converter analogue performs no conversion whatsoever.
2. **Extraction is the hard part of the task.** For a user, finding a stable
   PMID or DOI for the page they are on is the step the extension removes.

### Rating

**Risk: MODERATE.** Defensible, not guaranteed. This is the single most likely
reason for a rejection, and the submission should be made expecting the question
to be asked.

**Not a blocker for 001E1.** Nothing in current published policy makes this
extension *clearly* unpublishable, so 001E1 did not — and must not — invent
extra local functionality to pad it out. Manufacturing a feature to evade a
policy question is itself a policy problem, and it would change the product
without an owner decision.

**If Google rejects on minimum functionality**, the response is a product
decision for the owner, not an engineering workaround. Candidate directions,
recorded here so the decision starts from options rather than a blank page:

- **Show more locally.** Resolve title/authors/journal in the popup so the user
  sees *which* paper before continuing. Cost: this needs a network call from the
  extension, which today makes none — a genuine architectural widening, with new
  privacy disclosures and a new remote origin.
- **Do more locally.** Copy-to-clipboard for the identifier or a formatted
  citation, so the extension is useful with no PaperLume account at all. Cost:
  arguably a second purpose; a reviewer could then challenge single purpose.
- **Appeal with the above argument.** Cheapest, no product change, and the
  reasoning is already written down here.

None of these is authorised by 001E1.

---

## 4. Manifest V3 remote code

**Policy.** *"All of your extension's logic must be part of the extension
package. You can no longer load and execute remotely hosted files."*
— [Improve extension security](https://developer.chrome.com/docs/extensions/develop/migrate/improve-security)

**Finding: COMPLIANT. Risk: LOW.**

The shipped package is four files — `manifest.json`, `popup.html`, `popup.js`,
`popup.css` — and contains no remote reference of any kind. Verified, on the
**built artefact** rather than on source:

- the only absolute URL in any packaged file is `https://app.paperlume.app`,
  and the package validator fails on any other origin, including a lookalike
  (`app.paperlume.app.evil.example`) and plain-http PaperLume;
- no remote `src`/`href` in markup, no remote `url()` or `@import` in CSS;
- no `sourceMappingURL` and no `.map` file;
- the manifest pins `script-src 'self'; object-src 'self';`;
- no `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource` or `sendBeacon`
  exists anywhere in the built bundle, so there is no request to make.

**The distinction that matters.** Opening `https://app.paperlume.app/...` in a
tab is *navigation*, not remote code. PaperLume is a website the browser loads
into its own tab under its own origin; none of it is fetched into, evaluated by,
or given any privilege inside the extension. The extension cannot read
PaperLume's response, its DOM, or its cookies — it has no host permission for
that origin and no content script anywhere. Chrome's own policy explicitly
permits *"calls to remote web services"* and navigation; what it forbids is
executing remotely fetched code inside the extension, which this does not do.

---

## 5. Permissions

**Manifest permissions: `["activeTab"]`. Nothing else, optional or otherwise.**

**Privileged Chrome API surface: `chrome.tabs.query` and `chrome.tabs.create`.**
Both are declared in [`chrome.d.ts`](../extension/src/chrome.d.ts), which is
hand-written precisely so that the extension's entire privileged surface is one
short reviewable file; a new API must be declared there before it can compile.

Neither call needs the `tabs` permission. `activeTab` grants a temporary host
permission for the tab the user invoked the action on, which is what makes
`Tab.url` readable; opening a tab needs no permission at all. Adding `tabs`
would widen what the extension may *read* — `url`, `pendingUrl`, `title`,
`favIconUrl` for **every** tab — in exchange for nothing.

**`activeTab` shows no install-time permission warning**, which matters for
adoption and for reviewer expectations.

**Verified against the browser, not the file.** A real Chromium loads the built
extension and is asked what it granted:

```text
chrome.permissions.getAll() → { permissions: ["activeTab"], origins: [] }
```

Zero host origins. See [`load.spec.ts`](../e2e-extension/load.spec.ts).

**Risk: LOW.** This is the narrowest permission set that can perform the
behaviour at all.

---

## 6. User data and privacy

Every statement in this section was confirmed by reading the extension source
**and** grepping the built artefact.

### Accessed

- **The active tab's URL** — and only after the user clicks the toolbar action,
  which is the event that grants `activeTab`.

Nothing else. No page DOM, no `<meta>` tag, no document title, no page text, no
cookies, no storage, no history, no other tab.

### Retained

**Nothing.** The extension has no `storage` permission, and the built bundle
contains no `localStorage`, `sessionStorage`, `indexedDB`, `chrome.storage`,
`document.cookie` or Cache API reference. There is no background context, so no
state survives the popup closing. Verified in both source and `dist-extension/`.

### Transmitted automatically

**Nothing, ever.** The extension issues no network request under any
circumstance — there is no request API in the bundle to issue one with. Detection
is a pure string function. Asserted in a real browser by
[`popup.spec.ts`](../e2e-extension/popup.spec.ts) *"makes no network request of
its own"*.

### Transmitted after the user presses Continue

Exactly two query parameters, carried by a browser navigation the user asked for:

```text
https://app.paperlume.app/extension-import?kind=pmid&value=33301246
https://app.paperlume.app/extension-import?kind=doi&value=10.1038%2Fs41586-020-2649-2
```

- `kind` — `pmid` or `doi`
- `value` — the identifier

Asserted exactly, in a real browser, including that the parameter set is
precisely `["kind", "value"]` and nothing more
([`handoff.spec.ts`](../e2e-extension/handoff.spec.ts)).

### Never transmitted

Confirmed absent from the handoff URL and from the extension entirely:

the source page URL · the page title · the abstract · any page DOM · cookies ·
any PaperLume session token · any Supabase token · the user id · any Project id ·
any Tag id · any analytics identifier · any extension-added referrer · the
extension id · a timestamp

**The source page URL is not sent.** Only the extracted identifier travels. A
PMID is a public catalogue number; it does not carry the query string, fragment,
campaign parameters, or session tokens that the original URL may have held.

### Browsing activity

**Policy.** *"Web browsing activity (which is any information about the websites
or other web resources a user requests or interacts with, including the domains
or URLs the browser interacts with)."* Limited Use adds: *"Collection and use of
web browsing activity is prohibited, except to the extent required for a
user-facing feature."*
— [User data FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq) ·
[Limited Use](https://developer.chrome.com/docs/webstore/program-policies/limited-use)

**Assessment.** The active-tab URL is unambiguously web browsing activity by
that definition, so the honest position is that the extension **accesses** it —
and the disclosure should say so rather than argue the category away. What
limits the exposure is everything that happens next:

- access occurs only on an explicit user gesture, never in the background;
- it is read into a local function and never stored;
- it is never transmitted — only a *derived public identifier* is, and only on a
  second explicit gesture;
- the identifier is required for the user-facing feature, which is the Limited
  Use exception as written.

**A real-browser test demonstrates the floor.** With no toolbar grant, Chrome
returns a `Tab` with **no `url` property at all** — the extension cannot see any
URL, and the popup correctly reports that it has nothing to check
([`popup.spec.ts`](../e2e-extension/popup.spec.ts), *"holds no grant, so Chrome
reports no tab URL at all"*). Access genuinely does not exist outside the
gesture; this is Chrome's behaviour, not the extension's promise.

### Draft Developer Dashboard answers

**These are drafts for the owner to review and submit. They must be entered by a
human in the Developer Dashboard; nothing in this repository can set them, and no
answer below should be pasted without being re-read against the live form.**

| Dashboard question | Drafted answer | Basis |
|---|---|---|
| Personally identifiable information | **No** | No name, address, email, phone, username or ID number is read or sent |
| Health information | **No** | The identifier names a publication, not a person |
| Financial and payment information | **No** | None accessed |
| Authentication information | **No** | The extension has no auth; PaperLume authenticates in its own tab, and the extension cannot read it |
| Personal communications | **No** | None accessed |
| Location | **No** | None accessed |
| Web history | **Yes** | The active tab's URL is read on invocation. Answering "No" would be indefensible under the definition above |
| User activity | **No** | No clicks, mouse position, keystrokes or interaction telemetry |
| Website content | **No** | No DOM, text, image or media is read — URL only |
| *I do not sell or transfer user data to third parties, apart from the approved use cases* | **Certify** | Nothing is sold or transferred; the identifier goes only to PaperLume, at the user's request |
| *I do not use or transfer user data for purposes unrelated to my item's single purpose* | **Certify** | The identifier is the single purpose |
| *I do not use or transfer user data to determine creditworthiness or for lending purposes* | **Certify** | Not applicable |

### Privacy policy

**Required.** Google requires a posted privacy policy whenever an extension
handles user data, and "Web history = Yes" makes that unambiguous here.

**Implemented.** PAPERLUME-PRIVACY-001B added the owner-approved Privacy Policy
to the application as the public, unauthenticated route `/privacy`. Its §4 is the
extension section and covers all seven points below. It is served by the app
rather than the still-unchosen marketing site (see C16 in
[decisions-and-triggers.md](decisions-and-triggers.md)).

**Privacy policy URL to enter in the Developer Dashboard:**
`https://app.paperlume.app/privacy`

**Submission gate — open until verified, and this is a standing requirement, not
a one-off.** Publishing the route is not the same as proving it is reachable.
Before any Store submission, confirm that URL loads the policy **in Production,
signed out, from a clean browser** with no cached session (§8 item 12). Deployment
protection, a routing regression, or a rewrite change can each break it without
breaking anything else, so re-verify on every submission rather than trusting a
previous check. Until that verification is recorded, this gate stays open.

The content the extension section must cover, and which the published §4 does:

1. that the extension reads the active tab's URL, only on toolbar invocation;
2. that it stores nothing and transmits nothing automatically;
3. that pressing Continue sends only a PMID or DOI to PaperLume;
4. that the source URL, page content and titles are never sent;
5. how the identifier is then handled by PaperLume once imported;
6. the existing processor list (Supabase, NCBI/PubMed, Crossref, Gemini) — noting
   the extension itself contacts none of them;
7. contact route for data-subject requests.

---

## 7. Real-browser verification

### Architecture

- **Runtime:** Playwright's **bundled Chromium**, via
  `chromium.launchPersistentContext`. Google Chrome and Microsoft Edge no longer
  honour the extension side-loading flags, and Playwright's own documentation
  requires this channel — which also runs extensions headless.
- **Artefact under test:** `dist-extension/`, the **built** extension. No spec
  imports extension TypeScript. The lane refuses to run with a clear error if
  the build is missing.
- **Isolation:** every test gets a fresh `mkdtemp` profile directory and a fresh
  `mkdtemp` staging copy, both removed afterwards. `--disable-extensions-except`
  means the staged copy is the only extension loaded. The developer's Chrome
  profile, cookies, history and extensions are never involved.
- **Network:** the browser is launched with
  `--host-resolver-rules=MAP * 127.0.0.1:1, EXCLUDE localhost`, so **no test can
  reach PaperLume Production or anywhere else**, however it is written. No test
  signs in, and no test can create a paper, a Project or a Tag.

### Extension-ID discovery without a service worker

Playwright's documented technique reads the ID from the service worker's URL.
**This extension has no service worker**, deliberately, and 001E1 forbids adding
one to make testing convenient — testing adapts to the product.

So the ID is *derived*: Chrome computes an unpacked extension's ID from the
manifest `key` as the first 16 bytes of `SHA-256(DER public key)`, each hex
nibble mapped `0-f` → `a-p`. The harness generates a throwaway RSA key per
launch, writes it into a **staged temporary copy** of the build, and computes the
resulting ID.

Safeguards, all of which 001E1 §7.2 requires:

- the production source and `extension/manifest.json` are **unchanged**;
- the staged copy differs by **exactly one key**, `key`, and a test asserts that
  — the copy is compared against the shipped manifest and must be otherwise
  identical;
- the copy lives in a `mkdtemp` directory outside the repository and is deleted
  when the test ends, so it cannot be mistaken for the release package;
- `key` is on the packaging script's **forbidden-key list**, so a build that
  somehow acquired one fails to package;
- the derivation is checked against `chrome.runtime.id` from inside the
  extension, so a wrong derivation fails loudly instead of silently addressing
  nothing.

### What the automated lane proves

**18 tests in a real Chromium.**

| Area | Proven |
|---|---|
| Load | The built MV3 extension loads; Chrome assigns the derived ID; the popup document is reachable and renders |
| Permissions | `chrome.permissions.getAll()` returns exactly `["activeTab"]` with **zero host origins** — the browser's answer, not the file's |
| Manifest reality | Chrome's parsed manifest carries the contract intact and **none** of the forbidden keys |
| No background | `context.serviceWorkers()` and `context.backgroundPages()` are both empty in the live browser |
| No grant ⇒ no URL | Without a toolbar click Chrome exposes **no `Tab.url` at all**, and the popup reports `restricted` |
| Classification | PubMed → PMID, doi.org → DOI, publisher page → `unsupported`, `chrome://` → `restricted` |
| Styling | The packaged stylesheet is applied (asserted on a computed property, not on `toBeVisible()`) |
| No network | The popup issues zero off-origin requests while classifying |
| Handoff | Pressing Continue calls the **real** `chrome.tabs.create` and opens **one real tab** at the exact `?kind=…&value=…` URL, with the parameter set asserted to be exactly those two |
| Double activation | Two `click` events in the same tick open **one** tab. Fired with `dispatchEvent`, not `.click()` — Playwright's click respects `disabled`, so a click-based test passes against code with no latch at all |
| Failure | A refused `chrome.tabs.create` shows the error, re-enables the button, hides the progress line, opens **no** tab, makes **no** network request, and does **not** navigate the popup |
| Nothing to press | On an unsupported page the control is absent, and firing its event directly opens nothing |

The double-activation test was validated as a **negative control**: with the
in-flight latch removed from `popupView.ts` and the extension rebuilt, it fails
with two recorded tabs. It is testing the latch, not passing by accident. The
staged-copy comparison was validated the same way — injecting `storage` into the
staged permissions fails it with the extra entry named.

**What the lane does not check.** It does **not** read Chrome's per-extension
warning text from `chrome://extensions`. That page is Polymer shadow DOM with no
stable API, and scraping it would be exactly the brittle automation 001E1 rules
out. What is asserted instead is the observable consequence: Chrome loaded the
extension, granted the exact declared permission set with zero host origins, and
retained every declared manifest key — a manifest Chrome had rejected or partly
ignored could not produce that result. A warning that is purely advisory and
changes none of those would not be caught here, so item 1 of the manual gate
checks the extensions page by eye.

### What is REAL and what is a test double

Stated plainly, because a harness that blurs this is worse than none:

- **REAL** — the browser; the extension load; the manifest as Chrome parsed and
  granted it; the popup document and its built script; the classifier; the URL
  builder; `chrome.tabs.create`; the tab it opens.
- **REAL** — `chrome.tabs.query` itself in the no-grant test. What it returns
  there is Chrome's genuine answer for an extension holding no grant.
- **TEST DOUBLE** — the *return value* of `chrome.tabs.query` in the
  classification and handoff tests. Chrome populates `Tab.url` only after the
  user clicks the toolbar action; Playwright drives page content and cannot
  click browser chrome. The injected string is then fed to the real built
  classifier — nothing else is replaced.
- **PASS-THROUGH SPY** — `chrome.tabs.create` records its argument and then
  calls the real API. It is not replaced; the recording exists only because the
  deliberately-failed navigation destroys the URL before it can be read.

### The automated limitation

**Playwright cannot click the browser toolbar action, so it cannot create a real
`activeTab` grant.** Playwright automates page content, not browser chrome; there
is no supported API to synthesise the grant; and the alternatives are all
forbidden by 001E1 for good reasons — OS-level mouse automation is brittle,
weakening Chrome security flags invalidates the result, and adding a testing-only
service worker or permission changes the product to suit the test.

Consequently the single security-sensitive step —

```text
toolbar click → activeTab grant → tabs.query → Tab.url
```

— **is not automated, and is covered by the mandatory manual gate below.** A
transparent manual gate is better than an automated test that fakes a
browser-level property and reports it as real.

---

## 8. Manual release acceptance checklist — MANDATORY

**A human must complete this against the release-candidate build before any
Chrome Web Store submission.** It is not optional, and it is not superseded by
the automated lane: item 3 is the only place the real `activeTab` grant is ever
exercised.

Build the candidate first: `npm run package:extension`.

- [ ] 1. Load `dist-extension/` unpacked at `chrome://extensions` (Developer mode on) in a **clean Chrome profile**. Confirm it loads with **no error and no warning**.
- [ ] 2. Open a real PubMed record, e.g. `https://pubmed.ncbi.nlm.nih.gov/33301246/`.
- [ ] 3. **Click the toolbar action.** This is the step no automated test performs.
- [ ] 4. Confirm the popup shows **Paper detected**, source **PubMed**, and the **correct PMID** for that record.
- [ ] 5. Press **Continue in PaperLume**. Confirm **exactly one** new tab opens, at `https://app.paperlume.app/extension-import?kind=pmid&value=<PMID>`.
- [ ] 6. Repeat 2–5 with a real `https://doi.org/…` URL; confirm source **DOI**, the correct DOI, and `kind=doi` with the value percent-encoded.
- [ ] 7. Open an unsupported publisher article page. Confirm **No paper identified** and that **no Continue control is present**.
- [ ] 8. Open a restricted page (`chrome://settings/`, a `file://` URL, and the Chrome Web Store). Confirm **Nothing to check here** and no Continue control. Confirm no error dialog and no crash.
- [ ] 9. Confirm **no permission prompt** appeared at any point, and that `chrome://extensions` still lists no host access for the extension.
- [ ] 10. Confirm the popup's footnote text is accurate for what you just observed.
- [ ] 11. Re-verify every policy citation in this document against the live primary source (see the header).
- [ ] 12. Confirm the privacy policy URL is **published and publicly reachable** before entering it in the Dashboard.

Record the date, the Chrome version, and the tester for each submission.

---

## 9. Packaging

| Property | Value |
|---|---|
| Command | `npm run package:extension` |
| Build output | `dist-extension/` (gitignored) |
| Archive | `release/paperlume-extension-<version>-rc.zip` (gitignored) |
| Archive root | `manifest.json`, `popup.html`, `popup.js`, `popup.css` — **manifest at the root**, not under `dist-extension/` |
| Entries | 4 |
| Determinism | Fixed archive timestamps; two runs of the same input produce a **byte-identical** ZIP |
| Dependencies added | **None.** `fflate` is already a runtime dependency (the account data export uses it) and both writes and reads ZIPs |
| Second `package.json` / lockfile | None |

The pipeline is: clean → build → validate `dist-extension/` → write ZIP →
**unzip what was just written** and validate that → assert the archive matches
the directory byte for byte. The archive is re-read rather than trusted because
the interesting failures of a packaging step happen *during* packaging — a
path prefixed with the build directory, a dropped entry, a mangled byte range —
and a check that runs on the input cannot see any of them.

Any violation exits non-zero and no upload-ready file is presented. Verified: a
manifest widened to `["activeTab","tabs"]` fails the script with exit code 1.

**Not done, deliberately:** nothing is uploaded, no GitHub Release is created,
no tag is pushed, and the version is **not** bumped merely because a package was
built locally. `release/` is gitignored.

### What the package may not contain

Asserted on the real artefact and, with hostile fixtures, on the validator
itself: TypeScript source · source maps and `sourceMappingURL` · tests and test
directories · `.git*` · `node_modules/` · `package.json` / lockfiles ·
`tsconfig*.json` · `.env*` · Markdown/docs · Playwright artefacts · browser
profile directories · `.pem`/`.key`/`.crx` · `.DS_Store` · any `key` manifest
field · entries with absolute or `..` paths · empty files.

Plus: `manifest_version === 3` · exact name · **Chrome's full `version` grammar**
(one to four integers, each 0–65535, no leading zero on a non-zero integer, and
not all zero — so `032`, `0` and `0.0.0.0` are refused where a range check alone
would accept them, each rule carrying its own negative control) · **`description`
present, non-empty and within Chrome's 132-character limit** ·
permissions exactly `["activeTab"]` · no host permissions · no forbidden manifest
key · every manifest-referenced file present · no origin other than
`https://app.paperlume.app` in any packaged file · no remote `src`/`href`/`url()`/
`@import` · Chrome API references limited to `chrome.tabs.query` and
`chrome.tabs.create` · bounded entry count and total size.

**The scanners strip nothing** — not comments, not string literals. That is
deliberate and is the opposite of the right answer for a *source* scan (see
[`remoteReferences.ts`](../extension/src/__tests__/support/remoteReferences.ts),
which documents a real defect caused by stripping the very text being searched
for). In a **package**, a comment ships; a remote origin written in one is a
remote origin in the artefact a reviewer downloads. There is no exempt text in a
package. 105 fixture tests exercise every check against a deliberately broken
package, so a check that stopped firing fails loudly rather than passing quietly.

---

## 10. Brand and icons

### `BRAND ASSET REQUIRED BEFORE STORE SUBMISSION`

**No approved PaperLume visual identity exists in this repository.** The audit
found only:

- `public/placeholder.svg` — the generic grey scaffold placeholder, not a brand mark;
- `e2e/fixtures/*.png|svg` — test fixtures;
- the favicon in `index.html` — an inline emoji (📄), not a designed mark;
- no logo, wordmark, app icon, source vector, or brand guidelines anywhere.

Per 001E1 §13, **no icon was invented.** Deriving extension icons from a grey
placeholder or an emoji would be inventing a visual identity, and that is a
design decision with owner and trademark implications ("Paperlume" is
[not a registered trademark](store-launch-checklist.md)), not an engineering one.

**Consequence.** The extension currently ships with **no `icons` key**, so Chrome
uses its generic fallback icon. That is acceptable for unpacked development use
and it does **not** block merging 001E1 — the technical and policy hardening is
independent of it — but it is **not acceptable for public distribution**, and the
Store additionally requires a 128×128 store icon that no manifest key can
satisfy.

**Required once an approved source asset exists** (verified against
[Chrome's icons reference](https://developer.chrome.com/docs/extensions/reference/manifest/icons)):

| Size | Used for | Status |
|---|---|---|
| 16×16 | Favicon for the extension's pages | Missing |
| 32×32 | Windows systems commonly require it | Missing |
| 48×48 | Extensions management page | Missing |
| 128×128 | Installation **and the Chrome Web Store** | Missing |

PNG (best transparency support). **WebP and SVG are not supported.** Both the
general `icons` key and the `action.default_icon` key should be registered.

**Ready for that work:** the package validator already asserts that every
manifest-referenced file exists in the package, with a passing test for a
correctly-registered `icons/icon-128.png` and a failing one for a missing file.
Adding icons therefore lands with its packaging assertion already in place. The
dimension/squareness/non-empty tests 001E1 §13 describes should be added in the
same change as the assets themselves — a test asserting the dimensions of a file
that does not exist can only be skipped, and a skipped test is not a test.

**This is an input to 001E2.**

---

## 11. Store listing readiness

Requirements read from
[Prepare your Store listing](https://developer.chrome.com/docs/webstore/cws-dashboard-listing).
Package format from [Publish in the Chrome Web Store](https://developer.chrome.com/docs/webstore/publish)
(ZIP; 2 GB maximum — this package is ~4 KB).

### READY NOW

- Extension package — deterministic ZIP, manifest at archive root, validated
- Manifest V3 compliance
- Permission contract (`activeTab` only, zero host permissions)
- Remote-code compliance (self-contained package)
- Single-purpose statement (§2, drafted)
- Data-flow facts behind every privacy answer (§6, code-verified)
- Reviewer test instructions (§12)
- Real-browser regression coverage and a mandatory manual gate

### OWNER INPUT REQUIRED

- **Privacy policy URL** — `https://app.paperlume.app/privacy`. The policy is
  implemented in the application (§6.7); what remains is **confirming it loads in
  Production, signed out, from a clean browser** before each submission
- **Support URL / contact email**
- **Detailed description** — marketing copy. Must open with a concise statement
  of functionality and avoid keyword spam
- **Category** selection
- **Language** declaration
- **Publisher account** — verified developer, 2SV enabled, one-time registration
  fee paid
- **Distribution** — public vs unlisted vs private, and region availability
- **Whether to launch unlisted first**, given the §3 minimum-functionality risk.
  Recommended: it lets the listing be exercised end-to-end with a smaller
  blast radius if a policy question comes back

### VISUAL ASSET REQUIRED

Current first-party guidance states that the listed graphic assets **must be
provided**, *"except the Marquee promo tile, which is optional."* The marquee
tile is therefore the only one of these treated as optional here.

- **128×128 store icon** — **REQUIRED**; does not exist (§10)
- **Manifest icons** at 16/32/48/128 — do not exist (§10). Distinct from the
  store icon above: no manifest key can satisfy the Store's, and the Store
  listing cannot satisfy Chrome's
- **At least one 1280×800 screenshot**, up to 5 — **REQUIRED**. Must show the
  real popup; produce from the release candidate, not a mockup
- **440×280 small promo tile** — **REQUIRED**; PNG or JPEG
- **YouTube promotional video** — **REQUIRED** by the current Chrome Developer
  Dashboard listing documentation, which lists it among the assets that must be
  provided. Re-verify against the live Developer Dashboard immediately before
  submission, because Store requirements change without notice. This is the
  largest unstarted listing item: it needs a script, a recording of the real
  extension, and a hosted YouTube URL, none of which exist
- **1400×560 marquee promo tile** — **optional**, and the only asset on this
  list that is

### DEVELOPER DASHBOARD ONLY

Nothing in this repository can set these; a human enters them:

- Every privacy-practices answer and certification (§6 drafts)
- The single-purpose field (§2 draft)
- Permission justification for `activeTab`, and the remote-code declaration
- Privacy policy URL
- Reviewer test instructions (§12)
- Pricing / distribution / region configuration
- Package upload

---

## 12. Reviewer test instructions

Draft for the Dashboard's test-instructions field. **No credentials are created
or embedded**, and none should be.

> PaperLume identifies a scientific paper from the URL of the tab you are on and
> hands that identifier to the PaperLume web app for a user-confirmed import.
>
> **The extension's own functionality is fully demonstrable without an account:**
>
> 1. Install the extension.
> 2. Open `https://pubmed.ncbi.nlm.nih.gov/33301246/`.
> 3. Click the PaperLume toolbar icon. The popup shows **Paper detected**,
>    source **PubMed**, and PMID **33301246** — extracted locally from the URL by
>    the extension, with no network request and no page access.
> 4. Open `https://doi.org/10.1038/s41586-020-2649-2` and click the icon again.
>    The popup shows source **DOI** and the DOI name.
> 5. Open any other page (for example a publisher's article page). The popup
>    shows **No paper identified** and offers **no** continuation control — the
>    extension recognises the page is unsupported and sends nothing.
>
> Steps 3–5 are the whole of the extension's behaviour and require no sign-in.
>
> **Optional, and requires an account:** pressing **Continue in PaperLume** opens
> `https://app.paperlume.app/extension-import` in a new tab with only
> `?kind=…&value=…`. The extension's role ends there. PaperLume then asks the
> user to sign in, choose Projects and Tags, and explicitly confirm the import;
> the extension never imports anything and never learns whether the import
> happened.
>
> If a signed-in review of the destination page is required, please contact us
> and we will arrange access.

**Owner decision:** whether to supply reviewer credentials if Google asks. 001E1
creates none.

---

## 13. The `/extension-import` compatibility contract

Once a version is installed from the Store, **the extension in the field is
frozen but the web app keeps shipping.** From that moment
`https://app.paperlume.app/extension-import?kind=…&value=…` is a compatibility
API owed to already-installed copies, not an internal route.

Breaking any of these strands an installed extension with a dead button:

- the path `/extension-import`;
- the parameter names `kind` and `value`;
- the accepted kinds `pmid` and `doi`;
- PMID semantics (bare digits, already normalised);
- DOI semantics (an unencoded DOI *name*, percent-encoded as a query value —
  never a resolver URL).

**Existing protection.** Both sides already use the same builder/parser,
[`src/lib/extensionImportHandoff.ts`](../src/lib/extensionImportHandoff.ts): the
extension builds with `buildExtensionImportPath`, and the route parses with
`parseExtensionImportIntent`. There is no second grammar to drift from, and the
pairing is unit-tested. 001E1 adds a **real-browser** assertion of the emitted
shape, so a change that altered the URL the extension actually produces now fails
in a browser as well as in a unit test.

**Not versioned in 001E1**, per §16 — the route is unchanged. Recorded as a
**decision candidate** for a future phase: whether to introduce `/v1/` (or a
`v=1` parameter) *before* first publication, since it is far cheaper to add
while the installed base is zero. Worth deciding at submission time, not after.

---

## 14. Out of scope for 001E1

Unchanged, and deliberately so: `/extension-import` behaviour · authentication ·
the importer · Project/Tag selection · normalisation · duplicate semantics
(*"Already in your library"*, with no Project/Tag assignment to the existing row
— 001D remains separate and optional) · any PaperLume business logic · anything
under `supabase/**` (no migration, Edge Function, RLS, RPC, secret, or Production
SQL) · the extension's detection surface, permissions, and architecture.
