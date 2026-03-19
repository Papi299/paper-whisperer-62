/// <reference types="https://esm.sh/@supabase/functions-js/src/edge-runtime.d.ts" />

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };

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
      throw new Error("Missing Authorization header");
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
      throw new Error("Auth failed: " + authError.message);
    }
    if (!user) {
      throw new Error("Auth failed: no user returned");
    }
    console.log("2b. User authenticated:", user.id);

    // ── Step 2: Parse input ──
    console.log("3. Parsing request body");
    const { title, abstract } = await req.json();
    if (!abstract || typeof abstract !== "string") {
      throw new Error("Missing or invalid 'abstract' field");
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

    const geminiRes = await fetch(geminiUrl, {
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

    const parsed = JSON.parse(rawText);
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
      JSON.stringify({ error: err.message || "Unknown error" }),
      { status: 400, headers: jsonHeaders },
    );
  }
});
