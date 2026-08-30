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
>
> **Two questions are deliberately left open**, because they cannot be answered
> from documentation alone and the Developer Dashboard has not been — and in
> this phase may not be — opened: whether a **promotional video** is actually
> required (§10, where Google's own pages contradict each other), and whether
> the **store icon** is a separate upload field or is read from the package
> (§9). Both are recorded as unresolved rather than guessed.

> **Amended by CHROME-EXTENSION-IMPORT-001E2-CORRECTION-01 (2026-08-29).** The
> extension now reads standard bibliographic DOI metadata from a page when — and
> only when — the address identified no paper. Three fields below change as a
> result: the **permission justification** (§6) covers `scripting` as well as
> `activeTab`, the **detailed description** (§4) no longer says the page is never
> read, and the drafted **Website content** privacy answer (§7) changes from
> **No** to **Yes**. Web history stays **Yes**. Nothing else about the listing
> moves — the name, the summary, the single purpose and the image set are
> unchanged, and the screenshot captions were revised only where they had become
> false.
>
> **Blocking, and not fixable here:** the published Privacy Policy states the
> extension does not read the page or its DOM, which is no longer true. That text
> is owner-approved and under separate control. See
> [chrome-web-store-readiness.md](chrome-web-store-readiness.md) §6, *BLOCKING
> GATE*.

**Companion document.** [chrome-web-store-readiness.md](chrome-web-store-readiness.md)
is the policy audit, the data-flow evidence, the packaging contract, the
real-browser verification record and the mandatory manual release gate. This
document is the *listing*: the fields and files. Facts are stated in one of
them and linked from the other, never duplicated.

---

## 1. What is being listed

The extension shipped by CHROME-EXTENSION-IMPORT-001B/C1/C2, as amended by
001E2-CORRECTION-01. 001E2 added the production icon set and these listing
materials and changed no behaviour; CORRECTION-01 added the DOI metadata fallback
and the one permission it requires.

```text
user clicks the toolbar action  →  activeTab is granted by that click
    ↓
the extension reads the active tab's URL
    ↓
a local structural classifier: PubMed record, doi.org, or neither
    │
    ├── PubMed or doi.org → the identifier, and the page is never touched
    ├── not a web page    → nothing to check
    └── an ordinary page the address did not identify:
            read four standard DOI <meta> keys from that one tab's head
            → one valid DOI, or nothing
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
> - Publisher article pages that publish a standard DOI tag. A DOI link
>   redirects to the publisher before you can click PaperLume, so when the
>   address names no paper, PaperLume looks for the DOI the page itself
>   publishes — `citation_doi`, `dc.identifier`, `dc.identifier.doi` or
>   `prism.doi`. Many journals include one; not all do.
>
> On any other page, PaperLume tells you it did not identify a paper and offers
> no Continue button. It does not guess from the page title or the text.
>
> **What it does not do**
>
> - It does not read the page except for those four DOI tags, and only when the
>   address identified nothing. No article text, no abstract, no title, no
>   authors, no links, no other part of the page.
> - It does not look at any page until you open PaperLume on it. Chrome gives
>   the extension access to a tab only when you click the toolbar button, and
>   only for that tab.
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
one-click import · **works on any publisher** (it works where the publisher emits
one of four standard tags, which is a real limit and is stated as one) · full-text
capture · AI in the extension · PDF download · reference management inside the
popup · Projects or Tags chosen in the popup · browsing history features · **that
the page is never read**, which CORRECTION-01 removed rather than softened.

---

## 5. Single purpose

Drafted for the Dashboard's single-purpose field. Google requires *"a single
purpose that is narrow and easy to understand"*
([quality guidelines](https://developer.chrome.com/docs/webstore/program-policies/quality-guidelines/)),
and the Dashboard asks for a description *"to help the reviewers understand the
focus of your extension"*
([privacy practices](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy)).

> PaperLume identifies a supported scholarly-paper identifier — a PubMed PMID or
> a DOI — from the tab the user is on, and hands that identifier to the PaperLume
> web application for a user-confirmed import. The identifier is taken from the
> tab's URL where the URL contains one, and otherwise from the standard
> bibliographic DOI metadata the page publishes. It has no other feature: no
> options page, no context menu, no keyboard command, no background task, and no
> capability unrelated to recognising and handing over that one identifier.

The behaviour-by-behaviour inventory backing this, and the minimum-functionality
risk assessment it has to survive, are in
[chrome-web-store-readiness.md](chrome-web-store-readiness.md) §2 and §3. That
assessment is unchanged by 001E2. 001E2-CORRECTION-01 changed the *source* the
identifier may come from and nothing else — no feature was added to make the
extension look more substantial, and none was removed. If anything it
strengthens the minimum-functionality case, because more of the work now happens
locally in the extension before any navigation.

---

## 6. Permission justification

The Dashboard requires a justification *"for each permission"* and an
explanation of *"why your extension needs to use each permission"*
([privacy practices](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy)).
The manifest declares exactly two.

### `activeTab`

> PaperLume reads the URL of the active tab to recognise a PubMed PMID or a DOI
> in it, and — when the URL contains neither — reads the standard DOI metadata
> the page publishes. `activeTab` is the narrowest way to do both: Chrome grants
> it only in response to the user clicking the extension's toolbar action, it
> covers only the tab the user was looking at when they clicked, it is revoked
> when they navigate away, and it shows no install-time warning because it grants
> nothing until the user asks.
>
> The URL is read into a local function, classified, and discarded when the popup
> closes. It is not stored — the extension has no `storage` permission and no
> background context in which anything could persist. It is not transmitted: the
> extension makes no network request at all. If the user presses Continue, only
> the extracted identifier is carried into a PaperLume URL, never the source URL.
>
> Without `activeTab` the extension cannot see any URL, cannot reach any page,
> and has no function.

### `scripting`

> A DOI link (`https://doi.org/10.1038/s41586-020-2649-2`) redirects to the
> publisher almost immediately, so by the time a user clicks PaperLume the
> address bar shows the publisher's URL, which contains no DOI. Without this
> permission PaperLume cannot identify a paper for the most ordinary way people
> follow a DOI.
>
> `scripting` lets PaperLume run one small function in the tab the user just
> invoked it on, which reads the DOI the publisher already publishes in the
> page's metadata — `citation_doi`, `dc.identifier`, `dc.identifier.doi` or
> `prism.doi`, from the document head, in the main frame only. It reads nothing
> else: no article text, no abstract, no title, no authors, no links, no scripts,
> no cookies, no storage. The values are used to identify one DOI and are
> discarded when the popup closes. If a page publishes two genuinely different
> DOIs, PaperLume identifies neither and offers nothing.
>
> It runs only when the URL already failed to identify a paper. On a PubMed
> record or a doi.org link the page is never touched at all.
>
> **`scripting` grants no access to any page by itself.** Injection additionally
> requires host access, and PaperLume declares **no host permissions**: the host
> access comes entirely from `activeTab`, the temporary grant the user's own
> click produces. That is deliberately narrower than requesting host permissions,
> which would give PaperLume standing access to every matching page for as long
> as it is installed, whether or not the user ever asked for anything.

**Evidence that both grants are genuinely gesture-bound**, read from the browser
rather than promised by the extension:

- With no toolbar click, Chrome returns a `Tab` object with **no `url` property
  at all** — `e2e-extension/popup.spec.ts`, *"holds no grant, so Chrome reports
  no tab URL at all"*.
- With no toolbar click, `chrome.scripting.executeScript` against a real tab is
  **refused**: *"Cannot access contents of the page. Extension manifest must
  request permission to access the respective host."* —
  `e2e-extension/load.spec.ts`, *"cannot inject into any page without a toolbar
  grant"*.

**First-party basis for this pairing.** The `activeTab` page states the
permission allows an extension to *"call `scripting.insertCSS()` or
`scripting.executeScript()` on that tab if the `"scripting"` permission is also
declared"*; the scripting reference states injection needs the
*"`host_permissions` key or the `activeTab` permission, which grants temporary
host permissions"*, and that *"by default, an injection will inject into the main
frame of the specified tab"*.
— [activeTab](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab)
· [chrome.scripting](https://developer.chrome.com/docs/extensions/reference/api/scripting)
(both re-read 2026-08-29)

### Privileged APIs used

Three, and the packaged artefact is scanned to prove there is no fourth
(`scripts/lib/extension-package.mjs`, `ALLOWED_CHROME_MEMBERS`).

| API | Where | Why |
|---|---|---|
| `chrome.tabs.query({active:true,currentWindow:true})` | `extension/src/classifyActiveTab.ts` | Read the active tab's URL and id. Reading `Tab.url` is what `activeTab` is for; the `tabs` permission is **not** requested and is not needed for this |
| `chrome.scripting.executeScript({target,func})` | `extension/src/detectPaperFromMetadata.ts` | Read four standard DOI `<meta>` values, once, from the invoked tab's main frame — and only when the URL identified no paper. No `allFrames`, no `files`, no `args`, no `world` |
| `chrome.tabs.create({url})` | `extension/src/popupView.ts` | Open PaperLume in a new tab when the user presses Continue. One press, at most one tab |

### Not requested, and asserted absent

`tabs` · `storage` · `identity` · `cookies` · `webRequest` ·
`declarativeNetRequest` · `contextMenus` · `notifications` · `alarms` ·
`sidePanel` · `history` · `bookmarks` · `downloads` · `nativeMessaging` · any
host permission · any optional permission · content scripts · a background
service worker · `web_accessible_resources` · `externally_connectable`.

The `scripting` **namespace** is not opened either — only
`chrome.scripting.executeScript` is permitted, so `insertCSS`,
`registerContentScripts` and `getRegisteredContentScripts` each fail the package
contract with their own hostile fixture.

Asserted three times over, because each catches a different failure: on the
committed manifest (`extension/src/__tests__/manifest.test.ts`), on the packaged
artefact (`scripts/lib/extension-package.mjs`), and on **what Chrome actually
granted**, read back from the browser (`e2e-extension/load.spec.ts`, *"is granted
exactly activeTab and scripting, and no host origin"* — `origins: []`).

### Remote code

**None.** The package is self-contained: no remote script, stylesheet, font,
image, `url()`, `@import`, `eval`, or `new Function`. The function
`chrome.scripting.executeScript` injects ships **inside the package** — Chrome
serializes it out of `popup.js` at call time — so nothing is fetched, nothing is
evaluated from a string, and no code from the page runs with extension
privilege. The manifest pins the
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
| Reads DOI metadata from the page | Yes, on toolbar click only, and only when the URL identified nothing | No |
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
  action. Then, **only where that URL identified no paper**, four `<meta>`
  `content` values from that one tab's `document.head`, in the main frame:
  `citation_doi`, `dc.identifier`, `dc.identifier.doi`, `prism.doi`. Nothing
  else: no document title, no article title, no abstract, no authors, no journal,
  no body text, no headings, no links, no `data-` attributes, no JSON-LD, no
  inline scripts, no sub-frames, no cookies, no page storage, no other tab.
  Processed locally and transiently — reduced to at most one DOI name and gone
  when the popup closes.
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
  authors · the journal · any metadata value other than the resulting DOI · any
  DOM · cookies · any PaperLume or Supabase session token · the user id · any
  Project id · any Tag id · any analytics identifier · the extension id · a
  timestamp. The `kind`/`value` contract has no third parameter to put any of
  them in, and a real-browser test asserts the publisher host, article title and
  author name appear nowhere in a metadata-detected handoff URL
  (`e2e-extension/metadata.spec.ts`)
- **Never looked up** — the DOI read from a page is **not resolved**. The
  extension does not ask doi.org, Crossref or PubMed whether it exists; it has no
  request API to ask with.

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
| **Web history** | **Yes** | Web browsing activity is *"any information about the websites or other web resources a user requests or interacts with, **including the domains or URLs the browser interacts with**"*. The extension reads the active tab's URL. **Unchanged** by CORRECTION-01. See the note below |
| User activity | **No** | No clicks, mouse position, keystrokes, scroll or interaction telemetry is recorded or sent |
| **Website content** | **Yes** — *changed from No by CORRECTION-01* | The extension reads `<meta>` element content from the page. It is four bibliographic DOI keys, in the head, in the main frame, only when the URL identified nothing — and it is processed locally and transiently, with neither the content nor the page URL transmitted. But content **is** read, and the question asks what is accessed, not what is kept. See the note below |

### Certifications

| Statement | Answer | Basis |
|---|---|---|
| *I do not sell or transfer user data to third parties, apart from the approved use cases* | **Certify** | Nothing is sold or transferred. The identifier goes only to PaperLume, at the user's request, as the feature the user invoked |
| *I do not use or transfer user data for purposes unrelated to my item's single purpose* | **Certify** | The identifier **is** the single purpose |
| *I do not use or transfer user data to determine creditworthiness or for lending purposes* | **Certify** | Not applicable |

### Why "Website content" became Yes

**This answer changed in CHROME-EXTENSION-IMPORT-001E2-CORRECTION-01, and the
change is the honest one rather than a cautious one.** Before that correction the
extension read the tab's address and nothing else, and "No" was accurate. It now
reads four `<meta>` values from the page, which is website content by any
reading, so the answer follows the behaviour.

Three arguments that must **not** be used to keep answering "No", each of them
true and each of them irrelevant to what the category asks:

- that only four bibliographic keys are read, never the article text;
- that the read happens only after an explicit gesture, and only where the URL
  identified nothing;
- that nothing read is retained or transmitted — only a derived public identifier
  travels, and only on a second gesture.

All three belong in the *justification*, and they are stated there. None of them
changes the fact that page content is accessed.

**What the disclosure should make clear**, and what the permission justification
in §6 says:

- the metadata is processed **locally and transiently** — reduced to at most one
  DOI name, held for as long as the popup is open, and gone when it closes;
- **neither the page content nor the source page URL is transmitted**, ever, by
  any path;
- after the user explicitly presses Continue, **only the normalized identifier**
  is handed to PaperLume, as `kind` and `value`;
- **`scripting` does not give standing access to websites.** It has to be paired
  with host access, and this extension declares none — the access comes from
  `activeTab` and lasts for one tab until the user navigates away. Chrome's own
  answer confirms it: `chrome.permissions.getAll()` returns `origins: []`.

**No other category was changed.** In particular nothing was moved to Yes
"to be safe": there is no personally identifiable information, health
information, financial information, authentication material, personal
communication, location data or interaction telemetry read by the extension, and
inventing a Yes where the behaviour does not support one would misdescribe the
product as surely as a wrong No.

**Google has approved nothing.** These remain drafts for a human to enter.

### Why "Web history = Yes" stays Yes

This answer is **locked**. The category definition it rests on was re-read
against first-party policy on 2026-08-29 and is unchanged. (The unresolved
first-party conflicts recorded in §9 and §10 are about *listing assets*, not
about the data-use categories; nothing in the user-data documentation
contradicts itself here.)

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
the extent required for a user-facing feature."* Reading the URL, and reading the
DOI the page publishes when the URL names none, is the entirety of the
user-facing feature; both happen only on a gesture, and nothing is kept.

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
`/privacy` (PAPERLUME-PRIVACY-001B); its §4 is the extension section. There is no
second, Chrome-specific policy and there must not be one.

**§4 history, stated plainly because a stale claim once lived here.** An earlier
revision of this section recorded a 2026-08-29 re-read finding *"no factual
mismatch"*. That was written before `CHROME-EXTENSION-IMPORT-001E2-CORRECTION-01`
landed the DOI metadata fallback, and it did not survive it: the published §4
listed *"read the contents of the webpage or its DOM"* among the things the
extension does not do, which the metadata read made false. The mismatch is
recorded in [privacy-data-flow-audit.md](privacy-data-flow-audit.md) §24.6 and as
a blocking gate in [chrome-web-store-readiness.md](chrome-web-store-readiness.md)
§6.

**The owner approved amended §4 wording on 2026-08-30**, and
`PRIVACY-POLICY-EXTENSION-METADATA-001B` implements exactly that approved copy —
the bounded metadata read, the four supported DOI metadata names, the
locally-and-transiently disclosure, and an affirmative Limited Use statement —
together with an effective date of **August 30, 2026**. **That work is a pull
request, not a published policy.** Until it is merged and deployed, the policy
live at the URL above is still the pre-amendment text, and the mismatch above is
still the live state.

**Limited Use disclosure location.** The approved §4 ends with the affirmative
statement *"PaperLume uses information accessed by the Chrome extension only in
accordance with the Chrome Web Store User Data Policy, including its Limited Use
requirements."* The public Privacy Policy is therefore the disclosure location;
no second copy of that sentence belongs anywhere else, and none should be added
to the listing copy.

**Standing submission gate — open, and it does not close permanently.** Before
**every** Store submission, confirm that URL loads the policy **in Production,
signed out, from a clean browser** with no cached session. Deployment
protection, a routing regression or a rewrite change can each break it without
breaking anything else. See
[chrome-web-store-readiness.md](chrome-web-store-readiness.md) §8 item 12.

Once `PRIVACY-POLICY-EXTENSION-METADATA-001B` merges and deploys, that same
signed-out Production check must additionally confirm the page shows the amended
§4 and the **August 30, 2026** effective date. A Preview deployment is not
Production and does not close this gate.

---

## 9. Listing images

Generated by `npm run store:assets`
([`scripts/export-store-assets.mjs`](../scripts/export-store-assets.mjs)),
committed under [`assets/store/`](../assets/store), and held to their contract by
`scripts/lib/__tests__/store-assets.test.mjs`. Dimensions verified against
[Chrome Web Store images](https://developer.chrome.com/docs/webstore/images) on
2026-08-29.

**Regenerated by 001E2-CORRECTION-01 — the three screenshots only.** A screenshot
caption is a factual claim, and two of them had become false: the PubMed panel
said the extension reads the address *"— nothing else —"* and that *"no page
content is read"*, and the unsupported panel described the address as the only
thing consulted. Both were rewritten rather than hedged, and the DOI panel gained
a line about the redirect case this correction exists for. The captured popups
also changed, because the popup's own footnote and unsupported copy did.

No visual design changed: same layout, same brand ground, same lockup, same type
scale, same crop. `store-icon-128.png` and `promo-tile-small-440x280.png` are
**byte-identical** to before — they carry no UI and no feature claim, so there
was nothing in them to correct, and they were left alone rather than churned. Two
consecutive runs of the generator produce byte-identical output for all five
files, which is how the change was confined to the three that had to move.

| Asset | File | Size | Source | Method | Deterministic? | Hand-edited? | Depicts real behaviour? |
|---|---|---|---|---|---|---|---|
| Store-icon **candidate** | `assets/store/store-icon-128.png` | 128×128 | `assets/brand/svg/paperlume-symbol.svg` | Vector render, uniform scale to the documented content box | Yes — pure vector, no type | No | n/a — brand mark, makes no claim |
| Packaged 128 icon (**guaranteed**) | `icons/icon-128.png`, in the RC ZIP | 128×128 | `assets/brand/png/paperlume-128.png` | Byte copy at build time | Yes — byte copy | No | n/a — brand mark |
| Small promo tile | `assets/store/promo-tile-small-440x280.png` | 440×280 | `paperlume-logo-horizontal.svg` on a brand gradient | Composition; wordmark recoloured for dark ground per brand spec §5a | Vector yes; the one text line uses the host UI font | No | n/a — brand composition, no UI shown |
| Screenshot 1 | `assets/store/screenshot-1-pubmed-1280x800.png` | 1280×800 | **Real popup**, `dist-extension/` in real Chromium | Captured at 2×, composed onto a caption panel | Layout yes; type uses the host UI font | No | **Yes** — real PubMed detection, from the URL alone with no page access |
| Screenshot 2 | `assets/store/screenshot-2-doi-1280x800.png` | 1280×800 | **Real popup**, same lane | Same | Same | No | **Yes** — real DOI detection |
| Screenshot 3 | `assets/store/screenshot-3-unsupported-1280x800.png` | 1280×800 | **Real popup**, same lane | Same | Same | No | **Yes** — real unsupported state |
| Marquee promo tile | — | 1400×560 | — | Not produced | — | — | **Optional** on every first-party reading; deliberately skipped |
| Promotional video | — | — | — | Not produced | — | — | **Requirement unresolved** — see §10 |

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

Screenshot 3 remains accurate after CORRECTION-01, and the reason is worth
recording. The capture harness supplies the tab URL but no `activeTab` grant, so
the real `chrome.scripting.executeScript` the popup now attempts is refused by
Chrome exactly as it would be on any ungranted tab — and the popup falls closed
to *No paper identified*, which is the state the screenshot is of. The image
therefore still shows a real popup reaching a real state by a real code path; it
is simply not a picture of the metadata fallback succeeding. That case is
covered by the automated lane and by the manual gate, not by a listing image.

Screenshot 3 exists on purpose. The unsupported state is not a failure to hide;
it is the extension declining to guess, and it is the clearest available answer
to a reviewer asking whether this is merely a link to a website.

### The two 128px icons, and which one is guaranteed

There are two 128×128 PaperLume files in this repository, and it matters which
claim is made about each.

**`icons/icon-128.png` inside the RC ZIP is the guaranteed one.** First-party
documentation is unambiguous that the 128px extension icon travels in the
package: *"You must provide a 128x128-pixel extension icon image **in the ZIP
file of your extension**"*
([images](https://developer.chrome.com/docs/webstore/images)), and the
[upload preparation](https://developer.chrome.com/docs/webstore/prepare) page
treats `icons` as manifest metadata that must be correct **before** upload —
*"After uploading your item, you won't be able to edit the metadata of your
manifest in the developer dashboard."* So the packaged icon is the one the
documentation guarantees is used. It is the canonical brand export, byte for
byte.

**`assets/store/store-icon-128.png` is a Store-optimised candidate**, not a
confirmed upload. It applies the Store's own documented framing to the identical
locked geometry: *"The actual icon size should be 96x96 (for square icons); an
additional 16 pixels per side should be transparent padding, adding up to
128x128 total image size."* The PaperLume mark is a portrait page rather than a
square, so 96×96 is read as the box it must fit *within* — the mark is scaled so
its taller axis is exactly 96 px, giving 16 px of transparent padding top and
bottom and 28 px left and right, both at or above the documented minimum.

**What is NOT claimed.** This document does not assert that the candidate is
uploaded through a separate Dashboard field, that it overrides the packaged
icon, or that the Chrome Web Store will display it rather than the manifest
icon. The Dashboard has not been inspected — 001E2 and this correction are not
authorised to open it — and
[Prepare your Store listing](https://developer.chrome.com/docs/webstore/cws-dashboard-listing)
lists *"A 128x128 px to use as your store icon"* among the graphic assets
without settling whether that field is a separate upload or is read from the
package. Until someone looks at the live form, that is unresolved.

**Consequence for 001E3.** If the live Dashboard exposes a distinct store-icon
upload field, the candidate is ready to use. If it does not, the packaged icon
is already correct and the candidate costs nothing but a tracked file. Either
way no action is needed now, and the asset is kept rather than deleted for an
unresolved submission path.

The difference between the two files is **one uniform scale and one offset**. No
path data, colour, proportion or gradient differs; the candidate is the same
mark, not a second one. Measured on the produced files: packaged 128 → mark
80×108 with 24/10 px margins; candidate 128 → mark 72×96 with 28/16 px padding.
The brand system's own 5-unit margin — *"a toolbar icon that floats in the
middle of its box reads as smaller than its neighbours"* (`brand-spec.md` §3) —
is why the packaged set is not simply re-padded to match.

---

## 10. Promotional video — `FIRST-PARTY DOCUMENTATION CONFLICT`

**Classification:**
`PROMOTIONAL VIDEO REQUIREMENT — FIRST-PARTY DOCUMENTATION CONFLICT; LIVE DASHBOARD VERIFICATION REQUIRED BEFORE SUBMISSION`

**Not "required". Not "optional".** Google's own documentation says both, on
different pages, and 001E2 cannot resolve which one the submission form actually
enforces without opening the Developer Dashboard — which this phase is not
authorised to do.

### The three first-party pages, read verbatim on 2026-08-29

| Source | What it says about a video |
|---|---|
| [Prepare your Store listing](https://developer.chrome.com/docs/webstore/cws-dashboard-listing) | *"In this section, you **must provide** the following promotional images and video, with the exception of the Marquee promo tile, which is optional:"* — and the list it introduces contains *"A link to a **YouTube video** that showcases your extension features."*, carrying **no** optional marker |
| [Image guidelines](https://developer.chrome.com/docs/webstore/images) | *"**Only** the extension icon, a small promotional image, and a screenshot are **mandatory**."* A video is **not mentioned anywhere on the page** |
| [Best listing practices](https://developer.chrome.com/docs/webstore/best-listing) | *"You must provide at least one—and preferably the maximum allowed five—screenshots of your item to be displayed in the store."* and *"Use screenshots (**or videos**) to convey the capabilities, look and feel, and experience of your item to users."* — a video appears as an **alternative** means, never as a required asset |

These cannot all be true at once. The Image-guidelines sentence is exhaustive
("**only** … are mandatory") and excludes a video; the Dashboard-listing
sentence includes one among things you "must provide". The Best-listing page
requires a screenshot and treats a video as an alternative way to show the same
thing.

### What this phase can and cannot conclude

**Can:** three assets are required on every reading that speaks to them — the
store icon, at least one screenshot, and the small promo tile. Sources A and B
both name all three; Source C speaks only to screenshots, and requires one. No
page contradicts any of the three. All are produced (§9).

**Cannot:** whether the Dashboard's video field is enforced. That is a property
of the live form, not of the documentation, and the two are different artefacts.
**No Dashboard access is authorised in 001E2 or in this correction**, so the
question is left open rather than answered by guessing.

**Do not read an exemption into visibility either.** The distribution
documentation states *"All visibility settings have the same policy requirements
and will go through the same review process"*
([distribution](https://developer.chrome.com/docs/webstore/cws-dashboard-distribution)).
That means unlisted and private do not get a *lighter policy review* — it does
**not** settle whether this particular listing field is mandatory, in either
direction. Earlier drafting of this document used that sentence to argue the
video is required for all visibilities; that inference does not hold and has
been removed.

### The gate, stated as an owner action for 001E3

Before any submission, the owner verifies against the **live Developer
Dashboard** whether the promotional-video field is required for the chosen
visibility, and then:

- **if the live form requires it** — producing and hosting a YouTube video
  becomes an owner **content gate** at that point. It needs a script, a
  recording of the real extension, and a hosted URL, none of which exist here;
- **if the live form does not require it** — it stays deferred, and no video is
  produced.

**Nothing was produced either way, and nothing was uploaded to YouTube.** No
filler video was made to clear an unresolved question: a video created only to
retire a checklist row would be worse than an honest gap, and the row is not
even known to exist.

**Marquee promo tile (1400×560)** is optional on both readings — Source A names
it as the explicit exception, and Source B omits it from the mandatory three —
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
  privacy questionnaire, and no video question to answer.
- Chrome shows a developer-mode warning, and the extension is not distributed to
  anyone else.
- **Legal/provider gates: none beyond what already applies to the owner using
  PaperLume.**
- This is what the manual acceptance checklist already exercises. It needs
  nothing from this document.

### B. Private or unlisted Store distribution (limited beta)

- **Same review, same policy requirements.** *"All visibility settings have the
  same policy requirements and will go through the same review process."* So the
  full listing package, the privacy questionnaire, the privacy-policy URL and
  the registration fee all apply. That sentence is about *policy review*, and it
  does **not** settle whether the promotional-video listing field is required —
  see §10; do not read either a requirement or an exemption into it.
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
