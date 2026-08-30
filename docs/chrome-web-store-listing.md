# Chrome Web Store listing — PaperLume extension

> **Status: submission-ready draft. Nothing here has been submitted.**
>
> This is the authoritative repository record of **what a human would enter into
> the Chrome Web Store Developer Dashboard** for the PaperLume extension: the
> listing copy, the single-purpose statement, the permission justifications, the
> privacy/data-use answers, and the listing images with their provenance.
>
> **A draft Store item now exists — see §0, which supersedes the paragraph
> below.** `CHROME-EXTENSION-IMPORT-001E3A` created one PaperLume draft item
> (`cfanjbamcemoeglgkpbidnclkomaocmo`) on **2026-08-30** and uploaded the
> approved 0.1.0 package. **No listing, privacy or distribution field has been
> deliberately populated or saved, and nothing has been submitted or published.**
>
> *Historical, and true when written (through 2026-08-29):* **No Store item
> exists.** No package has been uploaded, no listing created, no distribution
> chosen, no visibility set, no privacy answer entered in Google's form, no fee
> paid, and no video published. Every field below is text in this repository
> waiting for owner review. External Store mutation belongs to
> `CHROME-EXTENSION-IMPORT-001E3` and requires explicit owner authorization.
>
> Every requirement, limit and dimension below was read from Google's own
> first-party documentation on **2026-08-29** and is cited inline. Store
> requirements change without notice: **re-verify every citation against the
> primary source before submitting**, the same standing rule
> [chrome-web-store-readiness.md](chrome-web-store-readiness.md) applies to its
> policy citations.
>
> **Both previously open questions are now RESOLVED from the live form — see
> §0.** The promotional video is **optional**; the store icon **is a separate
> required Dashboard upload**. The paragraph below records why they were left
> open, and is retained as the reasoning that produced the correct answer rather
> than a guess.
>
> *Historical, and true when written (2026-08-29):* **Two questions are
> deliberately left open**, because they cannot be answered from documentation
> alone and the Developer Dashboard has not been — and in this phase may not be
> — opened: whether a **promotional video** is actually required (§10, where
> Google's own pages contradict each other), and whether the **store icon** is a
> separate upload field or is read from the package (§9). Both are recorded as
> unresolved rather than guessed.

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
> **Privacy-policy mismatch — CLOSED 2026-08-30.** CORRECTION-01 left the
> published Privacy Policy stating the extension does not read the page or its
> DOM, which had become untrue and was not fixable here. The owner approved
> amended §4 wording; `PRIVACY-POLICY-EXTENSION-METADATA-001B` (PR #258)
> implemented it and **merged on 2026-08-30** as
> `8144504508df333e850c0ed38ec1352c9579ca24`; and
> `https://app.paperlume.app/privacy` was verified **signed out in public
> Production** on 2026-08-30 showing the amended §4 and the **August 30, 2026**
> effective date. The disclosed **Website content = Yes** no longer contradicts
> the posted policy. §8 and
> [chrome-web-store-readiness.md](chrome-web-store-readiness.md) §6 carry the
> evidence. **A standing per-submission reachability and content re-check of that
> URL remains required** — see §8.

**Companion document.** [chrome-web-store-readiness.md](chrome-web-store-readiness.md)
is the policy audit, the data-flow evidence, the packaging contract, the
real-browser verification record and the mandatory manual release gate. This
document is the *listing*: the fields and files. Facts are stated in one of
them and linked from the other, never duplicated.

---

## 0. Live Dashboard reconciliation — 2026-08-30 (`CHROME-EXTENSION-IMPORT-001E3B`)

**This section is the current-state authority for anything the live Developer
Dashboard settles.** Where it and a later section disagree, this one wins and the
later section carries a pointer. Sections below are preserved as the drafting and
evidence record; §13 of this document lists what was explicitly not performed at
each earlier snapshot, and those snapshots are not rewritten.

**Evidence class.** Owner-observed, from an authenticated Developer Dashboard
session on 2026-08-30, on the real PaperLume draft. This is stronger than the
first-party documentation cited elsewhere in this document, because it is the
form itself rather than a page describing the form. Where a Google doc and the
live field disagree, **the live field governs for this item** — and only for this
item, since the Dashboard varies by item type, account and rollout.

### 0.1 The draft item

| Fact | Live value |
|---|---|
| Item ID | `cfanjbamcemoeglgkpbidnclkomaocmo` |
| State | **Draft — not published.** The published side reads *"This item is not published yet"* |
| Version | `0.1.0` |
| Item type | Extension |
| Permissions shown | `activeTab`, `scripting` |
| CRX file | `main.crx` |
| Public-key view | Available — **deliberately not opened** |
| Verified CRX uploads | An `Opt in` control exists — **deliberately not opted in** |

**Package provenance, stated at its real evidence strength.** The ZIP validated
locally before the owner-assisted upload was
`release/paperlume-extension-0.1.0-rc.zip`, **15788 bytes**, SHA-256
**`0feb935d914af2141c41aa129bf211cf08492a5d4ccb5e169bab8afb9f9c4634`**, with
exactly the eight-entry inventory the packaging contract requires
(`icons/icon-{16,32,48,128}.png`, `manifest.json`, `popup.css`, `popup.html`,
`popup.js`), manifest v3, version `0.1.0`, permissions exactly
`activeTab` + `scripting`, zero host permissions, no shipping `key`, no remote
code. Pre-upload validation was green: package-integrity and source-boundary
checks, **395/395** extension unit and boundary tests, and **30/30** real-Chromium
extension tests.

**The Dashboard does not expose the uploaded ZIP's SHA-256**, so nothing here
claims Google attests that hash. The hash is *local pre-upload provenance*: it
establishes what was validated and handed over, not what Google independently
verified. The Store shows a derived `main.crx`, which is a different artefact
with a different digest.

### 0.2 Requiredness, resolved from the live form

A `*` in the live form is the required marker. Read directly off the fields:

| Live field | Required? | Note |
|---|---|---|
| `Description*` | **Required** | Live limit **16,000** characters |
| `Category*` | **Required** | Owner has not chosen from the live list |
| `Language*` | **Required** | Owner has not made a live selection |
| `Store icon *` | **Required** | 128×128. **A separate Dashboard upload control exists** |
| `Screenshots *` | **Required** | At least one; max 5; 1280×800 or 640×400; JPEG or 24-bit PNG (no alpha) |
| `Small promo tile` | **Optional** — no `*` | 440×280; JPEG or 24-bit PNG (no alpha) |
| `Marquee promo tile` | **Optional** — no `*` | 1400×560; JPEG or 24-bit PNG (no alpha) |
| `Global promo video` | **Optional** — no `*` | Asks for a YouTube video URL |
| `Official URL` | Optional | Currently `None`; offers `Add a new site`; help text refers to ownership via Google Search Console |
| `Homepage URL` | Optional — no `*` | |
| `Support URL` | Optional — no `*` | See §0.6 |
| `Mature content` | Toggle, currently off | |
| `Single purpose description*` | **Required** | Max 1,000 |
| `activeTab justification*` | **Required** | Max 1,000 |
| `scripting justification*` | **Required** | Max 1,000 |
| `Privacy policy URL*` | **Required** | This item declares user-data handling |

### 0.3 Title and summary are package-derived — and the summary has no editable field

The live form labels these **`Title from package`** and **`Summary from
package`**, showing `PaperLume` and *"Identify the scientific paper on the page
you are viewing."*

**This corrects §3 of this document.** §3 previously said the summary "can be
overridden there". **No editable summary field was observed on the live Store
Listing form.** For the 0.1.0 package, changing the summary must therefore be
treated as a **package/manifest change requiring a new package upload**, not a
Dashboard edit — unless future live evidence establishes another mechanism.

**Recommendation for this release: keep the package summary unchanged.** The
shipped 56-character string is approved user-facing copy, it is truthful, and the
alternative wording drafted in §3 is not worth a version bump and a re-upload on
its own. `extension/manifest.json` is deliberately not edited.

### 0.4 Promotional video — RESOLVED: OPTIONAL

**`PROMOTIONAL VIDEO — OPTIONAL IN THE LIVE PAPERLUME DASHBOARD`**

The live field is **`Global promo video`** and **carries no `*` required
marker**. It asks for a YouTube video URL.

This supersedes the operational question in §10 for this item. **The first-party
documentation conflict recorded in §10 is real and is preserved** — Google's
`cws-dashboard-listing` page does list a video among assets you "must provide",
while `images` says "**only** the extension icon, a small promotional image, and
a screenshot are **mandatory**". The live form settled which one the submission
flow actually enforces. That is exactly why §10 refused to guess, and the refusal
was correct: a guess in either direction had even odds.

**No video is required, and none will be produced.** If one is ever made it is a
marketing choice, not a submission gate.

### 0.5 Store icon — RESOLVED: SEPARATE DASHBOARD UPLOAD REQUIRED

**`STORE ICON — SEPARATE DASHBOARD UPLOAD REQUIRED`**

The live field is **`Store icon *`** — required, 128×128, with its own
drop/upload control on the Store Listing form.

This resolves the ambiguity in §9. Both halves of §9's careful claim survive:

- the packaged `icons/icon-128.png` remains **required package metadata** and is
  what Chrome itself uses; the separate Store field does **not** remove it;
- `assets/store/store-icon-128.png` was prepared *for exactly this possibility*
  and is now the **confirmed candidate** for the separate upload rather than a
  speculative extra file.

Keeping that candidate rather than deleting it was the right call, and this is
the evidence that settles it. It is **not uploaded here**.

### 0.6 Small promo tile — CORRECTED: OPTIONAL

**`SMALL PROMO TILE — OPTIONAL`**

The live `Small promo tile` field carries **no `*`**. This **corrects a stale
claim in this document and in
[chrome-web-store-readiness.md](chrome-web-store-readiness.md)**, both of which
recorded the small promo tile as one of three mandatory assets, on the strength
of Google's `images` page.

The live form recognises exactly **two** required graphic assets for this item:
the **Store icon** and at least one **screenshot**. The prepared 440×280 tile
remains available as an optional marketing asset.

**Screenshots fit as produced.** The three committed 1280×800 assets match one of
the two live-accepted sizes. One caveat to check at upload time: the live form
says **24-bit PNG (no alpha)**, and the generated screenshots must be confirmed
alpha-free before the separately authorized entry task uploads them. That is a
verification step, not a known defect.

### 0.7 Support URL is optional in the Store form — and that is not the whole question

The live `Support URL` field carries **no required marker**. Any statement that
the Chrome Web Store *requires* a support URL is wrong and is corrected.

**This does not dissolve the project's own decision.** C16 in
[decisions-and-triggers.md](decisions-and-triggers.md) treats Terms and a support
surface as unimplemented launch blockers, and that decision stands on its own
product-quality reasoning. The two are simply different gates: *the Store will
accept a submission without a support URL; PaperLume's own launch-quality
decision is a separate matter for the owner.* Nothing in C16 is changed here
beyond removing the false implication that Google compels it.

### 0.8 Distribution — displayed draft state is not an owner decision

Observed on the untouched Distribution form:

| Control | Displayed state | Status |
|---|---|---|
| Payments | `Free of charge` selected (alternative: `Contains in-app purchases`) | Correct for this package — it contains no purchase flow. **Reassess if the commercial model changes** |
| Visibility | `Public` selected; `Unlisted` and `Private` offered; Private describes trusted testers and Google Groups with a current `None` selector | **NOT an owner decision.** Default draft state only |
| Regions | All regions, all unlisted regions, and visible country rows checked | **NOT an owner decision.** Default draft state only |

**Read this carefully: the displayed `Public` / all-regions state is the form's
default, not authorization to publish worldwide.** No visibility or region choice
has been frozen by the owner. The repository recommendation remains a **limited
beta before any public listing** (§12). Treating a default as a decision is how a
draft becomes an accidental worldwide launch.

### 0.9 Test instructions — the reviewer-account gate, now CLOSED

The Dashboard exposes a separate **`Test instructions`** page. It states that
where login, authentication or specific setup is required, the developer should
supply reviewer credentials and steps, and that the information is confidential
and used for review.

Live fields: **Username** (max 100) · **Password** (max 100) · **Additional
instructions** (max 500).

**This matters for PaperLume specifically.** The extension identifies a paper and
shows it **signed out** — a reviewer can verify the whole extension surface with
no account. But the *end-to-end* story the listing tells, `Continue in
PaperLume` → Projects/Tags → confirm import, **requires PaperLume
authentication**. A reviewer who cannot sign in sees the handoff tab and a login
wall.

**GATE — create/verify a dedicated low-privilege Chrome Web Store reviewer
account before submission. DISCHARGED 2026-08-30** — the requirements below are
what the provisioned account was verified against; see the closure note after
them:

- a Production account suitable for Store review;
- **no owner or admin privileges**;
- **no sensitive real-user data**;
- enough minimal seeded state to exercise Projects/Tags/import if needed;
- credentials entered **only** into the Store `Test instructions` fields.

**Credentials must never be committed to Git, written into a PR description or
report, or sent through chat.** Non-secret reviewer *steps* may live in the
repository — [chrome-web-store-readiness.md](chrome-web-store-readiness.md) §12
already drafts them. **The account is not created by this task**, which is
documentation-only.

> **GATE CLOSED — 2026-08-30.** The paragraph above described the phase in which
> no account existed; it is preserved as chronology and superseded by this note.
> The dedicated low-privilege reviewer account has since been provisioned in
> PaperLume Production and verified: exactly one Auth user with one confirmed
> email identity, one `profiles` row, one ordinary **Free** entitlement, one
> lifetime AI counter, and zero rows for internal access, subscriptions,
> subscription events and usage credits — no owner/manager/admin privilege, no
> billing identifiers, no quota exemption, and an empty library. The audited
> evidence is in
> [chrome-web-store-readiness.md](chrome-web-store-readiness.md) §8 item 30.
>
> **The credentials exist and are owner-held outside Git and chat. They have not
> been entered into the Chrome Web Store**, and they are to be entered only into
> Google's confidential `Test instructions` fields under the separately
> authorized `001E3C`.
>
> **No preseeded Project/Tag/Paper fixture is required, and none was created.**
> The authenticated import page's Project and Tag selection is optional and its
> confirm control works with none selected, so the canonical import completes on
> an account whose library is empty — the preferable state, because it minimises
> Production test data and shows the reviewer an ordinary new-user baseline. The
> identity still holds the ordinary account and authentication records any user
> has; what it holds none of is seeded research or library content. See
> readiness §12.

### 0.10 Publisher account — current state

- Chrome Web Store developer registration **completed**;
- the one-time **$5 developer fee is paid**;
- Developer Dashboard **accessible**;
- publisher classification **NON-TRADER** — both the observed Dashboard setting
  and, since **2026-08-30**, the owner's explicitly frozen declaration for the
  current beta submission (see below);
- trader verification **not completed**; **no public trader address added**.

This supersedes the "Publisher account — not done" row in §11 and the
"no fee paid" statements in the banner and §13.2.

### Trader/non-trader — the owner's frozen declaration, and the check that survives

**`TRADER STATUS — OWNER DECISION FROZEN: NON-TRADER. RE-CONFIRM IMMEDIATELY
BEFORE ANY STORE SUBMISSION`**

**Current owner-selected CWS publisher declaration: Non-trader.** The owner
explicitly froze this on **2026-08-30** for the current beta Chrome Web Store
submission path, and the Dashboard is configured as Non-trader. This supersedes
every statement in this repository that still treated the selection as an
unresolved owner decision *for this submission*.

**What that is, and what it is not.** It is the **owner's own self-declaration**
— which is exactly what Chrome asks for. It is **not** a finding by Google that
Non-trader is correct, not a legal opinion, and not a conclusion this repository
reached; nothing here adjudicates the question. Two things in particular are
**not** the reasoning behind it: being pre-commercial does not on its own make an
account Non-trader, and not wanting to publish a home address is an owner
concern, not Chrome's trader test.

**Chronology — preserved, not rewritten.** The paragraphs below record the
compliance uncertainty that was live before the owner froze the decision. They
are kept because the reasoning still constrains the pre-submission re-check, and
because pretending the uncertainty never existed would be a worse record.

**Why the earlier framing was wrong, stated plainly.** An earlier revision of
this section called Non-trader *"correct for the current non-commercial phase"*
and treated the reassessment as a **future commercial-launch** gate. **Both
claims are withdrawn.** They rested on the assumption that trader status follows
from whether the item is paid. It does not. Chrome's own definitions are
**purpose-based**, re-read first-party on **2026-08-30**:

> **Trader** — *"Any natural person or any legal person, who is acting for
> purposes relating to his trade, business, craft or profession in relation to
> contracts on this marketplace."*
>
> **Non-trader** — *"Any natural person or any legal person, who is acting for
> purposes which are outside of his trade, business, craft or profession in
> relation to contracts on this marketplace."*
>
> *"It is the developer's responsibility to accurately self-declare their
> trader/non-trader status."*
> — [Trader disclosure](https://developer.chrome.com/docs/webstore/program-policies/trader-disclosure)

Being pre-commercial is therefore **not** on its own a basis for declaring
Non-trader, and "it isn't paid yet" is not the test.

**There is a fact here that had to be weighed, not ignored — and the owner has
now weighed it.** The published
Privacy Policy states that PaperLume *"is operated by **Maor Pichadza**, an
individual sole proprietor in Israel operating under the business name
**MutriSport**"*, while also describing the service as a *"pre-commercial beta
service"*. Those two statements pull in opposite directions against a
purpose-based test. **This document does not resolve that tension and must not
be read as doing so.** The owner's declaration is the owner's; this document
records it, and records that the underlying question is one only the owner can
answer.

**GATE — what survives, and it is NOT discharged.** The owner *decision* is
frozen. The *check* is not. **Before the actual submission action, re-read the
then-current
[trader disclosure](https://developer.chrome.com/docs/webstore/program-policies/trader-disclosure)
policy and confirm that the Dashboard declaration still matches the owner's
intended self-declaration and that no relevant policy or factual change has
occurred since 2026-08-30. Do not silently change it during Store entry.** If the
owner's assessment moves to Trader, trader verification and the required public
trader information must be completed **before** submission — and note that Chrome
makes verified trader information *"available to users of the Chrome Web Store"*,
so this is a disclosure decision, not only a form field.

**No live account setting has been changed by any task in this series**, and none
should be outside the separately authorized Store-entry task.

### 0.11 What is still an owner decision

> **SUPERSEDED IN PART, 2026-08-30 by `CHROME-EXTENSION-IMPORT-001E3C` — see
> §0.12.** Every row below that was open at the time of writing has since been
> **decided by the owner and entered in the live Dashboard**: Category, Language,
> Visibility and Regions. The table is kept as the record of what was genuinely
> undecided when §0 was written; §0.12 is the current state.

Live evidence removed the *documentation* ambiguities. It did not make any of
these choices:

| Open item | Why it is still open |
|---|---|
| ~~**Category**~~ | Required field; owner has not chosen from the live list. `Workflow & Planning` remains a suggestion only. **CLOSED 2026-08-30 — owner chose `Workflow & Planning`; entered and saved (§0.12)** |
| ~~**Language**~~ | Required field; English (United States) is expected but no live selection is saved. **CLOSED 2026-08-30 — owner chose `English (United States)`; entered and saved (§0.12)** |
| ~~**Visibility**~~ | Public / Unlisted / Private — displayed state is a default, not a decision. **CLOSED 2026-08-30 — owner chose `Unlisted`; entered and saved (§0.12)** |
| ~~**Regions**~~ | Displayed all-regions state is a default, not a decision. **CLOSED 2026-08-30 — owner chose `All regions`; entered and saved (§0.12)** |
| **Homepage / Official / Support URLs** | All optional; none chosen. Official URL additionally needs Search Console ownership. **Still open — deliberately left blank in the saved draft** |
| **Optional marketing assets** | Small promo tile, marquee tile, promo video — all optional, none required. **Still open — deliberately omitted from the saved draft** |
| ~~**Reviewer account**~~ | **CLOSED 2026-08-30** — provisioned and verified low-privilege (§0.9; readiness §8 item 30). What remains is the Store-entry step of typing the owner-held credentials into `Test instructions`; **no fixture is required** |
| ~~**Trader/non-trader classification**~~ | §0.10. **Owner decision frozen 2026-08-30: Non-trader** for the current beta submission. Not an open choice any more; what remains is re-reading the then-current policy and confirming the Dashboard declaration still matches the owner's intent **immediately before the submission action** |

---

### 0.12 The populated draft — 2026-08-30 (`001E3C` entry, `001E3D` audit)

**This subsection is the current state.** It supersedes §0.11's open rows and
§13.1's "still not performed" list. `CHROME-EXTENSION-IMPORT-001E3C` populated
and saved the draft under owner authorization limited to draft mutations;
`CHROME-EXTENSION-IMPORT-001E3D` then re-read every page **read-only** and
changed nothing. **The item is still `Draft`. Nothing has been submitted, and
nothing is published.**

**Store Listing — saved.**

| Field | Saved value |
|---|---|
| Title | `PaperLume` — package-derived, not edited |
| Summary | `Identify the scientific paper on the page you are viewing.` — package-derived, **unchanged**; no editable field exists (§0.3) |
| Detailed description | Populated from §4, **2,602 characters** as plain text |
| Category | **`Workflow & Planning`** — the UI stores the leaf value only |
| Language | **`English (United States)`** (`en_US`) |
| Store icon | `assets/store/store-icon-128.png` |
| Screenshots | `screenshot-1-pubmed`, `screenshot-2-doi`, `screenshot-3-unsupported` — **three, in that order** |
| Promo video / small tile / marquee tile | **Empty** — all optional, deliberately omitted |
| Homepage / Support URL | **Empty**; Official URL `None` |
| Mature content | **Off** |

**Privacy — saved.** Single purpose (§5, 534 characters); `activeTab`
justification (§6 short form, **981** characters); `scripting` justification (§6
short form, **996** characters) — all three inside the live 1,000-character cap.
**Remote code = `No, I am not using remote code`, and no remote-code
justification is stored.** That closes the §0-era finding that the untouched form
displayed `Yes`: the live form was corrected by selecting `No`, and the answer
persisted across save and reload. Data categories are exactly **Web history =
Yes** and **Website content = Yes**, with the other seven **No**; **all three
certifications** are certified; `Privacy policy URL` is
`https://app.paperlume.app/privacy`.

**A live-form detail worth recording, because it contradicts the natural
reading.** After selecting `No`, the remote-code `Justification` field **remains
visible** and still carries a static `required` attribute in the DOM — as do all
four textareas on the page, including ones that are plainly conditional. The
attribute is therefore **not** the form's requiredness signal; the `*` marker is
(§0.2), and that field carries none. The Dashboard's own blocker panel never
listed a remote-code justification, and Privacy saved cleanly with the field
empty. **Do not infer requiredness from the DOM attribute on this form.**

**Test instructions — saved.** Reviewer credentials are populated in Google's
confidential `Test instructions` fields, entered by the owner directly into the
browser. The additional-instructions text is the 419-character reviewer script.
**No credential is recorded in this repository, and none may be.**

**Distribution — saved.** `Free of charge`; visibility **`Unlisted`** (Public and
Private both unselected); **`All regions`** with the companion `All unlisted
regions` control also selected — 155 of 155 region controls checked, none
deselected individually.

**Package — untouched.** Still `0.1.0`, item type Extension, permissions
`activeTab, scripting`, `main.crx`, **not opted in** to Verified CRX uploads, and
the public key was not viewed.

**Publisher contact email — the gate that only the live Dashboard revealed.**
`001E3C` found two **publisher-account** blockers that no item field could
satisfy: a contact email had to be **provided** and then **verified** on the
Settings page. They blocked *publication*, not draft saving — every draft save
succeeded with them outstanding. The owner has since completed both manually.
`001E3D` confirmed it: Settings shows a **verified** contact email address. **The
address itself is deliberately not recorded here**; it is publicly displayed by
Google in connection with the item, which is a disclosure the owner accepted, not
a repository fact.

**Live blocker panel — 2026-08-30, `001E3D`: zero items.** The Dashboard's
`Why can't I submit?` panel listed **nine** blockers during `001E3C` (both
contact-email items, plus seven item-completeness items). It now lists **none**,
the panel's trigger control is no longer surfaced, and `Submit for review` has
gone from **disabled** to **enabled**.

**State this precisely and no more strongly.** Zero blockers means **the live
Dashboard exposes no known pre-submission completeness blocker**. It is **not**
Google approving the extension, **not** a prediction that review will pass, and
**not** authorization to submit. Submission remains a separate, explicit owner
decision, and the §0.10 trader re-check and the standing signed-out `/privacy`
check both still run immediately before it.

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

> **CORRECTED by §0.3 (2026-08-30).** The live form labels this **`Summary from
> package`** and **exposes no editable summary field**. The sentence below —
> "can be overridden there" — was read from Google's documentation and is **not
> what the live form does**. For the 0.1.0 package, changing the summary is a
> **manifest change requiring a new package upload**. The recommendation for
> this release is to **keep the shipped summary unchanged**, and
> `extension/manifest.json` is deliberately not edited.

The Dashboard's summary field is **prefilled from the manifest `description`**
and — *per the pre-Dashboard documentation reading, now superseded by §0.3* —
was expected to be overridable there. Chrome's limit is *"no more than 132 characters"*
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
> covers only the tab the user was looking at when they clicked, it lasts only
> while that tab stays on that site — Chrome revokes it when the tab navigates to
> a **different origin** or is closed — and it shows no install-time warning
> because it grants nothing until the user asks.
>
> The URL is read into a local function, classified, and discarded when the popup
> closes. It is not stored — the extension has no `storage` permission and no
> background context in which anything could persist. It is not transmitted: the
> extension makes no network request at all. If the user presses Continue, only
> the extracted identifier is carried into a PaperLume URL, never the source URL.
>
> Without `activeTab` the extension cannot see any URL, cannot reach any page,
> and has no function.

**Lifetime wording corrected 2026-08-30, and why the old wording was wrong.**
This justification previously said the grant "is revoked when they navigate
away". That is the headline sentence of Chrome's own page, but it is **broader
than the actual behaviour** and would have understated the grant on the Store
form. The same page's worked example is explicit:

> *"Access to the tab lasts while the user is on that page, and is revoked when
> the user navigates away or closes the tab."* … *"if the user invokes the
> extension on `https://example.com` and then navigates to
> `https://example.com/foo`, the extension will continue to have access to the
> page. If the user navigates to `https://chromium.org`, access is revoked."*
> — [activeTab](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab),
> re-read **2026-08-30**

So the grant **survives same-origin navigation** within the invoked tab and ends
at a **cross-origin** navigation or tab close. The corrected sentence says that.

**This changes no behaviour and no disclosure.** PaperLume reads the URL once,
when the popup opens, and holds nothing afterwards — it has no background
context in which a longer-lived grant could be used, and no `storage` in which
anything could outlive the popup. The correction matters because a permission
justification is read by a reviewer as a technical claim, and an inaccurate one
is a defect whether or not it flatters the extension. Here the accurate wording
is marginally *less* flattering, which is precisely why it must be the one that
ships.

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

### ⚠ Both justifications exceed the live 1,000-character cap — entry-ready variants

**Finding, 2026-08-30.** The live Privacy form caps `activeTab justification*`
and `scripting justification*` at **1,000 characters each**. Measured as plain
text with markdown emphasis stripped, the drafts above are **1,071** and
**1,470** characters. **Neither can be pasted as written.** This was invisible
before the live form was seen, because Google's documentation states no limit.

The drafts above are **kept unchanged** — they are the full reasoning, and they
remain the reference for anyone checking that the short forms below claim
nothing extra. What follows is what actually gets entered.

**`activeTab justification*` — 981 characters:**

```text
PaperLume reads the active tab's URL to recognise a PubMed PMID or a DOI in it, and - only when the URL contains neither - reads the standard bibliographic DOI metadata the page publishes. activeTab is the narrowest way to do both: Chrome grants it only when the user clicks the extension's toolbar action, it covers only that one tab, it lasts only while that tab stays on that site (revoked on a cross-origin navigation or when the tab closes), and it shows no install-time warning because it grants nothing until the user asks.

The URL is read into a local function, classified, and discarded when the popup closes. Nothing is stored - there is no storage permission and no background context. Nothing is transmitted - the extension makes no network request at all. If the user presses Continue, only the extracted identifier is carried into a PaperLume URL, never the source URL.

Without activeTab the extension cannot see any URL, cannot reach any page, and has no function.
```

**`scripting justification*` — 996 characters:**

```text
A doi.org link redirects to the publisher almost immediately, so when a user clicks PaperLume the address bar shows a publisher URL containing no DOI. Without scripting, PaperLume cannot identify a paper reached the ordinary way people follow a DOI.

scripting runs one small function, bundled in the package, in the tab the user just invoked it on. It reads only the DOI the publisher already publishes in page metadata - citation_doi, dc.identifier, dc.identifier.doi, prism.doi - from the document head, main frame only. Nothing else: no article text, abstract, title, authors, links or cookies. Values reduce to at most one DOI, discarded when the popup closes. A page with two different DOIs identifies neither.

It runs only after the URL identified nothing; on a PubMed record or doi.org link the page is never touched.

scripting grants no page access alone: injection needs host access, which PaperLume does not declare. It comes only from activeTab, the grant the user's click produces.
```

**What was cut, and what was deliberately not.** The compression removed
restatement, not claims. Every substantive assertion survives: gesture-bound
grant, single tab, **cross-origin** revocation, the four metadata keys, head and
main frame only, the explicit not-read list, fail-closed on two DOIs, the
URL-first ordering, no storage, no network request, no host permissions. The
en-dashes are written as `-` because these are plain-text form fields, not
markdown.

**`Single purpose description*` fits as drafted** — §5 measures **534**
characters against the same 1,000 cap, and needs no short form.

**Re-measure before entry.** If §5 or §6 is edited later, re-check both counts;
the cap is a property of the live form, not of this document.

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

> ## ⚠ BLOCKING WARNING FOR THE STORE-ENTRY TASK — remote code must be changed to **No**
>
> The **untouched** live Privacy form was observed on 2026-08-30 displaying
> **`Yes, I am using remote code`** selected, with a required `Justification*`
> field exposed as a consequence.
>
> **That selection is factually wrong for PaperLume and must not be saved.**
>
> The live help text defines remote code as JavaScript or Wasm that is *not
> included in the extension package* — including references to external files and
> strings evaluated through `eval`-style mechanisms. The PaperLume package uses
> **none** of those:
>
> - no remote JavaScript, no remote Wasm, no external script import;
> - no `eval`, no `new Function`;
> - the function passed to `chrome.scripting.executeScript({func})` is **bundled
>   inside `popup.js`** — Chrome serializes it out of the package at call time,
>   so nothing is fetched and nothing is evaluated from a string;
> - the package is self-contained, and the package scanner rejects any origin
>   other than `https://app.paperlume.app` in any packaged file, including in a
>   comment.
>
> **Locked intended answer: `No, I am not using remote code`.**
>
> **Do not write a remote-code justification.** The `No` path should not expose
> that field; if a justification field is still required after selecting `No`,
> that is a **stop-and-report** event, not a prompt to invent text.
>
> Whether the displayed `Yes` is a Dashboard default or an artefact of the
> observation session is not established, and does not matter: it must be
> **explicitly changed to No before Privacy practices is saved**, and the saved
> value re-read afterwards to confirm it took.

**Live Privacy form facts (2026-08-30).** Three required free-text fields, each
capped at **1,000** characters — `Single purpose description*`,
`activeTab justification*`, `scripting justification*`. Drafts for all three are
below and in §5/§6; each must be checked against the 1,000-character cap at
entry time. The nine data-usage categories in §7 match the live list exactly. The
`Privacy policy URL*` field is required for this item because it declares
user-data handling.

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

**Live wording, transcribed from the form on 2026-08-30.** The live Privacy page
contains exactly **three** certifications, and states:

> *"You must certify all three disclosures to comply with our Developer Program
> Policies"*

| Live statement | Answer | Basis |
|---|---|---|
| *I do not sell or transfer user data to third parties, outside of the approved use cases* | **Certify** | Nothing is sold or transferred. The identifier goes only to PaperLume, at the user's request, as the feature the user invoked |
| *I do not use or transfer user data for purposes that are unrelated to my item's single purpose* | **Certify** | The identifier **is** the single purpose |
| *I do not use or transfer user data to determine creditworthiness or for lending purposes* | **Certify** | Not applicable |

**Intended answer: CERTIFY ALL THREE.** Not ticked by any task so far.

**No separate Limited Use checkbox or Limited Use text field was observed on the
live Privacy page.** The affirmative Limited Use disclosure therefore lives where
§8 already puts it — in the public Privacy Policy §4 — and **no second copy
should be added** to the listing copy or invented as a Dashboard field.

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

**Live field: `Privacy policy URL*` — required**, because this item declares
user-data handling (Web history = Yes, Website content = Yes). Confirmed on the
live form 2026-08-30. Not entered by any task so far.

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
extension does not do, which the metadata read made false. That mismatch was
recorded in [privacy-data-flow-audit.md](privacy-data-flow-audit.md) §24.6 and as
a blocking gate in [chrome-web-store-readiness.md](chrome-web-store-readiness.md)
§6; both now also carry its closure.

**The owner approved amended §4 wording on 2026-08-30**, and
`PRIVACY-POLICY-EXTENSION-METADATA-001B` implements exactly that approved copy —
the bounded metadata read, the four supported DOI metadata names, the
locally-and-transiently disclosure, and an affirmative Limited Use statement —
together with an effective date of **August 30, 2026**.

**That work is now merged and live — the mismatch is CLOSED.**
`PRIVACY-POLICY-EXTENSION-METADATA-001B` (PR #258) merged on **2026-08-30** as
`8144504508df333e850c0ed38ec1352c9579ca24`, and the URL above was opened **in
public Production, signed out**, on 2026-08-30: it served the amended §4, the
**August 30, 2026** effective date, all four DOI metadata names and the Limited
Use sentence, and no longer carried the retired *"read the contents of the
webpage or its DOM"* claim. The historical finding above is left standing as the
record of what was wrong and when.

**Limited Use disclosure location.** The approved §4 ends with the affirmative
statement *"PaperLume uses information accessed by the Chrome extension only in
accordance with the Chrome Web Store User Data Policy, including its Limited Use
requirements."* The public Privacy Policy is therefore the disclosure location;
no second copy of that sentence belongs anywhere else, and none should be added
to the listing copy.

**Standing submission gate — it does not close permanently.** Before
**every** Store submission, confirm that URL loads the policy **in Production,
signed out, from a clean browser** with no cached session. Deployment
protection, a routing regression or a rewrite change can each break it without
breaking anything else. See
[chrome-web-store-readiness.md](chrome-web-store-readiness.md) §8 items 23–24.

That same signed-out Production check must additionally confirm the page shows
the amended §4 and the **August 30, 2026** effective date. A Preview deployment is
not Production and does not close this gate. **Last passed: 2026-08-30** — which
is evidence for that date only, not a completed step; re-run it immediately before
every actual submission.

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
| Marquee promo tile | — | 1400×560 | — | Not produced | — | — | **Optional** — confirmed on the live form (no `*`) |
| Promotional video | — | — | — | Not produced | — | — | **OPTIONAL** — resolved from the live form, §0.4. Historical conflict preserved in §10 |

> **Live requiredness, resolved 2026-08-30 (§0).** The live Store Listing form
> requires exactly **two** graphic assets for this item: **`Store icon *`**
> (128×128, its own upload control) and **`Screenshots *`** (at least one; max 5;
> 1280×800 or 640×400). **`Small promo tile`, `Marquee promo tile` and
> `Global promo video` all carry no `*` and are OPTIONAL** — which **corrects**
> this document's earlier statement, taken from Google's `images` page, that the
> small promo tile is mandatory.
>
> **The committed assets already satisfy the live format rule — measured, not
> assumed.** The live form specifies *JPEG or 24-bit PNG (no alpha)* for
> screenshots and both promo tiles. Reading the PNG `IHDR` colour type directly
> off the committed files on 2026-08-30:
>
> | File | Dimensions | PNG colour type | Live rule |
> |---|---|---|---|
> | `screenshot-1-pubmed-1280x800.png` | 1280×800 | **2 — 24-bit RGB, no alpha** | ✅ |
> | `screenshot-2-doi-1280x800.png` | 1280×800 | **2 — 24-bit RGB, no alpha** | ✅ |
> | `screenshot-3-unsupported-1280x800.png` | 1280×800 | **2 — 24-bit RGB, no alpha** | ✅ |
> | `promo-tile-small-440x280.png` | 440×280 | **2 — 24-bit RGB, no alpha** | ✅ |
> | `store-icon-128.png` | 128×128 | 6 — RGBA | ✅ — see below |
>
> No `tRNS` chunk is present in any of them. **The store icon keeping its alpha
> channel is correct, not an exception**: the `no alpha` rule is stated for
> screenshots and promo tiles, while the store icon is specified as 128×128 with
> Google's documented 96×96 mark plus 16 px of *transparent* padding — which
> requires alpha. The generator produced the right format for each role.
>
> `assets/store/store-icon-128.png` is no longer a speculative candidate: a
> separate required upload field exists, and it is the file prepared for it.

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

> **RESOLVED 2026-08-30 — §0.5.** A separate field **does** exist:
> **`Store icon *`**, required, 128×128, with its own upload control. The
> candidate `assets/store/store-icon-128.png` is the file prepared for it. The
> packaged `icons/icon-128.png` is still required package metadata and is what
> Chrome itself uses — the separate field does not replace it. Whether the Store
> *displays* the uploaded icon rather than the packaged one is still not asserted
> here, and does not need to be. The paragraph below is preserved as the
> historical position.

**What was NOT claimed, before the live form was seen.** This document did not assert that the candidate is
uploaded through a separate Dashboard field, that it overrides the packaged
icon, or that the Chrome Web Store will display it rather than the manifest
icon. The Dashboard had not been inspected — 001E2 and that correction were not
authorised to open it — and
[Prepare your Store listing](https://developer.chrome.com/docs/webstore/cws-dashboard-listing)
lists *"A 128x128 px to use as your store icon"* among the graphic assets
without settling whether that field is a separate upload or is read from the
package. That stayed unresolved until someone looked at the live form.

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

## 10. Promotional video — `RESOLVED FROM THE LIVE FORM: OPTIONAL`

> **RESOLVED 2026-08-30 — see §0.4.** The live field is **`Global promo video`**
> and it carries **no `*` required marker**. **Classification is now
> `PROMOTIONAL VIDEO — OPTIONAL IN THE LIVE PAPERLUME DASHBOARD`.** No video is
> required and none will be produced.
>
> **Everything below is preserved as the historical record**, and is not
> rewritten. It documents a genuine, still-real conflict between three
> first-party Google pages, and the decision not to guess which one governed. The
> live form answered the *operational* question; it did not make the
> documentation consistent, and a future reader hitting the same contradiction
> should know it was seen, analysed, and resolved by observation rather than
> assumption. The gate below (§"The gate, stated as an owner action for 001E3")
> is **discharged**: it was verified, and the answer was "not required".

**Historical classification, correct when written on 2026-08-29:**
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
| `Category*` | Suggested: **Workflow & Planning** (research/reference tooling) | **REQUIRED field; still an owner decision.** No live selection made. Choose from the live list at entry time |
| `Language*` | **English (United States)** — the only language the popup ships | **REQUIRED field.** Expected value; **no live selection is saved** |
| `Support URL` | — | **OPTIONAL in the live Store form** (no `*`) — see §0.7. Separately, C16 in [decisions-and-triggers.md](decisions-and-triggers.md) governs Terms and Support as PaperLume's own launch-quality decision. **The Store does not compel it; C16 is unchanged** |
| `Homepage URL` | — | Optional (no `*`). Owner decision |
| `Official URL` | — | Optional. Currently `None`; requires site ownership through Google Search Console |
| `Mature content` | Off | Toggle displayed off; correct for this item |
| Reviewer test instructions | Drafted in [chrome-web-store-readiness.md](chrome-web-store-readiness.md) §12 | Ready. **The dedicated low-privilege reviewer account is provisioned and verified — gate CLOSED 2026-08-30, §0.9.** Credentials exist, are owner-held outside Git and chat, and have **not** been entered into the Store. No credentials are embedded here and none should be; no fixture is required |
| Publisher account | Registered developer; Dashboard accessible | **DONE.** Registration complete and the one-time **$5 fee is paid** (§0.10). **Current owner-selected declaration: Non-trader**, frozen 2026-08-30 for this submission and matching the Dashboard setting — the owner's self-declaration, not a Google finding. A consistency and policy re-check immediately before submission remains, see §0.10 |

---

## 12. Distribution paths

Documented, **not chosen**. The owner has made no distribution decision, and
these three do not carry the same gates.

> **Live Distribution form state, 2026-08-30 — see §0.8.** The untouched form
> displays `Free of charge` (correct: the package contains no purchase flow),
> **`Public` visibility**, and **all regions checked**. **None of that is an
> owner decision** — it is the form's default draft state, observed read-only.
> The recommendation below, a limited beta before any public listing, is
> unchanged and unfrozen. Do not read the displayed defaults as authorization to
> publish worldwide.

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

### 13.1 State after `001E3A` — as of 2026-08-30, superseded the same day

> **SUPERSEDED 2026-08-30 by `CHROME-EXTENSION-IMPORT-001E3C` — see §0.12 for the
> current state.** The list below was correct after `001E3A` and is preserved as
> chronology. Most of it is **no longer true**: the Store Listing, Privacy,
> Distribution and Test-instructions fields have since been populated and saved,
> the store icon and three screenshots have been uploaded, category, language,
> visibility and regions have been chosen by the owner, all three certifications
> are ticked and the privacy-policy URL is entered. **Four items below still
> hold:** no promo video was produced or uploaded, no Verified CRX opt-in and the
> public key was never viewed, no GitHub Release/tag/version bump, and — the one
> that matters most — **no submission for review and no publication.**

Still **not** performed *(as at `001E3A`; read with the supersession above)*:

- No Store Listing, Privacy practices, Distribution or Test-instructions field
  deliberately populated or **saved**.
- No screenshot, store icon, promo tile or video uploaded to Google.
- No video produced or uploaded to YouTube.
- No category, language, visibility or region **chosen** by the owner.
- No certification ticked; no privacy-policy URL entered.
- **No reviewer credentials entered into the Store**, and no `Test instructions`
  field populated or saved. *(The reviewer **account** itself now exists —
  provisioned in PaperLume Production on 2026-08-30, §0.9. That was a Production
  action, not a Store one, and the credentials remain owner-held.)*
- No opt-in to **Verified CRX uploads**; the item's **public key was not
  viewed**.
- No trader-status change, no trader verification, no public address added.
  *(The owner froze the **declaration** as Non-trader on 2026-08-30 — §0.10 — a
  decision about the setting already in place, not a change made to it.)*
- No GitHub Release, no tag, no version bump.
- **No submission for review, and no publication.**

Now **done**, by `CHROME-EXTENSION-IMPORT-001E3A` on 2026-08-30, under explicit
owner authorization limited to exactly these two mutations:

- Developer registration complete and the one-time **$5 fee paid** (owner, prior
  to 001E3A).
- **One** PaperLume draft item created — `cfanjbamcemoeglgkpbidnclkomaocmo`.
- **One** package uploaded — the validated `0.1.0` release candidate.

A separately authorized **`001E3C`** owns everything still outstanding. Nothing
in this document authorizes it.

> **Update, 2026-08-30.** `001E3C` has since run and populated the draft (§0.12),
> and `001E3D` audited the result read-only. What is still outstanding is no
> longer draft *population* but the **submission action itself**, which remains
> unauthorized and requires a separate explicit owner decision. Nothing in this
> document authorizes submission or publication.

### 13.2 Historical — the state through 2026-08-29, preserved

Correct when written, and superseded by §13.1:

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

`CHROME-EXTENSION-IMPORT-001E3` owned every one of these, and required explicit
owner authorization.
