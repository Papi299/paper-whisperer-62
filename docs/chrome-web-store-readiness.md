# Chrome Web Store readiness — PaperLume extension

> **Status: audit and engineering record. Not a legal opinion, and not an approval.**
>
> Nothing here states or implies that Google has reviewed, accepted, or will
> accept this extension. Every policy claim below was read from Google's own
> first-party documentation on **2026-08-28**, and every listing and image
> requirement was re-read on **2026-08-29**. Two listing questions turned out
> **not to be answerable from the documentation at all** — whether a
> promotional video is required (§11), and whether the store icon is a separate
> upload or is read from the package (§10) — because Google's own pages
> contradict each other. Both are recorded as unresolved and gated on live
> Dashboard verification rather than guessed. Every claim is cited inline.
> Chrome Web
> Store policy changes without notice: **re-verify every citation in this
> document against the primary source within 30 days of submission**, the same
> rule [store-launch-checklist.md](store-launch-checklist.md) applies to the
> mobile stores.
>
> **Nothing has been published.** No Store listing exists, no package has been
> uploaded, no GitHub Release has been created, and no version has been bumped.
> The artefact this document describes is a local, gitignored release candidate.
>
> **Companion document.** [chrome-web-store-listing.md](chrome-web-store-listing.md)
> holds the submission package itself — listing copy, single-purpose text,
> permission justifications, the drafted privacy-practices answers, the listing
> images and their provenance, and the distribution paths. This document is the
> policy audit, the packaging contract, the verification record and the manual
> release gate. Neither restates the other.

---

## 1. What is being assessed

The extension shipped by CHROME-EXTENSION-IMPORT-001B/C1/C2, unchanged. 001E1
added distribution tooling, real-browser tests and this audit; 001E2 added the
production icon set, the Store listing materials and the deterministic listing
images. Neither changed **any product behaviour**, any permission, any detection
rule, or any manifest key beyond `icons` / `action.default_icon`.

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

The same answers, with the extension-versus-web-application boundary they depend
on spelled out and each category definition quoted from the
[user data FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq),
are in [chrome-web-store-listing.md](chrome-web-store-listing.md) §7. The two
agree; that document is the one to paste from, because it is organised as the
form is.

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

### Load and icons

- [ ] 1. Load `dist-extension/` unpacked at `chrome://extensions` (Developer mode on) in a **clean Chrome profile**. Confirm it loads with **no error and no warning** — in particular no "could not load icon" warning.
- [ ] 2. Confirm the **PaperLume mark appears in the toolbar**, is recognisable, and is not a generic puzzle-piece placeholder. Check it on both a light and a dark Chrome theme.
- [ ] 3. Confirm the mark on the `chrome://extensions` card (the 48 px icon) and in the install/details dialogue (the 128 px icon) are the same mark, not blurred and not clipped.

### PubMed case

- [ ] 4. Open a real PubMed record, e.g. `https://pubmed.ncbi.nlm.nih.gov/33301246/`.
- [ ] 5. **Click the toolbar action.** This is the step no automated test performs — it is the only place the real `activeTab` grant is exercised.
- [ ] 6. Confirm the popup shows **Paper detected**, source **PubMed**, and the **correct PMID** for that record.
- [ ] 7. Press **Continue in PaperLume**. Confirm **exactly one** new tab opens, at `https://app.paperlume.app/extension-import?kind=pmid&value=<PMID>`.

### DOI case

- [ ] 8. Repeat 4–7 with a real `https://doi.org/…` URL; confirm source **DOI**, the correct DOI **name** (not a resolver URL), and `kind=doi` with the value percent-encoded.

### Unsupported and restricted pages

- [ ] 9. Open an unsupported publisher article page. Confirm **No paper identified**, that **no Continue control is present**, and that **no identifier was guessed from the page title**.
- [ ] 10. Open a restricted page (`chrome://settings/`, a `file://` URL, and the Chrome Web Store). Confirm **Nothing to check here** and no Continue control. Confirm no error dialog and no crash.
- [ ] 11. Confirm that in cases 9 and 10 **no tab was opened and no navigation occurred** without a press.

### Authentication handoff

- [ ] 12. **Signed out.** With no PaperLume session, press Continue from a supported page. Confirm PaperLume asks you to sign in, and that **nothing is imported** before you do.
- [ ] 13. **Signed in.** With a session, press Continue. Confirm PaperLume shows the identifier, offers Projects and Tags, and **still requires an explicit confirmation** before writing. Confirm nothing was added to the library merely by the tab opening.
- [ ] 14. Confirm the extension itself never asked for credentials, and that closing the PaperLume tab without confirming leaves the library unchanged.

### Permissions and copy

- [ ] 15. Confirm **no permission prompt** appeared at any point, and that `chrome://extensions` still lists no host access for the extension.
- [ ] 16. Confirm the popup's footnote text is accurate for what you just observed.

### Before entering anything in the Dashboard

- [ ] 17. Re-verify every policy citation in this document **and in [chrome-web-store-listing.md](chrome-web-store-listing.md)** against the live primary source (see the header).
- [ ] 18. Confirm the privacy policy URL is **published and publicly reachable in Production, signed out, from a clean browser**.
- [ ] 19. Review the five committed listing images in [`assets/store/`](../assets/store) and confirm each is accurate and acceptable to publish.
- [ ] 20. Resolve the **promotional video** question (§11) against the **live Developer Dashboard**: is the field actually required for the chosen visibility? Google's own pages contradict each other, so this cannot be settled from documentation. If it is required, producing and hosting the video becomes a content gate; if not, it stays deferred.
- [ ] 21. While in the Dashboard, note whether a **separate store-icon upload field** exists (§10). If it does, `assets/store/store-icon-128.png` is the candidate to use; if it does not, the packaged `icons/icon-128.png` already is the store icon.

Record the date, the Chrome version, and the tester for each submission.

**Nothing in steps 12–14 requires a destructive change.** Confirming an import is
optional: the gate is that the import is *offered explicitly*, not that one is
performed. If an import is performed to check the whole path, it may be deleted
afterwards through the normal application UI.

---

## 9. Packaging

| Property | Value |
|---|---|
| Command | `npm run package:extension` |
| Build output | `dist-extension/` (gitignored) |
| Archive | `release/paperlume-extension-<version>-rc.zip` (gitignored) |
| Archive root | `manifest.json`, `popup.html`, `popup.js`, `popup.css`, `icons/icon-{16,32,48,128}.png` — **manifest at the root**, not under `dist-extension/` |
| Entries | 8, and the inventory is an **exact set**, not a bound (see below) |
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

**The inventory is exact.** Every other check answers "is this file allowed?";
the inventory check answers "is this *the* package?", which is the only one that
notices a file nobody thought to forbid — a bundler-emitted licence banner, an
icon left behind by a size removed from the manifest, a stray chunk. Adding a
shipping file means editing one line in
[`extension-package.mjs`](../scripts/lib/extension-package.mjs), in a diff a
reviewer reads. That is the same bargain the permission list makes.

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

**Icons, on the packaged files themselves.** Both `icons` and
`action.default_icon` must declare exactly 16/32/48/128 and point at
`icons/icon-<size>.png`; each named file must be present, be a real PNG, decode
to *exactly* the declared square dimensions, and carry an alpha channel. The
dimension check is what catches one file copied into every slot — which resolves,
loads, and renders a blurred install dialogue — and the colour-type check is what
catches transparency flattened onto white at export, which is invisible until
Chrome draws it on a dark theme. Each has its own hostile fixture.

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
package. The fixture suite exercises every check against a deliberately broken
package — including a 16×16 file in the 128 slot, a non-square icon, a
non-PNG icon, an icon with its alpha flattened, an icon map missing a size, an
absent `action.default_icon`, and an unexpected extra file — so a check that
stopped firing fails loudly rather than passing quietly.

---

## 10. Brand and icons

**Resolved by 001E2.** The gap this section recorded — no approved visual
identity, and therefore no icons — closed in two steps:
`PAPERLUME-BRAND-ASSET-PACK-001` produced the canonical PaperLume mark in
[`assets/brand/`](../assets/brand/brand-spec.md), and 001E2 wired it into the
extension and the Store listing.

### The manifest icon set

| Size | Used for | Packaged path | Source |
|---|---|---|---|
| 16×16 | Favicon for the extension's pages | `icons/icon-16.png` | `assets/brand/png/paperlume-16.png` |
| 32×32 | Commonly picked on Windows | `icons/icon-32.png` | `assets/brand/png/paperlume-32.png` |
| 48×48 | Extensions management page | `icons/icon-48.png` | `assets/brand/png/paperlume-48.png` |
| 128×128 | Installation, and the Chrome Web Store | `icons/icon-128.png` | `assets/brand/png/paperlume-128.png` |

Declared in **both** `icons` and `action.default_icon`. Chrome falls back to
`icons` when the action map is absent, so a missing `action.default_icon` still
shows *an* icon — which is exactly why its absence is easy to ship and hard to
notice, and why both maps are pinned by
[`manifest.test.ts`](../extension/src/__tests__/manifest.test.ts) and again on
the packaged artefact.

PNG, as Chrome requires: *"Icons should generally be in PNG format, because PNG
has the best support for transparency… WebP and SVG files are not supported."*
— [icons reference](https://developer.chrome.com/docs/extensions/reference/manifest/icons)

### The files are not committed under `extension/`

`vite.extension.config.ts` copies them out of the brand pack at build time,
**byte for byte** — verified: `cmp` reports the four packaged icons identical to
their brand sources. A second committed copy beside the manifest would be a
binary that can silently stop being the logo, and `assets/brand/png/` is already
generated from the master SVG by `npm run brand:png` and held to the mark's
geometry by
[`brand-assets.test.mjs`](../scripts/lib/__tests__/brand-assets.test.mjs).
Chrome reads icons from the *package*, and the package is a build output, so the
copy happens at the one moment it is needed.

This does not make `extension/` unloadable that was not already: the source
directory has never been loadable unpacked, because `popup.html` there points at
`popup.ts`. Load `dist-extension/`, as §8 says.

### Icon quality — measured, not eyeballed

Every icon was decoded in a browser and its pixels measured, because "the PNG
header says 48×48" is not the same claim as "the mark is legible and nothing is
clipped".

| Size | Mark bounding box | Margins (L/R, T/B) | Coverage | Corner alpha | Touching the canvas edge |
|---|---|---|---|---|---|
| 16 | 10×14 | 3 / 1 | 53.5% | 0, 0, 0, 0 | none |
| 32 | 20×28 | 6 / 2 | 52.6% | 0, 0, 0, 0 | none |
| 48 | 31×42 | 9,8 / 3 | 52.6% | 0, 0, 0, 0 | none |
| 128 | 80×108 | 24 / 10 | 50.7% | 0, 0, 0, 0 | none |

- **No clipping.** Zero pixels touch any canvas edge at any size.
- **No opaque background.** All four corners are fully transparent at every size,
  and the PNGs are colour type 6 (RGBA) — asserted on the packaged artefact, so
  an icon flattened onto white at export fails the package rather than shipping.
- **No geometry drift.** The mark's bounding box is 40×54 on the 64-unit grid.
  At 128 the measured box is 80×108 — exactly 2× — and at 1024 it is 640×864,
  exactly 16×. At 16 and 32 the box differs by at most one pixel of
  anti-aliasing spill, which is quantisation, not drift.
- **Optical balance preserved.** Margins scale linearly with size (24 = 12/64 ×
  128; 10 = 5/64 × 128), so the mark sits where the brand system put it rather
  than where a resize left it.
- **Legible at 16 px.** The 16×16 export carries 57 distinct luminance values
  spanning 18→232. A page that had lost its fold and beam to resizing would
  collapse toward a flat silhouette of two or three values; it has not.

**No size-optimised re-draw was needed**, and none was made. Every icon is a
clean uniform vector scale of `paperlume-symbol.svg` — never a resample of a
larger bitmap — because each canonical size divides the 64-unit viewBox evenly.

### Two 128px icons, and which one is guaranteed

**`icons/icon-128.png`, inside the RC ZIP, is the guaranteed store icon.**
First-party documentation is explicit that it travels in the package: *"You must
provide a 128x128-pixel extension icon image **in the ZIP file of your
extension**"* ([images](https://developer.chrome.com/docs/webstore/images)), and
[upload preparation](https://developer.chrome.com/docs/webstore/prepare) treats
`icons` as manifest metadata that must be right **before** upload — *"After
uploading your item, you won't be able to edit the metadata of your manifest in
the developer dashboard."*

**`assets/store/store-icon-128.png` is a Store-optimised candidate.** It applies
the Store's own framing to the identical locked geometry: *"The actual icon size
should be 96x96 (for square icons); an additional 16 pixels per side should be
transparent padding"*. The mark is a portrait page, so 96×96 is read as the box
it must fit *within* — measured: packaged 128 → mark 80×108, margins 24/10;
candidate 128 → mark 72×96, padding 28/16, both at or above the documented
16 px. The difference is one uniform scale and one offset; same paths, same
colours, same proportions.

**What is not claimed.** That the candidate is uploaded through a separate
Dashboard field, that it overrides the packaged icon, or that the Store will
display it instead. The Dashboard has not been inspected and this phase may not
inspect it;
[Prepare your Store listing](https://developer.chrome.com/docs/webstore/cws-dashboard-listing)
lists *"A 128x128 px to use as your store icon"* without settling whether that
field is a separate upload or is read from the package. **Unresolved until
someone opens the live form** — §8 item 21 is where that is checked.

The candidate is kept rather than deleted: if a distinct field exists, 001E3 uses
it; if it does not, the packaged icon is already correct and the file costs one
tracked PNG. The brand system's own 5-unit margin — *"a toolbar icon that floats
in the middle of its box reads as smaller than its neighbours"*
(`brand-spec.md` §3) — is why the packaged set is not simply re-padded to match.

Full provenance for every listing image is in
[chrome-web-store-listing.md](chrome-web-store-listing.md) §9.

---

## 11. Store listing readiness

Requirements re-read from
[Prepare your Store listing](https://developer.chrome.com/docs/webstore/cws-dashboard-listing)
and [Image guidelines](https://developer.chrome.com/docs/webstore/images) on
**2026-08-29**, with no material change from the 2026-08-28 reading. Package
format from [Publish in the Chrome Web Store](https://developer.chrome.com/docs/webstore/publish)
(ZIP; 2 GB maximum — this package is ~15 KB).

**The listing itself lives in
[chrome-web-store-listing.md](chrome-web-store-listing.md)** — the name, summary,
detailed description, single-purpose text, permission justifications, the
privacy-practices answers, the image inventory with provenance, and the
distribution paths. This section is the *status board* for it, and does not
restate its contents.

### READY NOW

- Extension package — deterministic ZIP, manifest at archive root, validated
- Manifest V3 compliance
- Permission contract (`activeTab` only, zero host permissions)
- Remote-code compliance (self-contained package)
- **Production icon set** at 16/32/48/128, in both manifest icon maps, measured
  for legibility and transparency (§10)
- **128×128 Store-icon candidate** with the documented transparent padding, and
  the packaged 128 px icon that first-party documentation guarantees is used (§10)
- **Three 1280×800 screenshots** built from real popup captures of the built
  extension, covering PubMed detection, DOI detection, and the unsupported state
- **440×280 small promo tile**
- Single-purpose statement (§2, drafted)
- Permission justification and remote-code statement (listing doc §6)
- Data-flow facts behind every privacy answer (§6, code-verified) and the
  drafted Dashboard answers (listing doc §7)
- Privacy policy URL, and the standing gate that re-verifies it (listing doc §8)
- Detailed description and summary drafts (listing doc §3, §4)
- Reviewer test instructions (§12)
- Real-browser regression coverage and a mandatory manual gate

### OWNER INPUT REQUIRED

- **Privacy policy URL reachability** — `https://app.paperlume.app/privacy`. The
  policy is implemented and its extension section was re-read against the
  shipping code on 2026-08-29 with no mismatch. What remains is **confirming it
  loads in Production, signed out, from a clean browser**, before *each*
  submission
- **Promotional video — requirement unresolved.** Google's own pages
  contradict each other; the live Dashboard decides. See below
- **Support URL / contact email** — PaperLume publishes no Support page. C16 in
  [decisions-and-triggers.md](decisions-and-triggers.md) still governs Terms and
  Support, and both remain unimplemented launch blockers
- **Category** selection and **language** declaration (listing doc §11)
- **Publisher account** — verified developer, 2SV enabled, one-time registration
  fee paid
- **Distribution** — public vs unlisted vs private, and region availability
  (listing doc §12 documents the three paths and their differing gates without
  choosing between them)
- **Final visual approval** of the five committed listing images
- **Whether to adopt the alternative Store summary** in the manifest as well as
  the Dashboard (listing doc §3)
- **Whether the popup's own palette should follow the brand pack.** The popup
  ships a teal accent (`#0e6b68`) predating the brand system, so the screenshots
  show a teal control on a navy/violet brand ground. It is a cosmetic product
  decision, not a Store requirement, and was deliberately **not** changed here:
  restyling shipped UI to make a listing image tidier is not release-candidate
  work

### VISUAL ASSETS

First-party guidance does **not** agree with itself about which graphic assets
are mandatory. [Prepare your Store listing](https://developer.chrome.com/docs/webstore/cws-dashboard-listing)
says the listed images and video **must be provided** *"with the exception of the
Marquee promo tile, which is optional"*, while
[Image guidelines](https://developer.chrome.com/docs/webstore/images) says
*"**Only** the extension icon, a small promotional image, and a screenshot are
**mandatory**"* and never mentions a video. The three assets both pages name —
store icon, at least one screenshot, small promo tile — are produced; the
disputed one is recorded as unresolved.

| Asset | Requirement | Status |
|---|---|---|
| 128×128 store icon | Required (both pages agree) | **Done** — shipped in the ZIP as `icons/icon-128.png`; a Store-optimised candidate also exists at `assets/store/store-icon-128.png` (§10) |
| Manifest icons 16/32/48/128 | Required in the ZIP | **Done** — emitted from the brand pack (§10) |
| 1280×800 screenshot, 1–5 | Required | **Done** — three, from real popup captures |
| 440×280 small promo tile | Required | **Done** — `assets/store/promo-tile-small-440x280.png` |
| YouTube promotional video | **Conflicting first-party documentation** — see below | **UNRESOLVED; live Dashboard verification required before submission.** Not produced, and deliberately not faked |
| 1400×560 marquee promo tile | Optional on every first-party reading | Not produced |

**On the video.**
`PROMOTIONAL VIDEO REQUIREMENT — FIRST-PARTY DOCUMENTATION CONFLICT; LIVE
DASHBOARD VERIFICATION REQUIRED BEFORE SUBMISSION.`

Three first-party pages, read verbatim on 2026-08-29, do not agree:

- [Prepare your Store listing](https://developer.chrome.com/docs/webstore/cws-dashboard-listing)
  — *"you **must provide** the following promotional images and video, with the
  exception of the Marquee promo tile, which is optional"*, listing *"A link to a
  **YouTube video**"* with no optional marker;
- [Image guidelines](https://developer.chrome.com/docs/webstore/images) —
  *"**Only** the extension icon, a small promotional image, and a screenshot are
  **mandatory**"*, with **no mention of a video anywhere on the page**;
- [Best listing practices](https://developer.chrome.com/docs/webstore/best-listing)
  — requires *"at least one … screenshot"* and frames a video as an alternative:
  *"Use screenshots (**or videos**) to convey the capabilities…"*.

An earlier draft of this document resolved the conflict by picking the strictest
reading and calling the video required, and additionally argued from *"All
visibility settings have the same policy requirements and will go through the
same review process"*
([distribution](https://developer.chrome.com/docs/webstore/cws-dashboard-distribution))
that unlisted release would not escape it. **Both claims are withdrawn.** That
distribution sentence is about the *policy review* every visibility undergoes; it
says nothing about whether an individual listing field is mandatory, and it
supports neither a requirement nor an exemption.

The question is a property of the live submission form, not of the
documentation. **No Dashboard access is authorised in 001E2**, so it stays open.
Before submission the owner verifies the live field; if it is required,
producing and hosting a video becomes an owner content gate at that point, and
if it is not, it stays deferred. Nothing was produced, nothing was uploaded to
YouTube, and no filler media was made to retire a row that may not exist.

### DEVELOPER DASHBOARD ONLY

Nothing in this repository can set these; a human enters them:

- Every privacy-practices answer and certification (listing doc §7)
- The single-purpose field (listing doc §5)
- Permission justification for `activeTab`, and the remote-code declaration
  (listing doc §6)
- Privacy policy URL (listing doc §8)
- Reviewer test instructions (§12)
- Category, language, support contact
- Pricing / distribution / region configuration
- Every image upload
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

## 14. Out of scope for 001E1 and 001E2

Unchanged by both phases, and deliberately so: `/extension-import` behaviour · authentication ·
the importer · Project/Tag selection · normalisation · duplicate semantics
(*"Already in your library"*, with no Project/Tag assignment to the existing row
— 001D remains separate and optional) · any PaperLume business logic · anything
under `supabase/**` (no migration, Edge Function, RLS, RPC, secret, or Production
SQL) · the extension's detection surface, permissions, and architecture.

001E2 additionally did **not** change: the Privacy Policy's wording; the
manifest `description`; the popup's markup, styling or behaviour; any provider
tier or plan (Gemini, Vercel, Supabase); or the real-browser harness's safety
properties. It added the `icons` and `action.default_icon` keys and nothing
else to the manifest.
