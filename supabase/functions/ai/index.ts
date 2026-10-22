// Loopnote – AI pro appku. Volá Gemini (levné, výchozí) a když je nastavený klíč, Claude na nejtěžší úlohy.
// Když jeden poskytovatel selže, zkusí automaticky druhý. Hlídá denní limit dotazů zdarma.
//
// Tajné proměnné (Supabase → Edge Functions → Secrets):
//   GEMINI_API_KEY      povinné (Google AI Studio)
//   GEMINI_MODEL        volitelné, výchozí gemini-3.6-flash
//   ANTHROPIC_API_KEY   volitelné (console.anthropic.com) – pak se úroveň "complex" (Nejchytřejší) posílá Claudovi
//   ANTHROPIC_MODEL     volitelné, výchozí claude-sonnet-5-5
//   FREE_LIMIT          volitelné, dotazů zdarma denně (výchozí 10)
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-device",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "content-type": "application/json" } });

const env = (k: string, d = "") => Deno.env.get(k) ?? d;
const GEMINI_KEY = env("GEMINI_API_KEY");
// modely se zkouší popořadě – když některý Google zrovna nemá (404), vezme se další
const GEMINI_MODELS = [env("GEMINI_MODEL"), "gemini-3.6-flash", "gemini-3.5-flash", "gemini-2.5-flash", "gemini-flash-latest", "gemini-2.0-flash"].filter(Boolean);
let goodModel = "";
const CLAUDE_KEY = env("ANTHROPIC_API_KEY");
const CLAUDE_MODEL = env("ANTHROPIC_MODEL", "claude-sonnet-5-5");
const FREE_LIMIT = Number(env("FREE_LIMIT", "10"));
const UI_LIMIT = 60; // překlady rozhraní: dávek denně na zařízení

type Msg = { role: "user" | "assistant"; content: string };
type Img = { mime: string; data: string };

const JSON_HINT =
  "\n\nReply with a single valid JSON object only. No markdown, no code fences, no text before or after it.";

function parseJson(t: string) {
  const s = t.replace(/```(?:json)?/g, "").trim();
  try { return JSON.parse(s); } catch { /* zkusíme vyříznout objekt */ }
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a >= 0 && b > a) return JSON.parse(s.slice(a, b + 1));
  throw new Error("invalid_json");
}

async function gemini(messages: Msg[], images: Img[], wantJson: boolean, maxTokens: number) {
  if (!GEMINI_KEY) throw new Error("no_gemini");
  const contents = messages.map((m, i) => {
    const parts: unknown[] = [{ text: m.content + (wantJson && i === messages.length - 1 ? JSON_HINT : "") }];
    if (i === messages.length - 1) for (const im of images) parts.unshift({ inline_data: { mime_type: im.mime, data: im.data } });
    return { role: m.role === "assistant" ? "model" : "user", parts };
  });
  let lastErr = "";
  for (const model of goodModel ? [goodModel, ...GEMINI_MODELS.filter((m) => m !== goodModel)] : GEMINI_MODELS) {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`,
      { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ contents, generationConfig: { maxOutputTokens: maxTokens, ...(wantJson ? { responseMimeType: "application/json" } : {}) } }) },
    );
    const d = await r.json().catch(() => ({}));
    if (r.status === 404 || (r.status === 400 && /model|not found|not supported/i.test(JSON.stringify(d)))) { lastErr = `gemini ${model}: ${r.status}`; continue; }
    if (!r.ok) throw new Error(`gemini ${model} ${r.status}: ${(d.error && d.error.message) || JSON.stringify(d).slice(0, 200)}`);
    goodModel = model;
    const c = d.candidates?.[0];
    if (!c || c.finishReason === "SAFETY" || c.finishReason === "PROHIBITED_CONTENT") throw new Error("refused");
    return (c.content?.parts ?? []).map((p: { text?: string }) => p.text ?? "").join("");
  }
  throw new Error("no Gemini model available (" + lastErr + ")");
}
async function claude(messages: Msg[], images: Img[], wantJson: boolean, maxTokens: number) {
  if (!CLAUDE_KEY) throw new Error("no_claude");
  const msgs = messages.map((m, i) => {
    const text = m.content + (wantJson && i === messages.length - 1 ? JSON_HINT : "");
    if (i !== messages.length - 1 || !images.length) return { role: m.role, content: text };
    return { role: m.role, content: [
      ...images.map((im) => ({ type: "image", source: { type: "base64", media_type: im.mime, data: im.data } })),
      { type: "text", text },
    ] };
  });
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": CLAUDE_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: maxTokens, messages: msgs }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error("claude_" + r.status + " " + JSON.stringify(d).slice(0, 300));
  if (d.stop_reason === "refusal") throw new Error("refused");
  return (d.content ?? []).filter((b: { type: string }) => b.type === "text").map((b: { text: string }) => b.text).join("");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ code: "bad_request" }, 405);

  let body: { messages?: Msg[]; images?: Img[]; tier?: string; json?: boolean; purpose?: string };
  try { body = await req.json(); } catch { return json({ code: "bad_request" }, 400); }
  const messages = (body.messages ?? []).filter((m) => m && typeof m.content === "string").slice(-12)
    .map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.content.slice(0, 200_000) })) as Msg[];
  if (!messages.length || messages[messages.length - 1].role !== "user") return json({ code: "bad_request" }, 400);
  const images = (body.images ?? []).slice(0, 4).filter((i) => i && i.data && i.data.length < 8_000_000);
  const tier = body.tier ?? "default";
  const wantJson = !!body.json;
  const isUi = body.purpose === "ui";

  // kdo se ptá a jaký má tarif
  const sb = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"));
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  let key = "dev:" + (req.headers.get("x-device") ?? "anon").slice(0, 64);
  let plus = false;
  if (token && token !== env("SUPABASE_ANON_KEY")) {
    const { data } = await sb.auth.getUser(token);
    if (data?.user) {
      key = "u:" + data.user.id;
      const { data: p } = await sb.from("profiles").select("plan, plan_until").eq("id", data.user.id).maybeSingle();
      plus = p?.plan === "plus" && (!p.plan_until || new Date(p.plan_until) > new Date());
    }
  }
  if (!plus || isUi) {
    const { data: n, error } = await sb.rpc("bump_usage", { p_k: (isUi ? "ui:" : "") + key });
    if (!error && typeof n === "number" && n > (isUi ? UI_LIMIT : FREE_LIMIT)) return json({ code: "usage" }, 429);
  }

  // automatické směrování: nejtěžší úlohy Claude (když je klíč), jinak Gemini; při chybě druhý poskytovatel
  const maxTokens = isUi ? 4000 : tier === "quick" ? 1500 : 4000;
  const order = tier === "complex" && plus && CLAUDE_KEY ? [claude, gemini] : [gemini, claude];
  let lastErr = "";
  for (const fn of order) {
    try {
      const text = await fn(messages, images, wantJson, maxTokens);
      if (wantJson) {
        try { return json({ json: parseJson(text) }); } catch { lastErr = "invalid_json"; continue; }
      }
      return json({ text });
    } catch (e) {
      lastErr = String((e as Error).message || e);
      if (lastErr === "refused") return json({ code: "refused" }, 422);
      if (lastErr.startsWith("no_")) continue;
      console.error(lastErr);
    }
  }
  const detail = !GEMINI_KEY ? "GEMINI_API_KEY is missing in Supabase → Edge Functions → Secrets" : lastErr.slice(0, 300);
  return json({ code: lastErr === "invalid_json" ? "invalid_json" : "unavailable", detail }, 502);
});
