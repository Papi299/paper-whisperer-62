/// <reference types="https://esm.sh/@supabase/functions-js/src/edge-runtime.d.ts" />

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };

/**
 * Fetch with bounded retry and exponential backoff.
 * Retries on 429, 5xx, network errors, and timeouts.
 * Does NOT retry on 4xx (except 429) — those are permanent failures.
 */
async function fetchWithRetry(
  url: string,
  init: RequestInit,
  maxRetries = 2,
  baseDelayMs = 2000,
): Promise<Response> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(15_000),
      });

      if (res.ok) return res;

      // Non-retriable client errors (except 429)
      if (res.status !== 429 && res.status < 500) {
        return res;
      }

      // Retriable: 429 or 5xx
      if (attempt < maxRetries) {
        let delay = baseDelayMs * Math.pow(2, attempt);

        // Respect Retry-After header on 429
        if (res.status === 429) {
          const retryAfter = res.headers.get("Retry-After");
          if (retryAfter) {
            const retryMs = Number(retryAfter) * 1000;
            if (!isNaN(retryMs) && retryMs > 0) {
              delay = Math.min(Math.max(retryMs, delay), 10_000);
            }
          }
        }

        console.log(`fetchWithRetry: attempt ${attempt + 1}/${maxRetries + 1} got ${res.status}, retrying in ${delay}ms`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }

      // Exhausted retries
      return res;
    } catch (err) {
      // Network error or timeout
      if (attempt < maxRetries) {
        const delay = baseDelayMs * Math.pow(2, attempt);
        console.log(`fetchWithRetry: attempt ${attempt + 1}/${maxRetries + 1} threw ${err.message}, retrying in ${delay}ms`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }

  // Unreachable
  throw new Error("fetchWithRetry: exhausted retries");
}

Deno.serve(async (req) => {
  // CORS preflight — MUST be first, before any auth logic
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // ── Step 1: Auth ──
    console.log("1. Checking Auth Header");
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      console.log("1a. Missing Authorization header");
      return new Response(
        JSON.stringify({ error: "Missing Authorization header" }),
        { status: 401, headers: jsonHeaders },
      );
    }
    console.log("1a. Auth header present:", authHeader.substring(0, 20) + "...");

    console.log("2. Calling Supabase getUser");
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError) {
      console.log("2a. Auth error:", authError.message);
      return new Response(
        JSON.stringify({ error: "Auth failed: " + authError.message }),
        { status: 401, headers: jsonHeaders },
      );
    }
    if (!user) {
      console.log("2a. No user returned from getUser");
      return new Response(
        JSON.stringify({ error: "Auth failed: no user returned" }),
        { status: 401, headers: jsonHeaders },
      );
    }
    console.log("2b. User authenticated:", user.id);

    // ── Step 2: Parse input ──
    console.log("3. Parsing request body");
    const { title, abstract } = await req.json();
    if (!abstract || typeof abstract !== "string") {
      console.log("3a. Invalid input: missing or non-string abstract");
      return new Response(
        JSON.stringify({ error: "Missing or invalid 'abstract' field" }),
        { status: 400, headers: jsonHeaders },
      );
    }
    console.log("3a. Title:", (title || "").substring(0, 50), "| Abstract length:", abstract.length);

    // ── Step 3: Call Gemini ──
    console.log("4. Checking Gemini API key");
    const geminiKey = Deno.env.get("GEMINI_API_KEY");
    if (!geminiKey) {
      throw new Error("GEMINI_API_KEY not configured in Supabase secrets");
    }
    console.log("4a. Gemini key present, length:", geminiKey.length);

    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${geminiKey}`;
    console.log("5. Calling Gemini API");

    const geminiBody = {
      system_instruction: {
        parts: [{
          text: `You are an expert academic data extractor. Analyze the provided title and abstract.
CRITICAL RULES:
1. NO GUESSING. Only extract explicit information.
2. ENGLISH ONLY.
3. Return ONLY a valid JSON object with exactly these three keys:
   - tldr: A concise narrative summary of the objective, the main comparison (e.g., Intervention A vs. Intervention B), and the core conclusion (~30-45 words). NARRATIVE RULE: Do not just list numbers. You MUST capture the physiological or clinical meaning of the findings (e.g., 'sustained for 5 hours', 'transient effect', 'greater amplitude than control'). RESULTS RULE: Include key numerical effect sizes to support the narrative, but STRICTLY EXCLUDE all statistical noise (95% CIs, SDs, exact p-values).
   - studyType: The specific study design. TITLE OVERRIDE RULE: If the study design is explicitly stated in the paper's TITLE, you MUST use that exact design. Expand acronyms. Output 'Not specified' if unknown.
   - statisticalMethods: A comma-separated list of analytical tests AND methodological features. VOCABULARY MATCHING RULE: You MUST explicitly check for and include any of the following terms if they are mentioned or implied:
     * Blinding: 'double-blind', 'single-blind', 'triple-blind', 'blinded', 'blinding', 'masked', 'masking'
     * Crossover: 'crossover', 'cross-over', 'crossover study', 'crossover trial'
     * Placebo: 'placebo', 'placebo-controlled'
     * Additional: 'multicenter', 'open-label'
     * Assessment/Guidelines: 'grade', 'prisma', 'cochrane', 'robins-i', 'amstar', 'moose', 'quadas', 'consort', 'strobe', 'prospero'
     Also include standard tests (ANOVA, Odds Ratio, etc.). Output 'Not specified' if none are found.`,
        }],
      },
      contents: [{
        parts: [{
          text: `Title: ${title || "Unknown"}\n\nAbstract: ${abstract}`,
        }],
      }],
      generationConfig: {
        responseMimeType: "application/json",
        temperature: 0.1,
      },
    };

    const geminiRes = await fetchWithRetry(geminiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(geminiBody),
    });

    console.log("5a. Gemini response status:", geminiRes.status);

    if (!geminiRes.ok) {
      const errorText = await geminiRes.text();
      console.log("5b. Gemini error body:", errorText);
      throw new Error("Gemini API Error (" + geminiRes.status + "): " + errorText);
    }

    const geminiData = await geminiRes.json();
    console.log("6. Parsing Gemini response");

    const rawText = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!rawText) {
      console.log("6a. Empty Gemini response. Full data:", JSON.stringify(geminiData));
      throw new Error("Empty response from Gemini");
    }
    console.log("6b. Raw Gemini text:", rawText.substring(0, 200));

    let cleanText = rawText.replace(/```json/gi, "").replace(/```/g, "").trim();
    const startIndex = cleanText.indexOf("{");
    const endIndex = cleanText.lastIndexOf("}");
    if (startIndex === -1 || endIndex === -1) {
      console.log("6c. No JSON object found in:", rawText);
      throw new Error("Gemini response did not contain valid JSON");
    }
    cleanText = cleanText.substring(startIndex, endIndex + 1);
    let parsed;
    try {
      parsed = JSON.parse(cleanText);
    } catch (parseErr) {
      console.log("6c. JSON parse failed. Raw text:", rawText);
      throw new Error("Failed to parse Gemini JSON: " + parseErr.message);
    }
    console.log("7. Success! Returning parsed result");

    return new Response(
      JSON.stringify({
        tldr: parsed.tldr || "",
        studyType: parsed.studyType || "",
        statisticalMethods: parsed.statisticalMethods || "",
      }),
      { status: 200, headers: jsonHeaders },
    );
  } catch (err) {
    console.error("analyze-paper CAUGHT ERROR:", err);
    return new Response(
      JSON.stringify({ error: "Analysis failed. Please try again later." }),
      { status: 500, headers: jsonHeaders },
    );
  }
});
