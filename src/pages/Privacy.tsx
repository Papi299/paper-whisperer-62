import { useEffect, type ReactNode } from "react";
import { Link } from "react-router";
import { BookOpen } from "lucide-react";

/**
 * The public PaperLume Privacy Policy.
 *
 * The wording on this page is the owner-approved publication copy and is the
 * authority for what PaperLume publishes. It is deliberately literal JSX rather
 * than data driven through a renderer: the page IS the copy, so a reviewer can
 * diff the approved text against this file directly. Only presentation —
 * headings, lists, emphasis, the `mailto:` link — is expressed in markup.
 *
 * The factual evidence behind these statements lives in
 * `docs/privacy-data-flow-audit.md`; that audit remains the authority for
 * data-flow facts, and this page remains the authority for the published copy.
 * Do not edit the wording here to reconcile the two — raise the discrepancy.
 *
 * The route is public by construction: PaperLume has no route-level auth guard
 * (each page owns its own redirect), and this page has none.
 */

const PAGE_TITLE = "PaperLume Privacy Policy";
const CANONICAL_URL = "https://app.paperlume.app/privacy";
const PRIVACY_EMAIL = "mutrisport@gmail.com";

/** A `mailto:` link for the one published privacy address. */
const PrivacyEmail = () => (
  <a
    href={`mailto:${PRIVACY_EMAIL}`}
    className="font-semibold text-primary underline underline-offset-4 hover:text-primary/80"
  >
    {PRIVACY_EMAIL}
  </a>
);

const P = ({ children }: { children: ReactNode }) => (
  <p className="mt-4 leading-7">{children}</p>
);

const Bullets = ({ children }: { children: ReactNode }) => (
  <ul className="mt-4 list-disc space-y-2 pl-6 leading-7">{children}</ul>
);

/**
 * A numbered policy section. The `id` gives every section a stable anchor so a
 * reviewer, a support reply, or a Store listing can link to one part of the
 * policy without the URL depending on rendered text.
 */
const Section = ({ id, title, children }: { id: string; title: string; children: ReactNode }) => (
  <section aria-labelledby={id}>
    <h2 id={id} className="mt-12 scroll-mt-6 text-xl font-semibold tracking-tight sm:text-2xl">
      {title}
    </h2>
    {children}
  </section>
);

const Subheading = ({ children }: { children: ReactNode }) => (
  <h3 className="mt-8 text-base font-semibold sm:text-lg">{children}</h3>
);

const Privacy = () => {
  useEffect(() => {
    /**
     * PaperLume is a Vite single-page build with one static `index.html` and no
     * document-metadata framework. Rather than introduce one for a single
     * route, this page owns its own metadata: it sets the title and adds the
     * canonical reference on mount, and restores both on unmount so no other
     * route inherits either.
     */
    const previousTitle = document.title;
    document.title = PAGE_TITLE;

    const canonical = document.createElement("link");
    canonical.rel = "canonical";
    canonical.href = CANONICAL_URL;
    document.head.appendChild(canonical);

    return () => {
      document.title = previousTitle;
      canonical.remove();
    };
  }, []);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b">
        <div className="mx-auto flex w-full max-w-3xl items-center px-4 py-4 sm:px-6">
          <Link
            to="/"
            className="flex items-center gap-2 rounded-sm font-semibold hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            <BookOpen className="h-5 w-5 text-primary" aria-hidden="true" />
            PaperLume
          </Link>
        </div>
      </header>

      <main className="mx-auto w-full max-w-3xl px-4 pb-20 pt-8 sm:px-6 sm:pt-12">
        <article>
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">PaperLume Privacy Policy</h1>

          <p className="mt-4 font-semibold leading-7">Effective date: August 30, 2026</p>

          <P>
            PaperLume is operated by <strong>Maor Pichadza</strong>, an individual sole proprietor in
            Israel operating under the business name <strong>MutriSport</strong> (“PaperLume,” “we,”
            “us,” or “our”).
          </P>

          <P>For privacy questions or requests, contact:</P>

          <p className="mt-4 leading-7">
            <PrivacyEmail />
          </p>

          <P>
            PaperLume is currently operated as a <strong>pre-commercial beta service</strong>. We do
            not currently offer paid PaperLume subscriptions or process payment-card information.
          </P>

          <Section id="scope" title="1. Scope of this Privacy Policy">
            <P>
              This Privacy Policy explains how PaperLume collects, uses, stores, shares, and deletes
              information when you use:
            </P>
            <Bullets>
              <li>the PaperLume web application; and</li>
              <li>the PaperLume Chrome extension.</li>
            </Bullets>
            <P>
              PaperLume is intended only for users who are{" "}
              <strong>18 years of age or older</strong>.
            </P>
          </Section>

          <Section id="information-processed" title="2. Information PaperLume processes">
            <Subheading>Account information</Subheading>
            <P>
              When you create a PaperLume account, we process information necessary to create and
              manage the account, including:
            </P>
            <Bullets>
              <li>your email address;</li>
              <li>an internal user identifier generated by our authentication provider; and</li>
              <li>an optional display name, if provided.</li>
            </Bullets>
            <P>
              Your email address is also used for account-related communications such as email
              verification and password-reset messages.
            </P>

            <Subheading>Optional PubMed API key</Subheading>
            <P>
              You may choose to provide your own NCBI/PubMed API key. If you do, PaperLume stores it
              so that it can be used when making PubMed requests on your behalf.
            </P>
            <P>Providing a PubMed API key is optional.</P>

            <Subheading>Research-library information</Subheading>
            <P>
              PaperLume is designed to store and organize academic research. Depending on how you use
              the service, your library may contain information such as:
            </P>
            <Bullets>
              <li>publication titles and abstracts;</li>
              <li>author names;</li>
              <li>journal and publication information;</li>
              <li>PMID and DOI identifiers;</li>
              <li>publication URLs;</li>
              <li>keywords and MeSH terms;</li>
              <li>study types and statistical-method information;</li>
              <li>your notes;</li>
              <li>AI-generated summaries or classifications;</li>
              <li>Projects and Project descriptions;</li>
              <li>Tags;</li>
              <li>saved filters;</li>
              <li>normalization and exclusion settings;</li>
              <li>author-identity information and related organizational records; and</li>
              <li>relationships between papers, Projects, Tags, and author identities.</li>
            </Bullets>
            <P>
              Some bibliographic information comes from public academic metadata services such as
              PubMed/NCBI and Crossref. Other information, such as notes, Projects, Tags, and
              organizational choices, is created by you.
            </P>
            <P>
              Research-library information may reveal professional interests, research priorities, or
              areas of investigation even when the underlying publications are publicly available.
            </P>

            <Subheading>Information about third parties</Subheading>
            <P>
              Bibliographic records may contain personal information about individuals who are not
              PaperLume users, particularly author names and other publication-related information
              obtained from public scholarly records.
            </P>

            <Subheading>Attachments</Subheading>
            <P>You may upload supported files associated with papers.</P>
            <P>Attachments are stored in private storage associated with your account.</P>
            <P>
              PaperLume's current AI features do <strong>not</strong> send uploaded attachment files
              to Google Gemini.
            </P>
          </Section>

          <Section id="browser-storage" title="3. Browser storage and cookies">
            <P>
              PaperLume uses browser storage required to operate the service and remember user
              preferences.
            </P>
            <P>This includes:</P>
            <Bullets>
              <li>authentication-session information stored through Supabase Auth;</li>
              <li>local interface preferences; and</li>
              <li>a limited functional cookie used to remember certain interface state.</li>
            </Bullets>
            <P>
              PaperLume does <strong>not currently use</strong> third-party advertising cookies,
              behavioral advertising, fingerprinting, or application analytics services.
            </P>
          </Section>

          <Section id="chrome-extension" title="4. PaperLume Chrome extension">
            <P>
              The PaperLume Chrome extension has a narrow purpose: to detect a supported
              scholarly-paper identifier from the page you are viewing and open PaperLume so that you
              can choose whether to import the paper.
            </P>
            <P>
              The extension examines the current tab only when you explicitly activate PaperLume from
              your browser toolbar. It does not continuously monitor your browsing activity and does
              not run a background content script. Chrome grants the extension temporary access to
              the active tab in response to your click. That temporary access is revoked when the tab
              navigates to a different website origin or when the tab is closed.
            </P>
            <P>
              When you activate the extension, it first reads the{" "}
              <strong>URL of the currently active browser tab</strong> to determine whether it
              contains a supported PubMed or DOI pattern. If the URL itself identifies a supported
              paper, the extension does not inspect the page for DOI metadata.
            </P>
            <P>
              If the URL of an ordinary web page does not identify a supported paper, the extension
              then checks metadata in that page's header for a DOI. It recognizes only four standard
              DOI metadata names: “citation_doi,” “dc.identifier,” “dc.identifier.doi,” and
              “prism.doi.” It uses the content value only when a metadata element matches one of
              those names. This check runs only in the main page frame and does not inspect the
              contents of embedded frames.
            </P>
            <P>
              Not every website publishes this metadata, and the extension does not use the page
              title or other page content as a fallback, so it cannot identify a paper on every page.
            </P>
            <P>
              The extension processes the active-tab URL and, when necessary, the matching DOI
              metadata locally and transiently while determining the paper identifier. It does not
              persist that information, and opening the extension does not automatically transmit it
              to PaperLume.
            </P>
            <P>It does not:</P>
            <Bullets>
              <li>maintain a browsing-history database;</li>
              <li>
                read article or body text, the page title, abstracts, author names, links, form
                contents, or iframe contents;
              </li>
              <li>
                use the content values of page metadata other than the supported DOI metadata
                described above;
              </li>
              <li>read website cookies or authentication tokens;</li>
              <li>store the active-tab URL or the DOI metadata it reads from the page;</li>
              <li>use background content scripts; or</li>
              <li>
                directly transmit the active-tab URL or webpage content to PaperLume, except
                for the detected identifier value described below when you choose to continue.
              </li>
            </Bullets>
            <P>
              If you choose to continue, the extension opens the PaperLume web application and
              provides only the detected identifier type and value, such as a PMID or DOI.
            </P>
            <P>Nothing is sent to PaperLume merely because you open the extension.</P>
            <P>
              Authentication and the actual import take place in the PaperLume web application.
            </P>
            <P>
              PaperLume uses information accessed by the Chrome extension only in accordance with the
              Chrome Web Store User Data Policy, including its Limited Use requirements.
            </P>
          </Section>

          <Section id="how-we-use-information" title="5. How we use information">
            <P>We process information to:</P>
            <Bullets>
              <li>create and authenticate accounts;</li>
              <li>operate and maintain your research library;</li>
              <li>retrieve publication metadata;</li>
              <li>provide Projects, Tags, search, filtering, and organization features;</li>
              <li>store attachments;</li>
              <li>enforce service quotas and technical limits;</li>
              <li>generate AI-assisted results when requested;</li>
              <li>send account-related transactional email;</li>
              <li>maintain service security and reliability;</li>
              <li>troubleshoot technical problems; and</li>
              <li>respond to support and privacy requests.</li>
            </Bullets>
            <P>
              PaperLume does <strong>not currently sell personal information</strong>.
            </P>
            <P>
              We do not currently use user information for targeted advertising or cross-service
              behavioral advertising.
            </P>
          </Section>

          <Section
            id="gemini-free-tier"
            title="6. Google Gemini AI — important Free-tier disclosure"
          >
            <P>
              PaperLume currently uses the{" "}
              <strong>Free / Unpaid tier of the Google Gemini API</strong> for AI-assisted features.
            </P>

            <Subheading>Paper analysis</Subheading>
            <P>When you request AI analysis of a paper, PaperLume may send the paper's:</P>
            <Bullets>
              <li>title; and</li>
              <li>abstract</li>
            </Bullets>
            <P>to Google Gemini.</P>

            <Subheading>Project and Tag suggestions</Subheading>
            <P>When you request AI-assisted organization suggestions, PaperLume may send:</P>
            <Bullets>
              <li>the paper title;</li>
              <li>abstract;</li>
              <li>keywords;</li>
              <li>study type;</li>
              <li>names of your existing Projects;</li>
              <li>Project descriptions, where present; and</li>
              <li>names of your existing Tags.</li>
            </Bullets>
            <P>
              The organization-suggestion request does not intentionally include your email address,
              authentication credentials, uploaded attachment files, internal user ID, or unrelated
              papers.
            </P>

            <Subheading>How Google may use Free-tier Gemini data</Subheading>
            <P>
              PaperLume currently uses Google's <strong>Unpaid Services</strong>, not Gemini's paid
              API tier.
            </P>
            <P>
              Under Google's current terms for Unpaid Services, Google may use submitted content and
              generated responses to provide, improve, and develop Google products, services, and
              machine-learning technologies.
            </P>
            <P>
              Google also states that human reviewers may read, annotate, and process API inputs and
              outputs.
            </P>
            <P>
              Google instructs developers not to submit sensitive, confidential, or personal
              information to its Unpaid Services.
            </P>
            <P>For that reason:</P>
            <blockquote className="mt-4 rounded-md border-l-4 border-primary bg-muted p-4 leading-7">
              <strong>
                Do not use PaperLume's AI features with personal, sensitive, confidential,
                proprietary, unpublished, or otherwise private information while PaperLume uses
                Gemini's Free tier.
              </strong>
            </blockquote>
            <P>
              PaperLume's non-AI research-library and organizational functions may be used without
              requesting Gemini-powered analysis.
            </P>
            <P>
              If PaperLume later moves its production AI integration to Gemini's paid API services,
              we will update this Privacy Policy to reflect the data-processing terms that actually
              apply at that time.
            </P>

            <Subheading>Geographic limitation of the current AI beta</Subheading>
            <P>
              Google's current terms require developers making Gemini-powered API clients available
              to users in the European Economic Area, Switzerland, or the United Kingdom to use Paid
              Services.
            </P>
            <P>
              Accordingly, PaperLume's current Free-tier Gemini functionality is{" "}
              <strong>not intended for users in those regions</strong>.
            </P>
          </Section>

          <Section id="pubmed-ncbi" title="7. PubMed and NCBI">
            <P>
              PaperLume uses NCBI services to search PubMed and retrieve publication metadata.
            </P>
            <P>
              When you perform a PubMed search or request PubMed metadata, PaperLume may send NCBI:
            </P>
            <Bullets>
              <li>your search query;</li>
              <li>
                PMID, DOI, title, or other publication identifiers necessary for the request; and
              </li>
              <li>your NCBI API key, if you chose to provide one.</li>
            </Bullets>
            <P>
              NLM states that its services may automatically record usage information, including
              search terms and technical request information, and that it periodically deletes web
              logs.
            </P>
            <P>
              NCBI and NLM process such information according to their own policies and practices.
            </P>
          </Section>

          <Section id="crossref" title="8. Crossref">
            <P>PaperLume may use Crossref to retrieve scholarly-publication metadata.</P>
            <P>A Crossref lookup may contain information such as a DOI or publication title.</P>
            <P>
              Crossref states that its API logs may contain request information and network
              information associated with the request, and that its API logs are deleted after{" "}
              <strong>three months</strong>.
            </P>
            <P>
              PaperLume's Crossref requests are made through backend infrastructure rather than
              directly from your browser.
            </P>
          </Section>

          <Section id="supabase" title="9. Supabase">
            <P>
              PaperLume uses <strong>Supabase</strong> to provide:
            </P>
            <Bullets>
              <li>authentication;</li>
              <li>database services;</li>
              <li>backend processing; and</li>
              <li>private file storage.</li>
            </Bullets>
            <P>
              PaperLume's current primary Supabase project is hosted in{" "}
              <strong>Mumbai, India</strong>.
            </P>
            <P>
              Your account information, research library, and attachment-related data may therefore
              be stored or processed in India through Supabase infrastructure and authorized service
              providers.
            </P>
            <P>
              PaperLume currently uses the <strong>Supabase Free tier</strong>.
            </P>
            <P>
              Access to PaperLume's database is protected through authentication and database Row
              Level Security rules intended to prevent users from accessing other users' records.
            </P>
            <P>
              Attachments are stored in private storage with account-scoped access controls.
            </P>
            <P>
              These measures do not mean that PaperLume is end-to-end encrypted or that authorized
              service administration can never access stored information.
            </P>
          </Section>

          <Section id="vercel" title="10. Vercel">
            <P>
              PaperLume uses <strong>Vercel</strong> to host and deliver the PaperLume web
              application.
            </P>
            <P>
              Vercel may process technical and operational information necessary to host and serve
              the application, including network and deployment-related information.
            </P>
            <P>
              PaperLume currently uses Vercel's <strong>Hobby plan</strong> during its
              pre-commercial development and beta phase.
            </P>
            <P>
              We have{" "}
              <strong>
                opted out of Vercel's optional use of Hobby-plan customer content for AI or
                model-training purposes
              </strong>
              .
            </P>
            <P>
              PaperLume does not intentionally send users' research-library contents to Vercel for AI
              analysis.
            </P>
            <P>
              PaperLume intends to move to an appropriate commercial hosting plan before commercial
              operation.
            </P>
          </Section>

          <Section id="resend" title="11. Transactional email and Resend">
            <P>
              PaperLume uses <strong>Resend</strong>, through its authentication infrastructure, to
              send transactional account emails such as:
            </P>
            <Bullets>
              <li>account verification messages; and</li>
              <li>password-reset messages.</li>
            </Bullets>
            <P>To deliver these emails, Resend may process:</P>
            <Bullets>
              <li>your email address;</li>
              <li>the content of the transactional message; and</li>
              <li>delivery and technical metadata associated with the message.</li>
            </Bullets>
            <P>
              Resend states that relevant customer data may be stored or processed in the{" "}
              <strong>United States</strong>.
            </P>
            <P>
              Resend currently states that email and log data for its Free, Pro, and Scale plans is
              retained for approximately <strong>30 days</strong>.
            </P>
          </Section>

          <Section id="international-processing" title="12. International processing">
            <P>
              PaperLume is operated from <strong>Israel</strong>, but some of the service providers
              used to operate PaperLume process information in other countries.
            </P>
            <P>For example:</P>
            <Bullets>
              <li>
                Supabase's primary PaperLume project is hosted in <strong>India</strong>;
              </li>
              <li>
                Resend processes relevant email-related information in the{" "}
                <strong>United States</strong>;
              </li>
              <li>Vercel operates infrastructure in the United States and other locations; and</li>
              <li>
                Google may process Gemini-related information in locations where Google and its
                service providers operate.
              </li>
            </Bullets>
            <P>Your information may therefore be processed outside Israel.</P>
          </Section>

          <Section id="retention" title="13. Retention">
            <P>
              PaperLume does not currently apply a single fixed automatic expiration period to
              ordinary research-library information.
            </P>
            <P>
              Your papers, notes, Projects, Tags, preferences, and other library information are
              generally retained until:
            </P>
            <Bullets>
              <li>you delete the relevant information; or</li>
              <li>you delete your PaperLume account.</li>
            </Bullets>
            <P>
              Some temporary, technical, or browser-stored information may expire earlier.
            </P>
            <P>
              Third-party service providers may separately retain logs, backups, API requests,
              email-delivery records, or other operational information according to their own
              retention practices.
            </P>
            <P>For example:</P>
            <Bullets>
              <li>Crossref states that its API logs are deleted after three months;</li>
              <li>
                Resend currently states that ordinary email and log data on its Free, Pro, and Scale
                plans is retained for approximately 30 days; and
              </li>
              <li>
                NLM states that it periodically deletes its web logs without publishing one universal
                fixed retention period.
              </li>
            </Bullets>
            <P>
              Information submitted through Gemini's current Free tier may be retained and used by
              Google under the Free-tier terms described in Section 6.
            </P>
          </Section>

          <Section id="deletion" title="14. Deleting your information and account">
            <P>PaperLume provides self-service account deletion.</P>
            <P>
              When account deletion succeeds, PaperLume removes the active PaperLume authentication
              account and associated user-owned application records.
            </P>
            <P>
              PaperLume's deletion process also attempts to remove attachment files stored within
              that account's storage namespace.
            </P>
            <P>
              Deleting a PaperLume account cannot necessarily delete information that has already
              been transmitted to independent third-party providers.
            </P>
            <P>
              For example, Google, NCBI, Crossref, Resend, Supabase, or infrastructure providers may
              retain logs, backups, or other records according to their own terms, retention
              practices, or legal obligations.
            </P>
            <P>
              PaperLume currently has{" "}
              <strong>no active billing integration and no current user billing records</strong>.
            </P>
            <P>For assistance with deletion or another privacy request, contact:</P>
            <p className="mt-4 leading-7">
              <PrivacyEmail />
            </p>
          </Section>

          <Section id="access-and-export" title="15. Access, correction, and data export">
            <P>
              Subject to applicable law, you may have rights concerning information about you,
              including rights to request access, correction, deletion, or information about how
              your personal information is processed.
            </P>
            <P>
              PaperLume also provides an account-data export feature for supported account and
              research-library information.
            </P>
            <P>
              For security reasons, an optional NCBI/PubMed API key is not included in that
              account-data export.
            </P>
            <P>Privacy requests may be sent to:</P>
            <p className="mt-4 leading-7">
              <PrivacyEmail />
            </p>
          </Section>

          <Section id="security" title="16. Security">
            <P>
              PaperLume uses technical safeguards intended to reduce unauthorized access to
              information.
            </P>
            <P>These currently include measures such as:</P>
            <Bullets>
              <li>encrypted HTTPS connections;</li>
              <li>authenticated access;</li>
              <li>database Row Level Security;</li>
              <li>private attachment storage;</li>
              <li>user-scoped authorization controls; and</li>
              <li>narrowly scoped Chrome-extension permissions.</li>
            </Bullets>
            <P>No online service can guarantee absolute security.</P>
            <P>
              PaperLume does <strong>not</strong> claim that:
            </P>
            <Bullets>
              <li>its research library is end-to-end encrypted;</li>
              <li>the service is immune from security incidents; or</li>
              <li>the service operator can never access stored information.</li>
            </Bullets>
          </Section>

          <Section id="children" title="17. Children">
            <P>
              PaperLume is intended only for people <strong>18 years of age or older</strong>.
            </P>
            <P>We do not knowingly offer PaperLume to children under 18.</P>
            <P>
              If you believe that a person under 18 has created a PaperLume account or provided
              personal information through the service, contact:
            </P>
            <p className="mt-4 leading-7">
              <PrivacyEmail />
            </p>
          </Section>

          <Section id="advertising-and-analytics" title="18. Advertising, analytics, and sale of information">
            <P>PaperLume does not currently:</P>
            <Bullets>
              <li>sell personal information;</li>
              <li>operate an advertising network;</li>
              <li>use personal information for targeted advertising;</li>
              <li>use third-party application analytics to profile users; or</li>
              <li>use browser fingerprinting for behavioral tracking.</li>
            </Bullets>
            <P>
              If these practices materially change in the future, this Privacy Policy will be updated
              as required before or when those new practices are introduced.
            </P>
          </Section>

          <Section id="changes" title="19. Changes to this Privacy Policy">
            <P>PaperLume is under active development.</P>
            <P>We may update this Privacy Policy when:</P>
            <Bullets>
              <li>PaperLume features change;</li>
              <li>service providers change;</li>
              <li>data-processing practices change;</li>
              <li>PaperLume moves from free infrastructure to paid production services;</li>
              <li>PaperLume becomes commercially available; or</li>
              <li>applicable legal requirements change.</li>
            </Bullets>
            <P>
              The effective date at the top of this Privacy Policy will be updated when the policy
              changes.
            </P>
            <P>The current version will be available at:</P>
            <p className="mt-4 leading-7">
              <a
                href={CANONICAL_URL}
                className="font-semibold text-primary underline underline-offset-4 hover:text-primary/80"
              >
                {CANONICAL_URL}
              </a>
            </p>
          </Section>

          <Section id="contact" title="20. Contact">
            <P>PaperLume is operated by:</P>
            <address className="mt-4 not-italic leading-7">
              <strong>Maor Pichadza</strong>
              <br />
              Operating under the business name <strong>MutriSport</strong>
              <br />
              <strong>Israel</strong>
            </address>
            <P>Privacy, data-protection, and account-related requests:</P>
            <p className="mt-4 leading-7">
              <PrivacyEmail />
            </p>
          </Section>
        </article>
      </main>
    </div>
  );
};

export default Privacy;
