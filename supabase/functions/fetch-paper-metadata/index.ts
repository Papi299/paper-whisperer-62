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
  error?: string;
}

// Detect identifier type
function detectIdentifierType(
  identifier: string
): "pmid" | "doi" | "pubmed_url" | "title" {
  const trimmed = identifier.trim();

  // Check if it's a PMID (numeric)
  if (/^\d+$/.test(trimmed)) {
    return "pmid";
  }

  // Check if it's a DOI
  if (trimmed.startsWith("10.") || trimmed.toLowerCase().startsWith("doi:")) {
    return "doi";
  }

  // Check if it's a PubMed URL
  if (trimmed.includes("pubmed.ncbi.nlm.nih.gov")) {
    return "pubmed_url";
  }

  // Otherwise treat as title
  return "title";
}

// Extract PMID from PubMed URL
function extractPmidFromUrl(url: string): string | null {
  const match = url.match(/pubmed\.ncbi\.nlm\.nih\.gov\/(\d+)/);
  return match ? match[1] : null;
}

// Clean DOI
function cleanDoi(doi: string): string {
  return doi.replace(/^doi:/i, "").trim();
}

// Fetch from PubMed API
async function fetchFromPubMed(pmid: string): Promise<PaperMetadata | null> {
  try {
    const url = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=${pmid}&retmode=xml`;
    const response = await fetch(url);

    if (!response.ok) {
      console.log(`PubMed API error: ${response.status}`);
      return null;
    }

    const xml = await response.text();

    // Parse XML (simple parsing)
    const title = xml.match(/<ArticleTitle[^>]*>([\s\S]*?)<\/ArticleTitle>/)?.[1]?.replace(/<[^>]+>/g, "");
    
    // Extract authors
    const authorMatches = xml.matchAll(
      /<Author[^>]*>[\s\S]*?<LastName>([^<]+)<\/LastName>[\s\S]*?<ForeName>([^<]+)<\/ForeName>[\s\S]*?<\/Author>/g
    );
    const authors: string[] = [];
    for (const match of authorMatches) {
      authors.push(`${match[2]} ${match[1]}`);
    }

    // Extract year
    const yearMatch = xml.match(/<PubDate>[\s\S]*?<Year>(\d{4})<\/Year>/);
    const year = yearMatch ? parseInt(yearMatch[1]) : null;

    // Extract journal
    const journal = xml.match(/<Title>([^<]+)<\/Title>/)?.[1];

    // Extract DOI
    const doi = xml.match(/<ArticleId IdType="doi">([^<]+)<\/ArticleId>/)?.[1];

    // Extract abstract
    const abstractMatch = xml.match(/<AbstractText[^>]*>([\s\S]*?)<\/AbstractText>/g);
    const abstract = abstractMatch
      ? abstractMatch.map((a) => a.replace(/<[^>]+>/g, "")).join(" ")
      : null;

    // Extract keywords
    const keywordMatches = xml.matchAll(/<Keyword[^>]*>([^<]+)<\/Keyword>/g);
    const keywords: string[] = [];
    for (const match of keywordMatches) {
      keywords.push(match[1]);
    }

    // Extract MeSH Terms
    const meshMatches = xml.matchAll(/<DescriptorName[^>]*>([^<]+)<\/DescriptorName>/g);
    const meshTerms: string[] = [];
    for (const match of meshMatches) {
      meshTerms.push(match[1]);
    }

    // Extract Substances
    const substanceMatches = xml.matchAll(/<NameOfSubstance[^>]*>([^<]+)<\/NameOfSubstance>/g);
    const substances: string[] = [];
    for (const match of substanceMatches) {
      substances.push(match[1]);
    }

    // Extract Publication Types (for study type)
    const pubTypeMatches = xml.matchAll(/<PublicationType[^>]*>([^<]+)<\/PublicationType>/g);
    const publicationTypes: string[] = [];
    for (const match of pubTypeMatches) {
      publicationTypes.push(match[1]);
    }
    const studyType = publicationTypes.length > 0 ? publicationTypes.join(", ") : null;

    if (!title) {
      return null;
    }

    return {
      identifier: pmid,
      title,
      authors,
      year,
      journal,
      pmid,
      doi,
      abstract,
      keywords,
      mesh_terms: meshTerms,
      substances,
      study_type: studyType,
      pubmed_url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
      journal_url: doi ? `https://doi.org/${doi}` : null,
    };
  } catch (error) {
    console.error("PubMed fetch error:", error);
    return null;
  }
}

// Search PubMed by DOI
async function searchPubMedByDoi(doi: string): Promise<string | null> {
  try {
    const url = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${encodeURIComponent(
      doi
    )}[doi]&retmode=json`;
    const response = await fetch(url);

    if (!response.ok) {
      return null;
    }

    const data = await response.json();
    const pmid = data.esearchresult?.idlist?.[0];
    return pmid || null;
  } catch (error) {
    console.error("PubMed DOI search error:", error);
    return null;
  }
}

// Fetch from Crossref API (for DOIs), then cross-reference with PubMed
async function fetchFromCrossref(doi: string): Promise<PaperMetadata | null> {
  try {
    const cleanedDoi = cleanDoi(doi);
    const url = `https://api.crossref.org/works/${encodeURIComponent(cleanedDoi)}`;
    const response = await fetch(url, {
      headers: {
        "User-Agent": "PaperIndex/1.0 (mailto:support@paperindex.app)",
      },
    });

    if (!response.ok) {
      console.log(`Crossref API error: ${response.status}`);
      return null;
    }

    const data = await response.json();
    const work = data.message;

    const title = work.title?.[0] || null;
    const authors =
      work.author?.map(
        (a: { given?: string; family?: string }) =>
          `${a.given || ""} ${a.family || ""}`.trim()
      ) || [];
    const year =
      work.published?.["date-parts"]?.[0]?.[0] ||
      work["published-online"]?.["date-parts"]?.[0]?.[0] ||
      work["published-print"]?.["date-parts"]?.[0]?.[0] ||
      null;
    const journal = work["container-title"]?.[0] || null;
    const abstract = work.abstract?.replace(/<[^>]+>/g, "") || null;

    if (!title) {
      return null;
    }

    // Try to find PMID via PubMed search by DOI
    console.log(`Searching PubMed for DOI: ${cleanedDoi}`);
    const pmid = await searchPubMedByDoi(cleanedDoi);
    
    let keywords: string[] = [];
    let meshTerms: string[] = [];
    let substances: string[] = [];
    let studyType: string | null = null;
    let pubmedUrl: string | null = null;

    // If we found a PMID, fetch additional data from PubMed
    if (pmid) {
      console.log(`Found PMID ${pmid} for DOI ${cleanedDoi}, fetching PubMed data`);
      const pubmedData = await fetchFromPubMed(pmid);
      if (pubmedData) {
        keywords = pubmedData.keywords || [];
        meshTerms = pubmedData.mesh_terms || [];
        substances = pubmedData.substances || [];
        studyType = pubmedData.study_type || null;
        pubmedUrl = pubmedData.pubmed_url || null;
      }
    }

    return {
      identifier: doi,
      title,
      authors,
      year,
      journal,
      pmid: pmid || null,
      doi: cleanedDoi,
      abstract,
      keywords,
      mesh_terms: meshTerms,
      substances,
      study_type: studyType,
      pubmed_url: pubmedUrl,
      journal_url: `https://doi.org/${cleanedDoi}`,
    };
  } catch (error) {
    console.error("Crossref fetch error:", error);
    return null;
  }
}

// Search PubMed by title
async function searchPubMedByTitle(title: string): Promise<string | null> {
  try {
    const url = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${encodeURIComponent(
      title
    )}&retmode=json&retmax=1`;
    const response = await fetch(url);

    if (!response.ok) {
      return null;
    }

    const data = await response.json();
    const pmid = data.esearchresult?.idlist?.[0];
    return pmid || null;
  } catch (error) {
    console.error("PubMed search error:", error);
    return null;
  }
}

// Main handler
Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { identifiers } = await req.json();

    if (!Array.isArray(identifiers) || identifiers.length === 0) {
      return new Response(
        JSON.stringify({ error: "identifiers array is required" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const results: PaperMetadata[] = [];

    for (const identifier of identifiers) {
      const type = detectIdentifierType(identifier);
      let result: PaperMetadata | null = null;

      console.log(`Processing identifier: ${identifier} (type: ${type})`);

      switch (type) {
        case "pmid":
          result = await fetchFromPubMed(identifier);
          break;

        case "pubmed_url":
          const pmid = extractPmidFromUrl(identifier);
          if (pmid) {
            result = await fetchFromPubMed(pmid);
          }
          break;

        case "doi":
          // Try Crossref first for DOIs
          result = await fetchFromCrossref(identifier);
          break;

        case "title":
          // Search PubMed first, then try Crossref
          const foundPmid = await searchPubMedByTitle(identifier);
          if (foundPmid) {
            result = await fetchFromPubMed(foundPmid);
          }
          break;
      }

      if (result) {
        results.push(result);
      } else {
        results.push({
          identifier,
          error: "Could not find paper metadata",
        });
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
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
