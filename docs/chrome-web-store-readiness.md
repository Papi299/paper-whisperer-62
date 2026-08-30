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
> **Current state, 2026-08-30 — a draft Store item exists; nothing is
> published.** `CHROME-EXTENSION-IMPORT-001E3A` created one PaperLume **draft**
> item (`cfanjbamcemoeglgkpbidnclkomaocmo`) and uploaded the validated `0.1.0`
> package under owner authorization limited to exactly those two mutations. **No
> listing, privacy or distribution field has been deliberately populated or
> saved. Nothing has been submitted for review, and nothing is published** — the
> Dashboard's published side reads *"This item is not published yet"*. Both
> previously unresolved listing questions are now **resolved from the live form**:
> the promotional video is **optional**, and the store icon **is** a separate
> required upload. See [chrome-web-store-listing.md](chrome-web-store-listing.md)
> §0 for the full live-Dashboard record.
>
> *Historical, and true when written (through 2026-08-29):* **Nothing has been
> published.** No Store listing exists, no package has been
> uploaded, no GitHub Release has been created, and no version has been bumped.
> The artefact this document describes is a local, gitignored release candidate.
>
> **Amended by CHROME-EXTENSION-IMPORT-001E2-CORRECTION-01 (2026-08-29).** Owner
> manual acceptance of the 001E2 release candidate failed on the DOI case: a DOI
> resolver redirects to the publisher before a user can reach the toolbar, so the
> URL-only classifier answered *unsupported* for the ordinary way anyone arrives
> at a paper by DOI. The extension now falls back to reading standard
> bibliographic DOI metadata from the page — **only** on an ordinary http(s) page
> whose address identified nothing, and only after the user opened PaperLume. The
> manifest permission set is now `["activeTab", "scripting"]`, the privileged API
> surface gains `chrome.scripting.executeScript`, and the drafted **Website
> content** privacy answer changes from **No** to **Yes**. Every affected section
> below is written to current behaviour; §6 and §8 carry the detail. The
> `activeTab` documentation was re-read first-party on 2026-08-29 for this change.
>
> **Privacy-policy gate CLOSED (2026-08-30).** The mismatch CORRECTION-01 opened
> — a published §4 saying the extension never reads the page, against a disclosed
> **Website content = Yes** — is resolved. The owner approved amended §4 wording,
> `PRIVACY-POLICY-EXTENSION-METADATA-001B` merged as
> `8144504508df333e850c0ed38ec1352c9579ca24`, and the amended policy was verified
> live in public Production **signed out** on 2026-08-30. §6 carries the evidence
> and retains the original diagnosis as history. **This does not retire the
> standing per-submission check** of `https://app.paperlume.app/privacy` (§6, §8
> items 23–24), which is re-armed for every actual submission.
>
> **Companion document.** [chrome-web-store-listing.md](chrome-web-store-listing.md)
> holds the submission package itself — listing copy, single-purpose text,
> permission justifications, the drafted privacy-practices answers, the listing
> images and their provenance, and the distribution paths. This document is the
> policy audit, the packaging contract, the verification record and the manual
> release gate. Neither restates the other.

---

## 1. What is being assessed

The extension shipped by CHROME-EXTENSION-IMPORT-001B/C1/C2, as amended by
001E2-CORRECTION-01. 001E1 added distribution tooling, real-browser tests and
this audit; 001E2 added the production icon set, the Store listing materials and
the deterministic listing images — neither changed any product behaviour, any
permission or any detection rule.

**001E2-CORRECTION-01 did.** It is the only behaviour change since 001C2, and it
changed exactly two things: the extension may now read four standard
bibliographic `<meta>` keys from a page, and the manifest gained the `scripting`
permission that read requires. Nothing else moved — no host permission, no
content script, no background context, no network capability, no change to what
the handoff carries.

The complete user-visible flow:

```text
user clicks the toolbar action
    ↓  (this click, and only this click, grants activeTab)
extension reads the active tab's URL
    ↓
local structural classifier — PubMed record, doi.org, or neither
    │
    ├── PubMed record → PMID          ─┐  the page is never touched
    ├── doi.org link  → DOI            │  in any of these three
    ├── not a web page → restricted   ─┘
    │
    └── an ordinary http(s) page the address did not identify:
            ↓
        chrome.scripting.executeScript on that one tab
            ↓
        read citation_doi / dc.identifier / dc.identifier.doi / prism.doi
        from document.head — nothing else in the page
            ↓
        exactly one valid DOI → DOI;  none, or two that disagree → unsupported
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

**Why the fallback exists.** `https://doi.org/10.1038/s41586-020-2649-2`
redirects to `https://www.nature.com/articles/s41586-020-2649-2` almost
immediately. A user who navigates by DOI is therefore on a publisher URL by the
time they click the toolbar action, which the URL-only classifier could only
call *unsupported*. That behaviour was correct and unusable, and it is what
failed owner acceptance of 001E2.

**Why it is standards-based rather than a publisher list.** The alternative —
a rule for Nature, then Elsevier, then Springer — is wrong the day a publisher
changes a path and never covers the next journal. Publishers already emit the
DOI in metadata conventions that exist so indexers can read it, so the fallback
carries no per-site knowledge at all.

The extension's responsibility ends at `chrome.tabs.create`. It never imports,
never writes, and never learns whether the import happened.

---

## 2. Single purpose

**Policy.** *"An extension must have a single purpose that is narrow and easy to
understand."* — [Quality guidelines](https://developer.chrome.com/docs/webstore/program-policies/quality-guidelines/)

**Declared single purpose** (proposed text for the Developer Dashboard's single
purpose field):

> Identify a supported scientific paper from the current tab — from its URL, or
> from the standard DOI metadata the page publishes — and hand that identifier to
> PaperLume for user-confirmed import.

**Behaviour inventory.** Every capability the extension has, and the part of the
purpose it serves:

| Behaviour | Serves the purpose? | Evidence |
|---|---|---|
| Reads the active tab's URL after a toolbar click | Yes — the first source tried, and for a recognised address the only one | [`classifyActiveTab.ts`](../extension/src/classifyActiveTab.ts) |
| Recognises a PubMed record URL → PMID | Yes — *identify* | [`detectPaperFromUrl.ts`](../extension/src/detectPaperFromUrl.ts) |
| Recognises a doi.org URL → DOI | Yes — *identify* | same |
| Reads four standard DOI `<meta>` keys, only where the address identified nothing | Yes — *identify*, after a resolver redirect | [`detectPaperFromMetadata.ts`](../extension/src/detectPaperFromMetadata.ts) |
| Rejects everything else locally | Yes — the boundary of *supported* | both (`unsupported` / `restricted`) |
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
- where the address identified nothing, reads four standard bibliographic
  `<meta>` keys out of the page and normalizes the DOI presentation form the
  publisher happened to write (`doi:…`, `DOI: …`, a resolver URL, a bare name)
  onto the DOI name — refusing the page outright if two of them disagree;
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

**The DOI metadata read is not remote code either**, and the distinction is worth
stating because `chrome.scripting.executeScript` is an injection API. What is
injected is a function that ships *inside the package* — Chrome serializes it out
of `popup.js` at call time. Nothing is fetched, nothing is evaluated from a
string, and no code from the page runs with extension privilege: the injected
function returns four strings and the page contributes nothing else. `eval` and
`new Function` remain absent from the bundle, asserted by
[`sourceBoundary.test.ts`](../extension/src/__tests__/sourceBoundary.test.ts).

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

**Manifest permissions: `["activeTab", "scripting"]`. Nothing else, optional or
otherwise.**

**Privileged Chrome API surface: `chrome.tabs.query`, `chrome.tabs.create` and
`chrome.scripting.executeScript`.** All three are declared in
[`chrome.d.ts`](../extension/src/chrome.d.ts), which is hand-written precisely so
that the extension's entire privileged surface is one short reviewable file; a
new API must be declared there before it can compile.

### `activeTab`

Grants a temporary host permission for the tab the user invoked the action on.
That grant does two jobs here: it makes `Tab.url` readable, and it is the host
access `executeScript` needs. Chrome's own page is explicit that the permission
allows an extension to *"call `scripting.insertCSS()` or
`scripting.executeScript()` on that tab **if the `"scripting"` permission is also
declared**"*, and lists the gestures that enable it — *"Executing an action"*
being the one this extension uses.
— [activeTab](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab)
(re-read 2026-08-29)

**`activeTab` shows no install-time permission warning.**

### `scripting`

Added by 001E2-CORRECTION-01. It enables the injection API and **grants access to
no page**: the scripting reference states that injection needs the
*"`host_permissions` key or the `activeTab` permission, which grants temporary
host permissions"*.
— [chrome.scripting](https://developer.chrome.com/docs/extensions/reference/api/scripting)
(re-read 2026-08-29)

So the pair `activeTab` + `scripting` is strictly narrower than the obvious
alternative, `host_permissions`. A host pattern grants standing access to every
matching page for as long as the extension is installed, whether or not the user
ever asks for anything; the pair grants access to one tab, because of one click,
until the user navigates away. **No host permission is declared, and none is
optional.**

### Not requested

`tabs` is still not requested and is still not needed. It is not a gate on the
`tabs` namespace — it grants reading `url`, `pendingUrl`, `title` and
`favIconUrl` for **every** tab — so adding it would widen what the extension may
read in exchange for nothing. `storage`, `history`, `cookies`, `webRequest`,
`declarativeNetRequest`, `identity`, `downloads`, `bookmarks` and
`nativeMessaging` are absent, along with `content_scripts`, `background`,
`web_accessible_resources` and `externally_connectable`.

### Verified against the browser, not the file

A real Chromium loads the built extension and is asked what it granted:

```text
chrome.permissions.getAll() → { permissions: ["activeTab", "scripting"], origins: [] }
```

**Zero host origins** — and that is the load-bearing half. A second real-browser
test then calls the genuine `chrome.scripting.executeScript` against a real tab
id with no toolbar grant in play, and records Chrome's refusal verbatim:

```text
Error: Cannot access contents of the page. Extension manifest must request
permission to access the respective host.
```

So "the page is read only after you invoke PaperLume" is Chrome's behaviour, not
the extension's promise. See [`load.spec.ts`](../e2e-extension/load.spec.ts),
*"is granted exactly activeTab and scripting, and no host origin"* and *"cannot
inject into any page without a toolbar grant"*.

**Risk: LOW.** This is the narrowest permission set that can perform the
behaviour at all. The addition is one permission that, on its own, reaches
nothing.

---

## 6. User data and privacy

Every statement in this section was confirmed by reading the extension source
**and** grepping the built artefact.

### Accessed

- **The active tab's URL** — and only after the user clicks the toolbar action,
  which is the event that grants `activeTab`.
- **Four `<meta>` element `content` values from that tab's page** — and only
  when the URL identified no paper, and only in the main frame.

The metadata read is bounded on three axes at once, and all three matter:

**When.** Only on an ordinary `http(s)` page whose *address* named no paper. A
PubMed record and a `doi.org` link are answered from the URL alone and the page
is never touched; a `chrome://` page, a `file://` URL or a tab with no readable
address is `restricted` and no injection is even attempted. Asserted in
[`classifyActiveTab.test.ts`](../extension/src/__tests__/classifyActiveTab.test.ts),
where the recognised and restricted cases assert `executeScript` was **not
called**.

**What.** Exactly these four keys, matched case-insensitively on `name` or
`property`, in `document.head` only:

```text
citation_doi · dc.identifier · dc.identifier.doi · prism.doi
```

Their `content` strings are the entire output — an array of at most a handful of
short strings, which the extension then normalizes and validates.

**What is not read, and is not readable.** The document title · the article
title · the abstract · authors · journal · headings · body text · anchor `href`s
· arbitrary `data-` attributes · JSON-LD · inline scripts · JavaScript variables
· iframes · sub-frames of any kind · PDFs · forms · cookies · page storage · the
user's selection · any other tab · any other page. The injected function is nine
lines long and reads `getAttribute` on `<meta>` elements; there is no traversal
that could reach any of the above. Asserted with decoy DOIs planted in the title,
the body and a link, in both the unit suite and the real browser
([`metadata.spec.ts`](../e2e-extension/metadata.spec.ts), *"reads only the
approved metadata, never the title, body or links"*).

**There is still no title fallback.** A page that publishes no DOI is
`unsupported`, and nothing about it is sent anywhere.

### Retained

**Nothing.** The extension has no `storage` permission, and the built bundle
contains no `localStorage`, `sessionStorage`, `indexedDB`, `chrome.storage`,
`document.cookie` or Cache API reference. There is no background context, so no
state survives the popup closing. Verified in both source and `dist-extension/`,
and — since the extension now reads page content — asserted in a real browser
*after* a metadata read has happened ([`metadata.spec.ts`](../e2e-extension/metadata.spec.ts),
*"stores nothing, having read a page"*, which also confirms `chrome.storage` is
`undefined` because the permission is not declared).

The metadata values are processed **locally and transiently**: they exist as
strings inside the popup's page for as long as the popup is open, are reduced to
at most one DOI name, and are gone when the popup closes.

### Transmitted automatically

**Nothing, ever.** The extension issues no network request under any
circumstance — there is no request API in the bundle to issue one with. Asserted
in a real browser by [`popup.spec.ts`](../e2e-extension/popup.spec.ts) *"makes no
network request of its own"*, and again on the metadata path by
[`metadata.spec.ts`](../e2e-extension/metadata.spec.ts) *"makes no request of its
own while reading a page's metadata"*.

In particular **the DOI is never resolved**. The extension does not ask doi.org,
Crossref or PubMed whether the DOI it read exists; whether a DOI is registered is
the resolver's answer to give, and asking would be a network request the
extension is built not to be able to make.

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

the source page URL · the page title · the abstract · authors · the journal ·
any other metadata value read from the page · any page DOM · cookies · any
PaperLume session token · any Supabase token · the user id · any Project id ·
any Tag id · any analytics identifier · any extension-added referrer · the
extension id · a timestamp

**The source page URL is not sent.** Only the extracted identifier travels. A
PMID is a public catalogue number; it does not carry the query string, fragment,
campaign parameters, or session tokens that the original URL may have held.

**No page content is sent, apart from the detected DOI itself.** That
qualification matters and is not pedantry: on the metadata path the DOI *is*
derived from an approved `<meta>` element's `content` value, so "page content is
never transmitted" would be false as stated. The metadata read produces at most
one DOI name, and that DOI is the only thing a `kind`/`value` handoff can carry — the
contract has no third parameter to put anything else in. Asserted on a
metadata-detected DOI in a real browser, including that the publisher host, the
article title and the author name appear nowhere in the handoff URL
([`metadata.spec.ts`](../e2e-extension/metadata.spec.ts), *"hands a
metadata-detected DOI over as kind and value, and nothing else"*).

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
and the disclosure should say so rather than argue the category away. The same
applies to the page metadata added by 001E2-CORRECTION-01: the quoted definition
extends to *"the content of the HTTP requests and responses"*, and a `<meta>`
element is part of a response. See the **Website content** row below, which moves
to **Yes** for that reason.

What limits the exposure is everything that happens next, and it is unchanged by
the correction:

- access occurs only on an explicit user gesture, never in the background;
- it is read into a local function and never stored;
- it is never transmitted — only a *derived public identifier* is, and only on a
  second explicit gesture;
- the identifier is required for the user-facing feature, which is the Limited
  Use exception as written;
- the page read is additionally narrowed to four bibliographic keys, and happens
  only where the URL identified nothing.

**Two real-browser tests demonstrate the floor**, and both read Chrome's own
behaviour rather than restating a promise:

- With no toolbar grant, Chrome returns a `Tab` with **no `url` property at all**
  — the extension cannot see any URL, and the popup correctly reports that it has
  nothing to check ([`popup.spec.ts`](../e2e-extension/popup.spec.ts), *"holds no
  grant, so Chrome reports no tab URL at all"*).
- With no toolbar grant, `chrome.scripting.executeScript` against a real tab is
  **refused outright** — *"Cannot access contents of the page. Extension manifest
  must request permission to access the respective host."*
  ([`load.spec.ts`](../e2e-extension/load.spec.ts), *"cannot inject into any page
  without a toolbar grant"*).

Access to the URL and access to the page both genuinely do not exist outside the
gesture.

### Draft Developer Dashboard answers

**These are drafts for the owner to review and submit. They must be entered by a
human in the Developer Dashboard; nothing in this repository can set them, and no
answer below should be pasted without being re-read against the live form.**

**One answer changed in CORRECTION-01: Website content, No → Yes.** No other
category changed, and none was changed *toward* Yes without evidence — the
extension still reads no personally identifiable information, no health
information, no authentication material, no location and no interaction
telemetry, and it still makes no request of its own. If a draft answer had
already been entered in the Dashboard for a previous attempt, this one must be
corrected before submission.

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
| Web history | **Yes** | The active tab's URL is read on invocation. Answering "No" would be indefensible under the definition above. **Unchanged by CORRECTION-01** |
| User activity | **No** | No clicks, mouse position, keystrokes or interaction telemetry |
| Website content | **Yes** — *changed from No by CORRECTION-01* | The extension reads `<meta>` element content from the page. It is four bibliographic keys, processed locally and transiently, and neither the content nor the page URL is transmitted — but content **is** read, and the category asks what is accessed |
| *I do not sell or transfer user data to third parties, apart from the approved use cases* | **Certify** | Nothing is sold or transferred; the identifier goes only to PaperLume, at the user's request |
| *I do not use or transfer user data for purposes unrelated to my item's single purpose* | **Certify** | The identifier is the single purpose |
| *I do not use or transfer user data to determine creditworthiness or for lending purposes* | **Certify** | Not applicable |

### Privacy policy

**Required.** Google requires a posted privacy policy whenever an extension
handles user data, and "Web history = Yes" makes that unambiguous here.

**Implemented.** PAPERLUME-PRIVACY-001B added the owner-approved Privacy Policy
to the application as the public, unauthenticated route `/privacy`. Its §4 is the
extension section. It is served by the app rather than the still-unchosen
marketing site (see C16 in
[decisions-and-triggers.md](decisions-and-triggers.md)).

**Point 2 below was added by CORRECTION-01 and the published §4 did not cover
it** — that was the blocking gate stated at the end of this subsection, and it is
now **CLOSED**. The amended §4 approved by the owner on 2026-08-30 covers all
eight points, and `PRIVACY-POLICY-EXTENSION-METADATA-001B` merged on
**2026-08-30** (merge commit
[`8144504`](https://github.com/Papi299/paper-whisperer-62/commit/8144504508df333e850c0ed38ec1352c9579ca24))
and is live in Production.

**Privacy policy URL to enter in the Developer Dashboard:**
`https://app.paperlume.app/privacy`

**Reachability gate — STANDING, and it does not close permanently.** Publishing
the route is not the same as proving it is reachable. Before any Store submission,
confirm that URL loads the policy **in Production, signed out, from a clean
browser** with no cached session (§8 item 12). Deployment protection, a routing
regression, or a rewrite change can each break it without breaking anything else,
so re-verify on every submission rather than trusting a previous check.

**Last successful signed-out Production verification: 2026-08-30**, which also
closed the one-time content mismatch below. That verification is evidence for
*that* date only. This gate is re-armed for the next submission and **must be
performed again immediately before every actual Chrome Web Store submission**.

The content the extension section must cover:

1. that the extension reads the active tab's URL, only on toolbar invocation;
2. **that, where the URL identifies no paper, it reads four standard
   bibliographic `<meta>` values from that page — locally and transiently;**
3. that it stores nothing and transmits nothing automatically;
4. that pressing Continue sends only a PMID or DOI to PaperLume;
5. that the source URL, page content and titles are not sent — with the one
   exception that the **detected identifier value** is, and only after the user
   explicitly chooses Continue (a detected DOI may be derived from an approved
   metadata `content` value, so an unqualified claim here would be false);
6. how the identifier is then handled by PaperLume once imported;
7. the existing processor list (Supabase, NCBI/PubMed, Crossref, Gemini) — noting
   the extension itself contacts none of them;
8. contact route for data-subject requests.

**PRIVACY-POLICY MISMATCH GATE — CLOSED 2026-08-30.** Owner approval was given,
`PRIVACY-POLICY-EXTENSION-METADATA-001B` merged, and the amended policy was
verified live in public Production signed out. The diagnosis below is retained
**as historical evidence of what the defect was and why it blocked**; the closure
record follows it. This gate is not the same as the *standing* reachability gate
above, which remains in force for every submission.

*The defect, recorded as it was found.* The owner-approved §4 of `/privacy`
stated, as a bulleted list of things the extension does **not** do:

> It does not: … read the contents of the webpage or its DOM; …

That sentence was true of every version up to and including 001E2. It is **false
of the extension this document describes.** The rest of §4 remained accurate —
the extension still stores nothing, still transmits nothing automatically, still
sends only the identifier, and still does not maintain a browsing-history
database, read cookies, or use content scripts.

CORRECTION-01 deliberately did **not** edit
[`src/pages/Privacy.tsx`](../src/pages/Privacy.tsx): the public Privacy Policy is
owner-approved legal text under separate control, and amending it is an owner and
legal decision, not an engineering one.

*The decision.* On **2026-08-30 the owner approved exact replacement wording for
§4**, and `PRIVACY-POLICY-EXTENSION-METADATA-001B` implements it verbatim,
together with an effective date of **August 30, 2026**. The amended section
discloses the bounded metadata read, names the four supported DOI metadata names,
states that the check is main-frame only, states that processing is local and
transient and not persisted, replaces the retired bullet with a bounded negative
list, and closes with an affirmative Limited Use statement. The full record is in
[privacy-data-flow-audit.md](privacy-data-flow-audit.md) §25.

*Why this gate existed at all — retained, because it is the standard any future
policy change must still meet.* Approving wording is not merging it, and merging
is not publishing it: the policy a Chrome Web Store reviewer reads is whatever
Production serves. Google requires the disclosed practices to match the posted
policy, and "Website content = Yes" against a policy saying the page is never read
is a direct contradiction a reviewer can check in one click. A Vercel Preview
deployment is **not** Production and never closed this gate.

*How it closed.* On **2026-08-30**:

- `PRIVACY-POLICY-EXTENSION-METADATA-001B` (PR #258) **merged** to `main` as a
  regular two-parent merge commit
  **`8144504508df333e850c0ed38ec1352c9579ca24`**, whose tree equals the approved
  head tree `817827f61e5f82b31d636f81a2ee9b91674f814b`.
- The push-triggered **Validate**, **DB Tests** and **Extension (package + real
  browser)** lanes all succeeded for that commit, and GitHub's **Vercel** commit
  status reported *success — "Deployment has completed"*. (Native Vercel
  READY/alias evidence was **not** obtained and is **not** claimed here.)
- `https://app.paperlume.app/privacy` was then opened **in public Production, in
  a signed-out browser**: HTTP **200**, **zero redirects**, and no PaperLume
  account required.

*What the served page showed.* Effective date **August 30, 2026**; section
**4. PaperLume Chrome extension** matching the approved copy; the corrected
transmission bullet (*"…except for the detected identifier value described below
when you choose to continue."*); the unchanged identifier paragraph; all four DOI
metadata names (`citation_doi`, `dc.identifier`, `dc.identifier.doi`,
`prism.doi`); and the affirmative Limited Use sentence. The retired claim
*"read the contents of the webpage or its DOM"* was **absent**.

**The disclosed *Website content = Yes* no longer contradicts the posted policy.**
This specific mismatch gate is therefore **CLOSED** and does not reopen on its
own. What remains is the *standing* per-submission reachability and
factual-consistency re-check described above — a different gate, deliberately not
closed by this record.

**Limited Use disclosure location.** The approved §4 closes with *"PaperLume uses
information accessed by the Chrome extension only in accordance with the Chrome
Web Store User Data Policy, including its Limited Use requirements."* The public
Privacy Policy is therefore the affirmative Limited Use disclosure location, one
click from the item's listed policy URL. No second copy of that sentence belongs
elsewhere, and none should be added unless first-party Google documentation
clearly requires a separate one.

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

**28 tests in a real Chromium** (18 before CORRECTION-01, which added ten).

| Area | Proven |
|---|---|
| Load | The built MV3 extension loads; Chrome assigns the derived ID; the popup document is reachable and renders |
| Permissions | `chrome.permissions.getAll()` returns exactly `["activeTab", "scripting"]` with **zero host origins** — the browser's answer, not the file's |
| No grant ⇒ no injection | The **real** `chrome.scripting.executeScript`, against a real tab id, is refused by Chrome: *"Cannot access contents of the page…"*. Nothing is stubbed |
| Manifest reality | Chrome's parsed manifest carries the contract intact and **none** of the forbidden keys |
| No background | `context.serviceWorkers()` and `context.backgroundPages()` are both empty in the live browser |
| No grant ⇒ no URL | Without a toolbar click Chrome exposes **no `Tab.url` at all**, and the popup reports `restricted` |
| Classification | PubMed → PMID, doi.org → DOI, `chrome://` → `restricted`; and a publisher page whose injection is refused → `unsupported`, with Chrome's refusal text never displayed |
| Metadata detection | A real tab at a publisher URL, serving real markup, parsed by Chrome: `citation_doi` → the DOI, shown in the popup, where the URL identified nothing |
| Metadata scope | The same page's document title, `description`, body text and anchor `href` carry four decoy DOIs. **None** reaches the popup — nor does the article title, journal or author |
| Metadata duplicates | One DOI written as a padded bare name, a `doi:` form and a resolver URL collapses to **one** detection |
| Metadata ambiguity | Two *non-equivalent* valid DOIs on one page → `unsupported`, with **neither** shown. ASCII-case variants of one DOI are **not** an ambiguity (DOI Handbook §4.3.4) and collapse to one detection, keeping the spelling the page published |
| Metadata control | The same publisher URL with no `citation_doi` behind it stays `unsupported` — so the detection above is the extension's, not the harness's |
| Metadata handoff | Continue opens **one real tab** carrying exactly `kind=doi` and the normalized `value`; the publisher host, title and author appear nowhere in the URL |
| Metadata privacy | Zero off-origin requests during the read (the DOI is never resolved), and afterwards `chrome.storage` is `undefined`, `localStorage`/`sessionStorage` empty, `document.cookie` empty |
| Styling | The packaged stylesheet is applied (asserted on a computed property, not on `toBeVisible()`) |
| No network | The popup issues zero off-origin requests while classifying |
| Handoff | Pressing Continue calls the **real** `chrome.tabs.create` and opens **one real tab** at the exact `?kind=…&value=…` URL, with the parameter set asserted to be exactly those two |
| Double activation | Two `click` events in the same tick open **one** tab. Fired with `dispatchEvent`, not `.click()` — Playwright's click respects `disabled`, so a click-based test passes against code with no latch at all |
| Failure | A refused `chrome.tabs.create` shows the error, re-enables the button, hides the progress line, opens **no** tab, makes **no** network request, and does **not** navigate the popup |
| Nothing to press | On an unsupported page the control is absent, and firing its event directly opens nothing |

**Negative controls, run rather than assumed.** The double-activation test was
validated by removing the in-flight latch from `popupView.ts` and rebuilding: it
fails with two recorded tabs. The staged-copy comparison was validated by
injecting `storage` into the staged permissions, which fails it with the extra
entry named.

The metadata lane was validated the same way, against the failure mode most
likely to survive every other test. Chrome serializes an injected function and
deserializes it in the page, so *"any bound parameters and execution context will
be lost"* — a reference to a module-level constant works in jsdom, survives
bundling, and throws `ReferenceError` on a real publisher page. Hoisting the
key list one line out of the injected function's body and rebuilding fails **6 of
the 8** metadata specs (the two that still pass are the ones expecting
`unsupported`, correctly) and fails the unit control in
`detectPaperFromMetadata.test.ts`, which rebuilds the function from its own
source in a scope where the module's bindings do not exist.

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
- **REAL** — `chrome.scripting.executeScript` in every test that does not pass
  the harness a page. It is invoked against a real tab id and Chrome really
  refuses it, which is the fail-closed path exercised rather than simulated.
- **PARTIAL TEST DOUBLE** — the `url` property of the `Tab` `chrome.tabs.query`
  returns in the classification, handoff and metadata tests. Chrome populates
  `Tab.url` only after the user clicks the toolbar action; Playwright drives
  page content and cannot click browser chrome. That one property is overwritten
  on the real `Tab` Chrome returned — the `id` the injection targets is Chrome's
  own — and the string is then fed to the real built classifier.
- **TEST DOUBLE — the `activeTab` grant**, in the metadata tests only, and it is
  a double of the *permission* rather than of the read. The page is real: a real
  tab navigates to a publisher-like address and Chrome really parses the markup.
  The function is real: the harness takes the `func` the built extension passed,
  serializes it with `String(func)` exactly as Chrome does, and evaluates it in
  the real page's realm. What it returns goes straight back into the real built
  normalizer. Only the permission to reach the page is supplied — which is
  precisely the thing `load.spec.ts` proves Chrome withholds.
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
                                → scripting.executeScript → page metadata
```

— **is not automated, and is covered by the mandatory manual gate below.** A
transparent manual gate is better than an automated test that fakes a
browser-level property and reports it as real.

CORRECTION-01 makes that gate matter more, not less: the DOI acceptance case in
§8 is now the *only* place where a real `activeTab` grant produces a real
injection into a real publisher's page. Everything the automated lane proves
about the metadata read is true of a real page and a real built function, with
the grant supplied; nothing but the manual test proves Chrome hands that grant
over on a toolbar click.

---

## 8. Manual release acceptance checklist — MANDATORY

**A human must complete this against the release-candidate build before any
Chrome Web Store submission.** It is not optional, and it is not superseded by
the automated lane: **item 5** is the first and only place the real `activeTab`
grant is ever exercised, and **items 9–11** are the only place that grant is ever
turned into a real injection into a real publisher's page.

Build the candidate first: `npm run package:extension`.

> **CORRECTION-01 changed this checklist.** The DOI case (items 9–12) is now the
> acceptance test for the failure that produced the correction, and it is
> written to be performed *the way the failure happened*: navigate through
> doi.org and let the redirect complete before touching the toolbar. Racing the
> redirect tests the old path and proves nothing about the new one.

### Load and icons

- [ ] 1. Load `dist-extension/` unpacked at `chrome://extensions` (Developer mode on) in a **clean Chrome profile**. Confirm it loads with **no error and no warning** — in particular no "could not load icon" warning.
- [ ] 2. Confirm the **PaperLume mark appears in the toolbar**, is recognisable, and is not a generic puzzle-piece placeholder. Check it on both a light and a dark Chrome theme.
- [ ] 3. Confirm the mark on the `chrome://extensions` card (the 48 px icon) and in the install/details dialogue (the 128 px icon) are the same mark, not blurred and not clipped.

### PubMed case

- [ ] 4. Open a real PubMed record, e.g. `https://pubmed.ncbi.nlm.nih.gov/33301246/`.
- [ ] 5. **Click the toolbar action.** This is the step no automated test performs — it is the only place the real `activeTab` grant is exercised.
- [ ] 6. Confirm the popup shows **Paper detected**, source **PubMed**, and the **correct PMID** for that record.
- [ ] 7. Press **Continue in PaperLume**. Confirm **exactly one** new tab opens, at `https://app.paperlume.app/extension-import?kind=pmid&value=<PMID>`.

### DOI case — direct resolver URL

- [ ] 8. Repeat 4–7 with a real `https://doi.org/…` URL that you reach **without** letting it redirect (paste it and click the toolbar action while the address bar still shows doi.org). Confirm source **DOI**, the correct DOI **name** (not a resolver URL), and `kind=doi` with the value percent-encoded.

### DOI case after a redirect — MANDATORY, and the reason CORRECTION-01 exists

This is the scenario that failed owner acceptance of 001E2. Perform it exactly as
written; the point is to be on the *publisher's* page when PaperLume is opened.

- [ ] 9. Navigate normally to `https://doi.org/10.1038/s41586-020-2649-2` — type or paste it into the address bar and press Enter.
- [ ] 10. **Let the resolver redirect finish.** Wait until the publisher page (Nature, for this DOI) has fully loaded and the address bar shows the publisher's URL, not doi.org. **Do not race the redirect** — clicking the toolbar action while doi.org is still in the address bar tests the old URL-only path and proves nothing about this correction.
- [ ] 11. **Click the actual PaperLume toolbar button.** Confirm the popup shows **Paper detected**, source **DOI**, and the DOI **`10.1038/s41586-020-2649-2`** — read from the page's standard metadata, since the publisher URL contains no DOI.
- [ ] 12. Press **Continue in PaperLume**. Confirm **exactly one** new tab opens, at `https://app.paperlume.app/extension-import?kind=doi&value=10.1038%2Fs41586-020-2649-2`, and that the publisher's URL, the article title and the author names appear **nowhere** in it.
- [ ] 13. **Repeat 9–12 with at least one more real DOI from a different publisher** (for example an Elsevier, Springer, Wiley, PLOS or IEEE DOI). This must be a DOI you pick yourself, not one listed here — the fallback reads standard metadata and must not depend on a per-publisher rule. Note any publisher where it fails: a publisher that emits none of the four keys is a *known limitation*, not a defect, and is worth recording rather than fixing with a URL rule.

### Unsupported and restricted pages

- [ ] 14. Open a page that is not a paper at all (a news article, a search results page). Confirm **No paper identified**, that **no Continue control is present**, and that **no identifier was guessed from the page title or body text**.
- [ ] 15. Open a restricted page (`chrome://settings/`, a `file://` URL, and the Chrome Web Store). Confirm **Nothing to check here** and no Continue control. Confirm no error dialog, no crash, and **no Chrome permission error text** anywhere in the popup.
- [ ] 16. Confirm that in cases 14 and 15 **no tab was opened and no navigation occurred** without a press.

### Authentication handoff

- [ ] 17. **Signed out.** With no PaperLume session, press Continue from a supported page. Confirm PaperLume asks you to sign in, and that **nothing is imported** before you do.
- [ ] 18. **Signed in.** With a session, press Continue. Confirm PaperLume shows the identifier, offers Projects and Tags, and **still requires an explicit confirmation** before writing. Confirm nothing was added to the library merely by the tab opening.
- [ ] 19. Confirm the extension itself never asked for credentials, and that closing the PaperLume tab without confirming leaves the library unchanged.

### Permissions and copy

- [ ] 20. Confirm **no permission prompt** appeared at any point — `activeTab` and `scripting` both show no install-time warning — and that `chrome://extensions` still lists **no host access** for the extension. In particular confirm it does **not** say "Read and change your data on all sites" or name any site.
- [ ] 21. Confirm the popup's footnote text is accurate for what you just observed: that it checks the tab only when opened, reads the address first, reads standard DOI metadata when needed, stores nothing, and passes only the identifier on Continue.

### Before entering anything in the Dashboard

- [ ] 22. Re-verify every policy citation in this document **and in [chrome-web-store-listing.md](chrome-web-store-listing.md)** against the live primary source (see the header) — including the `activeTab` and `chrome.scripting` pages this correction relies on.
- [ ] 23. **Confirm the amended public Privacy Policy is live in Production** (§6). Check the served page — not the repository, and not a Preview deployment — and confirm it no longer says the extension does not read the page's contents or DOM, that it discloses the bounded DOI metadata read, and that the effective date reads **August 30, 2026**. Until the *served* page says all three, the disclosed **Website content = Yes** contradicts the posted policy.
- [ ] 24. Confirm the privacy policy URL is **published and publicly reachable in Production, signed out, from a clean browser**. Items 23 and 24 are satisfied by the same visit; do them together and record the date.

> **Items 23 and 24 — last passed 2026-08-30, and deliberately left unchecked.**
> Both were performed and **passed** in public Production, signed out, on
> **2026-08-30**, after PR #258 merged as
> `8144504508df333e850c0ed38ec1352c9579ca24`; that visit is what closed the
> one-time privacy-policy mismatch gate recorded in §6. The boxes stay unticked
> because **this checklist is reusable and is re-run in full for every actual
> Store submission** — a tick here would let a future submission skip a check
> that Production can silently break between now and then. Treat the 2026-08-30
> result as evidence for that date, not as a completed step.
- [ ] 25. Review the five committed listing images in [`assets/store/`](../assets/store) and confirm each is accurate and acceptable to publish — in particular that no caption claims the page is never read.
- [ ] 26. Confirm the Dashboard's **Website content** answer is set to **Yes** and that the permission justification covers **both** `activeTab` and `scripting`.
- [x] 27. ~~Resolve the **promotional video** question (§11) against the **live Developer Dashboard**.~~ **DISCHARGED 2026-08-30 — the live field `Global promo video` carries no required marker. OPTIONAL. No video is a gate.**
- [x] 28. ~~Note whether a **separate store-icon upload field** exists (§10).~~ **DISCHARGED 2026-08-30 — it does. `Store icon *` is REQUIRED, 128×128, with its own upload control. `assets/store/store-icon-128.png` is the candidate to use.**
- [ ] 29. **Change the Privacy form's remote-code answer to `No, I am not using remote code`, and re-read it after saving.** The untouched live form was observed on 2026-08-30 displaying **`Yes, I am using remote code`** with a required `Justification*`. That is **factually wrong** for this package — no remote JS or Wasm, no external script import, no `eval`, no `new Function`, and the injected function is bundled inside `popup.js` (§4). **Do not write a remote-code justification.** If a justification is still demanded after selecting `No`, **stop and report** rather than inventing text.
- [ ] 30. **Provision and verify a dedicated low-privilege reviewer account** for the Dashboard's separate **`Test instructions`** page (Username ≤ 100, Password ≤ 100, Additional instructions ≤ 500). The extension can be checked signed out, but `Continue in PaperLume` → Projects/Tags → confirm import **requires PaperLume authentication**, and a reviewer without an account hits a login wall. Requirements: Production account, **no owner/admin privileges**, no sensitive real-user data, minimal seeded state. **Credentials go only into the Store form — never into Git, a PR description, a report, or chat.** Non-secret steps are drafted in §12.
- [ ] 31. **Confirm each permission justification fits the live 1,000-character cap.** The full drafts in [chrome-web-store-listing.md](chrome-web-store-listing.md) §6 are **over** it (1,071 and 1,470); that document carries measured 981- and 996-character variants to enter instead. Re-measure if either is edited.
- [ ] 32. **Confirm visibility and regions deliberately.** The live Distribution form displays `Public` and all regions **by default**. Those defaults are not decisions, and publishing worldwide by failing to look at them would be an accident, not a choice.

Record the date, the Chrome version, and the tester for each submission.

**Nothing in steps 17–19 requires a destructive change.** Confirming an import is
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
The same holds after CORRECTION-01 — the expected list is the exact ordered pair
`["activeTab","scripting"]`, so a third permission, a dropped one, a reordering
and a duplicate each fail with the expected list named, and each has its own
hostile fixture.

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
permissions exactly `["activeTab","scripting"]` · no host permissions · no
forbidden manifest key · every manifest-referenced file present · no origin other
than `https://app.paperlume.app` in any packaged file · no remote
`src`/`href`/`url()`/`@import` · Chrome API references limited to
`chrome.tabs.query`, `chrome.tabs.create` and `chrome.scripting.executeScript` ·
bounded entry count and total size.

**The `scripting` namespace was not opened, only one member of it.** The packaged
bundle is scanned for `chrome.*` member expressions against an exact allow-list,
so `chrome.scripting.insertCSS`, `chrome.scripting.registerContentScripts` and
`chrome.scripting.getRegisteredContentScripts` all fail the contract — each with
its own hostile fixture. The metadata implementation bundles into the existing
`popup.js`, so **the package is still the same eight files**; no shipping file was
added and the exact inventory is unchanged.

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

> **RESOLVED 2026-08-30 — a separate field does exist.** The live Store Listing
> form exposes **`Store icon *`** — **required**, 128×128, with its own
> drop/upload control. Classification:
> **`STORE ICON — SEPARATE DASHBOARD UPLOAD REQUIRED`**. The packaged
> `icons/icon-128.png` remains required package metadata and is what Chrome
> itself uses; the separate Store field does not replace it. Keeping
> `assets/store/store-icon-128.png` was the right call — it is now the confirmed
> candidate for that upload rather than a speculative extra file, and it has
> **not** been uploaded. See
> [chrome-web-store-listing.md](chrome-web-store-listing.md) §0.5.
>
> The paragraphs below are the historical position, correct when written on
> 2026-08-29, and preserved rather than rewritten.

**What was not claimed, before the live form was seen.** That the candidate is
uploaded through a separate
Dashboard field, that it overrides the packaged icon, or that the Store will
display it instead. The Dashboard had not been inspected and that phase could not
inspect it;
[Prepare your Store listing](https://developer.chrome.com/docs/webstore/cws-dashboard-listing)
lists *"A 128x128 px to use as your store icon"* without settling whether that
field is a separate upload or is read from the package. **That stayed unresolved
until someone opened the live form** — §8 item 21 is where it was checked.

The candidate is kept rather than deleted: a distinct field does exist, so the
separately authorized `001E3C` uses it, and the file costs one
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
- Permission contract (`activeTab` + `scripting`, **zero host permissions**)
- Remote-code compliance (self-contained package)
- **Production icon set** at 16/32/48/128, in both manifest icon maps, measured
  for legibility and transparency (§10)
- **128×128 Store-icon candidate** with the documented transparent padding, and
  the packaged 128 px icon that first-party documentation guarantees is used (§10)
- **Three 1280×800 screenshots** built from real popup captures of the built
  extension, covering PubMed detection, DOI detection, and the unsupported state
  — captions revised by CORRECTION-01 so none claims the page is never read
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

- **Privacy policy URL reachability** — `https://app.paperlume.app/privacy`.
  **Standing, not one-off.** What remains is **confirming it loads in Production,
  signed out, from a clean browser — and still shows the amended §4 and the
  August 30, 2026 effective date** — before *each* submission. Last passed
  **2026-08-30**
- ~~**Promotional video — requirement unresolved.**~~ **RESOLVED 2026-08-30:
  OPTIONAL** in the live form (`Global promo video`, no `*`). No longer an owner
  gate; producing one is a marketing choice
- **Support URL / contact email** — **optional in the live Store form** (no
  `*`), so Google does not compel it. PaperLume publishes no Support page, and
  C16 in [decisions-and-triggers.md](decisions-and-triggers.md) still governs
  Terms and Support as PaperLume's own launch-quality decision. **Two different
  gates; only the Store one is now known to be non-blocking**
- **Category** selection and **language** declaration (listing doc §11) — both
  are **required live fields** (`Category*`, `Language*`) and **neither has been
  chosen**
- **Visibility and regions** — the live Distribution form displays `Public` and
  all regions by **default**. That is not an owner decision, and must not be read
  as one (listing doc §0.8)
- **Reviewer account for Test instructions** — a new, concrete pre-submission
  gate; see §8 item 22
- ~~**Publisher account** — verified developer, 2SV enabled, one-time
  registration fee paid~~ **DONE 2026-08-30:** registration complete, **$5 fee
  paid**, Dashboard accessible, classification intentionally **non-trader** for
  the current non-commercial phase. **Trader reassessment before commercial
  launch remains a future gate** (listing doc §0.10)
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

> **SUPERSEDED 2026-08-30 by the live form.** Requiredness below was inferred
> from documentation; it has now been read off the Dashboard itself. The live
> requirement for this item is **two** graphic assets, not three:
>
> | Live field | Live requiredness | Status |
> |---|---|---|
> | `Store icon *` | **REQUIRED**, 128×128, separate upload control | Candidate ready: `assets/store/store-icon-128.png`. Not uploaded |
> | `Screenshots *` | **REQUIRED**, at least one, max 5; 1280×800 or 640×400; JPEG or 24-bit PNG (no alpha) | Three 1280×800 assets ready, all verified PNG colour type 2 (no alpha). Not uploaded |
> | `Small promo tile` | **OPTIONAL** — no `*` | Ready, 440×280, colour type 2. Not uploaded |
> | `Marquee promo tile` | **OPTIONAL** — no `*` | Not produced. Still not needed |
> | `Global promo video` | **OPTIONAL** — no `*` | Not produced. **No longer a gate** |
>
> **The small promo tile is optional, not mandatory** — this corrects the row
> below, which followed Google's `images` page. Full evidence:
> [chrome-web-store-listing.md](chrome-web-store-listing.md) §0.2, §0.4–§0.6.

**Historical table — inferred from documentation on 2026-08-29, before the live
form was seen:**

| Asset | Requirement | Status |
|---|---|---|
| 128×128 store icon | Required (both pages agree) | **Done** — shipped in the ZIP as `icons/icon-128.png`; a Store-optimised candidate also exists at `assets/store/store-icon-128.png` (§10) |
| Manifest icons 16/32/48/128 | Required in the ZIP | **Done** — emitted from the brand pack (§10) |
| 1280×800 screenshot, 1–5 | Required | **Done** — three, from real popup captures |
| 440×280 small promo tile | Required *(superseded: optional)* | **Done** — `assets/store/promo-tile-small-440x280.png` |
| YouTube promotional video | **Conflicting first-party documentation** — see below | *(superseded: **OPTIONAL** in the live form)* Not produced, and deliberately not faked |
| 1400×560 marquee promo tile | Optional on every first-party reading | Not produced |

**On the video — RESOLVED 2026-08-30: `PROMOTIONAL VIDEO — OPTIONAL IN THE LIVE
PAPERLUME DASHBOARD`.** The live field is **`Global promo video`** and carries
**no `*` required marker**. No video is required, and none will be produced.

The analysis below is **preserved as the historical record**. The documentation
conflict it describes is real and still unfixed on Google's side; what changed is
that the live form answered the operational question. Refusing to guess was
correct — the strictest reading would have manufactured a content gate that does
not exist.

**Historical classification, correct when written on 2026-08-29:**
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

- Every privacy-practices answer and certification — **all three certifications
  must be certified** (listing doc §7)
- The single-purpose field, `Single purpose description*`, max 1,000 (listing doc §5)
- Permission justifications for **both** `activeTab` and `scripting`, each capped
  at **1,000 characters** — use the measured short variants in listing doc §6
- **The remote-code declaration — which must be set to `No`.** The live form was
  observed defaulting to **`Yes`**, which is wrong for this package. See §8
  item 29
- Privacy policy URL — live field `Privacy policy URL*`, **required** (listing doc §8)
- Reviewer test instructions, plus the **reviewer account** they depend on (§12,
  §8 item 30)
- `Category*` and `Language*` — both **required**, neither chosen
- Distribution: visibility and regions — **displayed defaults are not decisions**
- Every image upload — **`Store icon *` and `Screenshots *` are the two required
  ones**; small promo tile, marquee tile and promo video are optional

**Package upload is done** — the validated `0.1.0` release candidate was uploaded
to draft item `cfanjbamcemoeglgkpbidnclkomaocmo` on 2026-08-30.

---

## 12. Reviewer test instructions

Draft for the Dashboard's test-instructions field. **No credentials are created
or embedded**, and none should be.

> PaperLume identifies a scientific paper from the tab you are on — from its URL,
> or from the standard DOI metadata the page publishes — and hands that
> identifier to the PaperLume web app for a user-confirmed import.
>
> **The extension's own functionality is fully demonstrable without an account:**
>
> 1. Install the extension.
> 2. Open `https://pubmed.ncbi.nlm.nih.gov/33301246/`.
> 3. Click the PaperLume toolbar icon. The popup shows **Paper detected**,
>    source **PubMed**, and PMID **33301246** — extracted locally from the URL by
>    the extension, with no network request and no page access at all.
> 4. Open `https://doi.org/10.1038/s41586-020-2649-2` and click the icon again.
>    The popup shows source **DOI** and the DOI name, again from the URL alone.
> 5. Let that DOI link redirect to the publisher (Nature), then click the icon.
>    The publisher's URL contains no DOI, so the extension reads the page's
>    standard `citation_doi` metadata and shows the same DOI. This step is why
>    the `scripting` permission is requested: a DOI resolver redirects before a
>    user can reach the toolbar, and without it the feature is unusable for the
>    ordinary way people follow a DOI. The read happens only here — only after
>    you clicked the icon, only on this tab, and only because the URL identified
>    nothing.
> 6. Open a page that is not a paper (a news article). The popup shows **No paper
>    identified** and offers **no** continuation control — the page names no DOI
>    in its address and publishes none in its metadata, so the extension declines
>    and sends nothing. It does not guess from the title or the body text.
>
> Steps 3–6 are the whole of the extension's behaviour and require no sign-in.
>
> **What the page read is, precisely:** four `<meta>` keys in `document.head` —
> `citation_doi`, `dc.identifier`, `dc.identifier.doi`, `prism.doi` — in the main
> frame only. No document title, no body text, no links, no JSON-LD, no cookies,
> no storage, no other tab. Nothing is retained, nothing is transmitted, and a
> page publishing two genuinely different DOIs is refused rather than resolved to
> either. "Different" is the DOI specification's equivalence test rather than
> string equality: ASCII case is insensitive when DOI names are compared, so one
> DOI written once with capitals and once without is one DOI, not an ambiguity.
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

## 14. Out of scope for 001E1, 001E2 and 001E2-CORRECTION-01

Unchanged by all three, and deliberately so: `/extension-import` behaviour ·
authentication · the importer · Project/Tag selection · normalisation · duplicate
semantics (*"Already in your library"*, with no Project/Tag assignment to the
existing row — 001D remains separate and optional) · any PaperLume business logic
· anything under `supabase/**` (no migration, Edge Function, RLS, RPC, secret, or
Production SQL).

001E2 additionally did **not** change: the Privacy Policy's wording; the
manifest `description`; the popup's markup, styling or behaviour; any provider
tier or plan (Gemini, Vercel, Supabase); or the real-browser harness's safety
properties. It added the `icons` and `action.default_icon` keys and nothing
else to the manifest.

**001E2-CORRECTION-01** changed the detection surface and one permission, and
nothing else. It did **not** add: a host permission of any kind, optional or
otherwise · a content script · a background context or service worker ·
`web_accessible_resources` · `externally_connectable` · the `storage`, `tabs`,
`history`, `cookies` or `identity` permissions · any network primitive · any
remote resource · a second shipping file in the package · a publisher-specific
URL rule · JSON-LD extraction · title, abstract, author or journal extraction ·
any DOI resolver call · a title fallback · automatic import · anything that runs
when the user has not opened the popup.

It also did **not** edit the public Privacy Policy (`src/pages/Privacy.tsx`),
which is owner-approved legal text under separate control. That remains the
correct record of CORRECTION-01's scope. **Superseded 2026-08-30:** the amendment
that text needed was approved by the owner and implemented by
`PRIVACY-POLICY-EXTENSION-METADATA-001B`, which merged as
`8144504508df333e850c0ed38ec1352c9579ca24` and is live in Production — see §6,
where that gate is now recorded as **CLOSED**.
