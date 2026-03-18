/// <reference types="https://esm.sh/@supabase/functions-js/src/edge-runtime.d.ts" />

/**
 * Supabase Edge Function: analyze-paper
 *
 * Uses Google Gemini to extract study type, statistical methods, and a TLDR
 * from a paper's title and abstract.
 *
 * Accepts: POST { title: string, abstract: string }
 * Returns: { tldr: string, studyType: string, statisticalMethods: string }
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

Deno.serve(async (req) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // ── 1. Auth validation ──
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: "Missing authorization header" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // ── 2. Parse input ──
    const { title, abstract } = await req.json();
    if (!abstract || typeof abstract !== "string") {
      return new Response(
        JSON.stringify({ error: "Missing or invalid 'abstract' field" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // ── 3. Call Gemini ──
    const geminiKey = Deno.env.get("GEMINI_API_KEY");
    if (!geminiKey) {
      return new Response(
        JSON.stringify({ error: "Gemini API key not configured" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.0-flash:generateContent?key=${geminiKey}`;

    const geminiBody = {
      system_instruction: {
        parts: [{
          text: `You are an academic paper analyzer. Analyze the provided paper title and abstract. Return ONLY a valid JSON object with exactly three keys:
- "tldr": A single-sentence summary of the paper (max 15 words).
- "studyType": The type of study (e.g., RCT, Meta-Analysis, Cohort Study, Systematic Review, Narrative Review, Cross-Sectional, Case-Control, Case Report, In-Vitro, Animal Study, Observational, Qualitative). Pick the single most accurate type.
- "statisticalMethods": A brief comma-separated list of the main statistical methods used (e.g., "ANOVA, logistic regression, Cox proportional hazards"). Return an empty string if no statistical methods are identifiable.`,
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

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      console.error("Gemini API error:", errText);
      return new Response(
        JSON.stringify({ error: "Gemini API request failed", details: errText }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const geminiData = await geminiRes.json();

    // Extract the text content from Gemini's response structure
    const rawText = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!rawText) {
      return new Response(
        JSON.stringify({ error: "Empty response from Gemini" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const parsed = JSON.parse(rawText);

    return new Response(
      JSON.stringify({
        tldr: parsed.tldr || "",
        studyType: parsed.studyType || "",
        statisticalMethods: parsed.statisticalMethods || "",
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error("analyze-paper error:", err);
    return new Response(
      JSON.stringify({ error: err.message || "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
