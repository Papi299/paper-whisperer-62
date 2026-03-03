/// <reference types="https://esm.sh/@supabase/functions-js/src/edge-runtime.d.ts" />

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

interface PaperMetadata {
  identifier: string;
  title?: string;
  authors?: string[];
  year?: number | null;
  journal?: string | null;
  pmid?: string | null;
  doi?: string | null;
  abstract?: string | null;
  keywords?: string[];
  mesh_terms?: string[];
  substances?: string[];
  study_type?: string | null;
  pubmed_url?: string | null;
  journal_url?: string | null;
  source?: "pubmed" | "crossref";
  error?: string;
}

// ── Identifier Detection ──

function detectIdentifierType(
  identifier: string
): "pmid" | "doi" | "pubmed_url" | "title" {
  const trimmed = identifier.trim();
  if (/^\d+$/.test(trimmed)) return "pmid";
  if (trimmed.startsWith("10.") || trimmed.toLowerCase().startsWith("doi:")) return "doi";
  if (trimmed.includes("pubmed.ncbi.nlm.nih.gov")) return "pubmed_url";
  return "title";
}

function extractPmidFromUrl(url: string): string | null {
  const match = url.match(/pubmed\.ncbi\.nlm\.nih\.gov\/(\d+)/);
  return match ? match[1] : null;
}

function cleanDoi(doi: string): string {
  return doi.replace(/^doi:/i, "").trim();
}

// ── PubMed API ──

async function fetchFromPubMed(pmid: string): Promise<PaperMetadata | null> {
  try {
    const url = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=${pmid}&retmode=xml`;
    const response = await fetch(url);
    if (!response.ok) return null;

    const xml = await response.text();
    const title = xml.match(/<ArticleTitle[^>]*>([\s\S]*?)<\/ArticleTitle>/)?.[1]?.replace(/<[^>]+>/g, "");

    const authorMatches = xml.matchAll(
      /<Author[^>]*>[\s\S]*?<LastName>([^<]+)<\/LastName>[\s\S]*?<ForeName>([^<]+)<\/ForeName>[\s\S]*?<\/Author>/g
    );
    const authors: string[] = [];
    for (const match of authorMatches) authors.push(`${match[2]} ${match[1]}`);

    const year = xml.match(/<PubDate>[\s\S]*?<Year>(\d{4})<\/Year>/)?.[1];
    const journal = xml.match(/<Title>([^<]+)<\/Title>/)?.[1];
    const doi = xml.match(/<ArticleId IdType="doi">([^<]+)<\/ArticleId>/)?.[1];

    const abstractMatch = xml.match(/<AbstractText[^>]*>([\s\S]*?)<\/AbstractText>/g);
    const abstract = abstractMatch
      ? abstractMatch.map((a) => a.replace(/<[^>]+>/g, "")).join(" ")
      : null;

    const keywordMatches = xml.matchAll(/<Keyword[^>]*>([^<]+)<\/Keyword>/g);
    const keywords: string[] = [];
    for (const match of keywordMatches) keywords.push(match[1]);

    const meshMatches = xml.matchAll(/<DescriptorName[^>]*>([^<]+)<\/DescriptorName>/g);
    const meshTerms: string[] = [];
    for (const match of meshMatches) meshTerms.push(match[1]);

    const substanceMatches = xml.matchAll(/<NameOfSubstance[^>]*>([^<]+)<\/NameOfSubstance>/g);
    const substances: string[] = [];
    for (const match of substanceMatches) substances.push(match[1]);

    const pubTypeMatches = xml.matchAll(/<PublicationType[^>]*>([^<]+)<\/PublicationType>/g);
    const publicationTypes: string[] = [];
    for (const match of pubTypeMatches) publicationTypes.push(match[1]);

    if (!title) return null;

    return {
      identifier: pmid,
      title,
      authors,
      year: year ? parseInt(year) : null,
      journal,
      pmid,
      doi,
      abstract,
      keywords,
      mesh_terms: meshTerms,
      substances,
      study_type: publicationTypes.length > 0 ? publicationTypes.join(", ") : null,
      pubmed_url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
      journal_url: doi ? `https://doi.org/${doi}` : null,
      source: "pubmed",
    };
  } catch (error) {
    console.error("PubMed fetch error:", error);
    return null;
  }
}

async function searchPubMedByDoi(doi: string): Promise<string | null> {
  try {
    const url = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${encodeURIComponent(doi)}[doi]&retmode=json`;
    const response = await fetch(url);
    if (!response.ok) return null;
    const data = await response.json();
    return data.esearchresult?.idlist?.[0] || null;
  } catch {
    return null;
  }
}

async function searchPubMedByTitle(title: string): Promise<string | null> {
  try {
    const url = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${encodeURIComponent(title)}&retmode=json&retmax=1`;
    const response = await fetch(url);
    if (!response.ok) return null;
    const data = await response.json();
    return data.esearchresult?.idlist?.[0] || null;
  } catch {
    return null;
  }
}

// ── Crossref Adapter ──

/**
 * Maps raw Crossref API response to our standardized PaperMetadata schema.
 * Strips JATS XML tags from abstracts, returns empty arrays for missing fields.
 */
function mapCrossrefToSchema(work: Record<string, unknown>, identifier: string): PaperMetadata | null {
  const title = (work.title as string[])?.[0] || null;
  if (!title) return null;

  const authors = ((work.author as Array<{ given?: string; family?: string }>) || [])
    .map((a) => `${a.given || ""} ${a.family || ""}`.trim())
    .filter(Boolean);

  const getYear = (dateField: unknown): number | null => {
    if (!dateField || typeof dateField !== "object") return null;
    const parts = (dateField as Record<string, unknown>)["date-parts"];
    if (!Array.isArray(parts) || !Array.isArray(parts[0])) return null;
    return (parts[0][0] as number) || null;
  };

  const year =
    getYear(work["published-print"]) ||
    getYear(work["published-online"]) ||
    getYear(work.published) ||
    null;

  const journal = (work["container-title"] as string[])?.[0] || null;
  const doi = (work.DOI as string) || null;

  // Strip JATS XML tags from abstract
  const rawAbstract = (work.abstract as string) || "";
  const abstract = rawAbstract
    .replace(/<jats:[^>]+>/g, "")
    .replace(/<\/jats:[^>]+>/g, "")
    .replace(/<[^>]+>/g, "")
    .trim() || null;

  // Crossref 'type' field (e.g., "journal-article") as study type with default weight 1
  const crossrefType = (work.type as string) || null;
  // Convert hyphenated format to title case for readability
  const studyType = crossrefType
    ? crossrefType.split("-").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ")
    : null;

  return {
    identifier,
    title,
    authors,
    year,
    journal,
    pmid: null,
    doi,
    abstract,
    keywords: [],      // Crossref lacks structured keywords; rely on pool scanning
    mesh_terms: [],     // Not available from Crossref
    substances: [],     // Not available from Crossref
    study_type: studyType,
    pubmed_url: null,
    journal_url: doi ? `https://doi.org/${doi}` : null,
    source: "crossref",
  };
}

// ── Crossref API Calls ──

async function fetchFromCrossrefByDoi(doi: string): Promise<PaperMetadata | null> {
  try {
    const cleanedDoi = cleanDoi(doi);
    const url = `https://api.crossref.org/works/${encodeURIComponent(cleanedDoi)}`;
    const response = await fetch(url, {
      headers: { "User-Agent": "PaperIndex/1.0 (mailto:support@paperindex.app)" },
    });
    if (!response.ok) return null;

    const data = await response.json();
    return mapCrossrefToSchema(data.message, doi);
  } catch (error) {
    console.error("Crossref DOI fetch error:", error);
    return null;
  }
}

async function searchCrossrefByTitle(title: string): Promise<PaperMetadata | null> {
  try {
    const url = `https://api.crossref.org/works?query.title=${encodeURIComponent(title)}&rows=1`;
    const response = await fetch(url, {
      headers: { "User-Agent": "PaperIndex/1.0 (mailto:support@paperindex.app)" },
    });
    if (!response.ok) return null;

    const data = await response.json();
    const items = data.message?.items;
    if (!items || items.length === 0) return null;

    return mapCrossrefToSchema(items[0], title);
  } catch (error) {
    console.error("Crossref title search error:", error);
    return null;
  }
}

// ── Composite Fetch with Fallback ──

/**
 * For DOIs: PubMed first (via DOI search → PMID → full fetch), Crossref fallback.
 * Crossref results are enriched with PubMed data if a PMID cross-reference is found.
 */
async function fetchByDoi(doi: string): Promise<PaperMetadata | null> {
  const cleanedDoi = cleanDoi(doi);

  // Try PubMed first
  const pmid = await searchPubMedByDoi(cleanedDoi);
  if (pmid) {
    const pubmedResult = await fetchFromPubMed(pmid);
    if (pubmedResult) {
      // Ensure DOI and journal URL are set
      pubmedResult.doi = pubmedResult.doi || cleanedDoi;
      pubmedResult.journal_url = pubmedResult.journal_url || `https://doi.org/${cleanedDoi}`;
      return pubmedResult;
    }
  }

  // Fallback to Crossref
  console.log(`PubMed unavailable for DOI ${cleanedDoi}, falling back to Crossref`);
  const crossrefResult = await fetchFromCrossrefByDoi(cleanedDoi);
  if (!crossrefResult) return null;

  // Try to cross-reference with PubMed for enrichment
  if (crossrefResult.doi) {
    const enrichPmid = await searchPubMedByDoi(crossrefResult.doi);
    if (enrichPmid) {
      const pubmedData = await fetchFromPubMed(enrichPmid);
      if (pubmedData) {
        crossrefResult.pmid = enrichPmid;
        crossrefResult.keywords = pubmedData.keywords || [];
        crossrefResult.mesh_terms = pubmedData.mesh_terms || [];
        crossrefResult.substances = pubmedData.substances || [];
        crossrefResult.study_type = pubmedData.study_type || crossrefResult.study_type;
        crossrefResult.pubmed_url = pubmedData.pubmed_url;
      }
    }
  }

  return crossrefResult;
}

/**
 * For titles: PubMed first, Crossref fallback.
 */
async function fetchByTitle(title: string): Promise<PaperMetadata | null> {
  // Try PubMed first
  const pmid = await searchPubMedByTitle(title);
  if (pmid) {
    const pubmedResult = await fetchFromPubMed(pmid);
    if (pubmedResult) return pubmedResult;
  }

  // Fallback to Crossref
  console.log(`PubMed unavailable for title "${title}", falling back to Crossref`);
  return await searchCrossrefByTitle(title);
}

// ── Main Handler ──

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { identifiers } = await req.json();

    if (!Array.isArray(identifiers) || identifiers.length === 0) {
      return new Response(
        JSON.stringify({ error: "identifiers array is required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const results: PaperMetadata[] = [];

    for (const identifier of identifiers) {
      const type = detectIdentifierType(identifier);
      let result: PaperMetadata | null = null;

      console.log(`Processing identifier: ${identifier} (type: ${type})`);

      switch (type) {
        case "pmid":
          // PMIDs: PubMed only, no Crossref fallback
          result = await fetchFromPubMed(identifier);
          break;

        case "pubmed_url": {
          const pmid = extractPmidFromUrl(identifier);
          if (pmid) result = await fetchFromPubMed(pmid);
          break;
        }

        case "doi":
          // DOIs: PubMed first, Crossref fallback
          result = await fetchByDoi(identifier);
          break;

        case "title":
          // Titles: PubMed first, Crossref fallback
          result = await fetchByTitle(identifier);
          break;
      }

      if (result) {
        results.push(result);
      } else {
        results.push({ identifier, error: "Could not find paper metadata" });
      }
    }

    return new Response(JSON.stringify({ results }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error: unknown) {
    console.error("Error:", error);
    const errorMessage = error instanceof Error ? error.message : "Internal server error";
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
