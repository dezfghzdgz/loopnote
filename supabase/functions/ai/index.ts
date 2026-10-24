// Loopnote – AI pro appku. Volá Gemini (levné, výchozí) a když je nastavený klíč, Claude na nejtěžší úlohy.
// Když jeden poskytovatel selže, zkusí automaticky druhý. Hlídá denní limit dotazů zdarma.
//
// Tajné proměnné (Supabase → Edge Functions → Secrets):
//   GEMINI_API_KEY      povinné (Google AI Studio)
//   GEMINI_MODEL        volitelné, výchozí gemini-3.6-flash
//   ANTHROPIC_API_KEY   volitelné (console.anthropic.com) – pak se úroveň "complex" (Nejchytřejší) posílá Claudovi
//   ANTHROPIC_MODEL     volitelné, výchozí claude-sonnet-5-5
//   FREE_LIMIT          volitelné, dotazů zdarma denně (výchozí 10)
//   GEMINI_TTS_MODEL    volitelné – model pro přirozený hlas (výchozí gemini-3.8-flash-tts, pak starší)
//   VOICE_LIMIT         volitelné, kolik kousků hlasu / přepisů řeči denně na zařízení (výchozí 400)
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
// každý model má u Googlu vlastní limit – když je jeden vyčerpaný (429), zkusí se další
const GEMINI_MODELS = [env("GEMINI_MODEL"), "gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.5-flash", "gemini-3.8-flash-lite", "gemini-3.5-flash-lite", "gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-flash-latest"].filter(Boolean);
let goodModel = "";
const CLAUDE_KEY = env("ANTHROPIC_API_KEY");
const CLAUDE_MODEL = env("ANTHROPIC_MODEL", "claude-sonnet-5-5");
const FREE_LIMIT = Number(env("FREE_LIMIT", "10"));
const UI_LIMIT = 60; // překlady rozhraní: dávek denně na zařízení
const VOICE_LIMIT = Number(env("VOICE_LIMIT", "400")); // hlas a přepis řeči
// rozhovor „jako v telefonu“ (Gemini Live): appka dostane krátkodobý klíč na jedno spojení, hlavní klíč nikdy neopustí server
const LIVE_MODEL = env("GEMINI_LIVE_MODEL") || "gemini-3.8-live";
async function liveToken() {
  const now = Date.now();
  const r = await fetch("https://generativelanguage.googleapis.com/v1beta/auth_tokens", {
    method: "POST", signal: AbortSignal.timeout(15000), headers: { "x-goog-api-key": GEMINI_KEY, "content-type": "application/json" },
    body: JSON.stringify({ uses: 1, expireTime: new Date(now + 30 * 60e3).toISOString(), newSessionExpireTime: new Date(now + 2 * 60e3).toISOString() }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.name) throw new Error((r.status === 429 ? "busy: " : "") + `live token ${r.status}: ${(d.error && d.error.message) || ""}`.slice(0, 250));
  return { token: d.name as string, model: LIVE_MODEL };
}
const TTS_MODELS = [env("GEMINI_TTS_MODEL"), "gemini-3.8-flash-tts", "gemini-3.8-flash-lite-tts", "gemini-3.1-flash-tts-preview", "gemini-2.5-flash-preview-tts"].filter(Boolean);
const VOICES = new Set(["Zephyr", "Puck", "Charon", "Kore", "Fenrir", "Leda", "Orus", "Aoede", "Callirrhoe", "Autonoe", "Enceladus", "Iapetus", "Umbriel", "Algieba", "Despina", "Erinome", "Algenib", "Rasalgethi", "Laomedeia", "Achernar", "Alnilam", "Schedar", "Gacrux", "Pulcherrima", "Achird", "Zubenelgenubi", "Vindemiatrix", "Sadachbia", "Sadaltager", "Sulafat"]);
let goodTts = ""; let ttsShape = 0;

// přirozený hlas (Gemini TTS): vrací WAV nebo syrové PCM v base64
async function tts(text: string, voice: string) {
  if (!GEMINI_KEY) throw new Error("no_gemini");
  const v = VOICES.has(voice) ? voice : "Kore";
  // nové API má speechConfig.voiceConfig.voice, starší prebuiltVoiceConfig.voiceName – zkusí se obojí
  const shapes = [{ voiceConfig: { voice: v } }, { voiceConfig: { prebuiltVoiceConfig: { voiceName: v } } }];
  let lastErr = "";
  const models = goodTts ? [goodTts, ...TTS_MODELS.filter((m) => m !== goodTts)] : TTS_MODELS;
  for (const model of models) {
    for (const k of [ttsShape, 1 - ttsShape]) {
      let r: Response;
      try { r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`, {
        method: "POST", signal: AbortSignal.timeout(30000), headers: { "content-type": "application/json" },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text }] }], generationConfig: { responseModalities: ["AUDIO"], speechConfig: shapes[k] } }),
      }); } catch (_e) { lastErr = `tts ${model}: timeout`; break; }
      const d = await r.json().catch(() => ({}));
      if (r.status === 404) { lastErr = `tts ${model}: 404`; break; }
      if (r.status === 400) { lastErr = `tts ${model}: ${(d.error && d.error.message) || 400}`; if (/model|not found|not supported/i.test(lastErr) && !/voice/i.test(lastErr)) break; continue; }
      if (!r.ok) { lastErr = `tts ${model} ${r.status}: ${(d.error && d.error.message) || ""}`; break; } // přetížené / chyba → další model
      const part = (d.candidates?.[0]?.content?.parts ?? []).find((p: { inlineData?: unknown; inline_data?: unknown }) => p.inlineData || p.inline_data);
      const inl = part && (part.inlineData || part.inline_data);
      if (!inl?.data) { lastErr = `tts ${model}: no audio`; continue; }
      goodTts = model; ttsShape = k;
      return { audio: inl.data as string, mime: (inl.mimeType || inl.mime_type || "audio/L16;rate=24000") as string };
    }
  }
  if (/ 429/.test(lastErr)) throw new Error("busy: " + lastErr);
  throw new Error("no TTS model available (" + lastErr + ")");
}

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

// rychlost: u běžných dotazů ať model dlouho „nepřemýšlí“ (Gemini 2.5 = thinkingBudget, Gemini 3 = thinkingLevel)
const noThink = new Set<string>(); // modely, které nastavení přemýšlení odmítly
function thinking(model: string, fast: boolean) {
  if (!fast || noThink.has(model)) return {};
  if (/^gemini-2\.5-(flash|flash-lite)/.test(model)) return { thinkingConfig: { thinkingBudget: 0 } };
  if (/^gemini-3/.test(model) && /flash/.test(model)) return { thinkingConfig: { thinkingLevel: "low" } };
  return {};
}
function geminiContents(messages: Msg[], images: Img[], wantJson: boolean) {
  return messages.map((m, i) => {
    const parts: unknown[] = [{ text: m.content + (wantJson && i === messages.length - 1 ? JSON_HINT : "") }];
    if (i === messages.length - 1) for (const im of images) parts.unshift({ inline_data: { mime_type: im.mime, data: im.data } });
    return { role: m.role === "assistant" ? "model" : "user", parts };
  });
}
// zkusí modely popořadě; onDelta != null => odpověď se posílá průběžně (stream)
async function gemini(messages: Msg[], images: Img[], wantJson: boolean, maxTokens: number, fast = true, onDelta?: (t: string) => void) {
  if (!GEMINI_KEY) throw new Error("no_gemini");
  const contents = geminiContents(messages, images, wantJson);
  let lastErr = "", quota = false;
  const t0 = Date.now();
  for (const model of goodModel ? [goodModel, ...GEMINI_MODELS.filter((m) => m !== goodModel)] : GEMINI_MODELS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (Date.now() - t0 > 75000) { lastErr = lastErr || "timeout"; break; } // celkový strop – appka nesmí čekat donekonečna
      const gc = { maxOutputTokens: maxTokens, ...(wantJson ? { responseMimeType: "application/json" } : {}), ...thinking(model, fast) };
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:${onDelta ? "streamGenerateContent?alt=sse&" : "generateContent?"}key=${GEMINI_KEY}`;
      // pojistka proti „zaseknutému“ spojení s Googlem: bez odpovědi do 30 s (nebo bez dalšího kousku textu 30 s) → další model
      const ac = new AbortController();
      let idle = setTimeout(() => ac.abort(), 30000);
      const poke = () => { clearTimeout(idle); idle = setTimeout(() => ac.abort(), 30000); };
      let r: Response;
      try { r = await fetch(url, { method: "POST", signal: ac.signal, headers: { "content-type": "application/json" }, body: JSON.stringify({ contents, generationConfig: gc }) }); }
      catch (_e) { clearTimeout(idle); lastErr = `gemini ${model}: timeout`; break; }
      if (!onDelta) { clearTimeout(idle); idle = setTimeout(() => ac.abort(), 45000); }
      if (!r.ok) {
        clearTimeout(idle);
        const d = await r.json().catch(() => ({}));
        const msg = JSON.stringify(d);
        if (r.status === 400 && /thinking/i.test(msg) && !noThink.has(model)) { noThink.add(model); continue; } // bez nastavení přemýšlení
        if (r.status === 404 || (r.status === 400 && /model|not found|not supported/i.test(msg))) { lastErr = lastErr || `gemini ${model}: ${r.status}`; break; }
        // 429 = vyčerpaný limit tohoto modelu (každý model má vlastní) → zkusit další; 5xx = přetížené → taky další
        if (r.status === 429 || r.status >= 500) { lastErr = `gemini ${model} ${r.status}: ${(d.error && d.error.message) || ""}`.slice(0, 300); quota = quota || r.status === 429; break; }
        throw new Error(`gemini ${model} ${r.status}: ${(d.error && d.error.message) || msg.slice(0, 200)}`);
      }
      if (!onDelta) {
        const d = await r.json().catch(() => null);
        clearTimeout(idle);
        if (!d) { lastErr = `gemini ${model}: timeout`; break; }
        goodModel = model;
        const c = d.candidates?.[0];
        if (!c || c.finishReason === "SAFETY" || c.finishReason === "PROHIBITED_CONTENT") throw new Error("refused");
        return (c.content?.parts ?? []).filter((p: { thought?: boolean }) => !p.thought).map((p: { text?: string }) => p.text ?? "").join("");
      }
      // stream: řádky "data: {...}" od Google → text po kouscích
      const reader = r.body!.getReader(), dec = new TextDecoder();
      let buf = "", full = "", refused = false, cut = false;
      for (;;) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try { chunk = await reader.read(); } catch (_e) { cut = true; break; }
        const { value, done } = chunk;
        if (done) break;
        poke();
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
          if (!line.startsWith("data:")) continue;
          try {
            const d = JSON.parse(line.slice(5));
            const c = d.candidates?.[0];
            if (c && (c.finishReason === "SAFETY" || c.finishReason === "PROHIBITED_CONTENT")) refused = true;
            const t = (c?.content?.parts ?? []).filter((p: { thought?: boolean }) => !p.thought).map((p: { text?: string }) => p.text ?? "").join("");
            if (t) { full += t; onDelta(t); }
          } catch { /* neúplný řádek */ }
        }
      }
      clearTimeout(idle);
      if (refused && !full) throw new Error("refused");
      if (cut && !full) { lastErr = `gemini ${model}: timeout`; break; } // nic nepřišlo → zkusit další model
      goodModel = model;
      return full;
    }
  }
  if (quota) throw new Error("busy: " + lastErr);
  if (/timeout/.test(lastErr)) throw new Error("timeout: " + lastErr);
  throw new Error("no Gemini model available (" + lastErr + ")");
}
// srozumitelná chyba pro appku: busy = vyčerpaný limit u Googlu (bezplatná úroveň má jen pár dotazů za minutu/den)
function errCode(m: string) { return m === "refused" ? "refused" : m.startsWith("busy") ? "busy" : m.startsWith("timeout") ? "timeout" : m === "invalid_json" ? "invalid_json" : "unavailable"; }
function errDetail(m: string) {
  if (!GEMINI_KEY) return "GEMINI_API_KEY is missing in Supabase → Edge Functions → Secrets";
  if (m.startsWith("timeout")) return "Google Gemini did not answer in time (connection stalled). " + m.slice(9, 200);
  if (m.startsWith("busy")) return "Google Gemini quota exceeded (free tier = few requests per minute/day). Fix: aistudio.google.com → Billing → set up billing (Tier 1). " + m.slice(6, 200);
  return m.slice(0, 300);
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

// každá chyba serveru se vrátí jako odpověď s CORS hlavičkami – jinak by ji prohlížeč ukázal jako „jsi offline“
Deno.serve(async (req) => {
  try { return await handle(req); }
  catch (e) { const m = String((e as Error)?.message || e); console.error("handler crash", m); return json({ code: "unavailable", detail: "server error: " + m.slice(0, 200) }, 500); }
});
async function handle(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ code: "bad_request" }, 405);

  let body: { messages?: Msg[]; images?: Img[]; audio?: Img; tier?: string; json?: boolean; purpose?: string; text?: string; voice?: string; stream?: boolean };
  try { body = await req.json(); } catch { return json({ code: "bad_request" }, 400); }
  const isTts = body.purpose === "tts";
  const messages = (isTts ? [{ role: "user", content: String(body.text || "") }] : (body.messages ?? [])).filter((m) => m && typeof m.content === "string").slice(-12)
    .map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.content.slice(0, 200_000) })) as Msg[];
  if (!messages.length || messages[messages.length - 1].role !== "user") return json({ code: "bad_request" }, 400);
  const images = (body.images ?? []).slice(0, 4).filter((i) => i && i.data && i.data.length < 8_000_000);
  // nahraná řeč (WAV) jde Gemini stejně jako obrázek
  const audio = body.audio && body.audio.data && body.audio.data.length < 12_000_000 ? body.audio : null;
  if (audio) images.push(audio);
  const isStt = body.purpose === "stt";
  const isCheck = body.purpose === "check"; // test spojení z Nastavení – ukáže, co přesně Google vrací
  const isWatch = body.purpose === "watch" || isCheck; // hlídání chyb při psaní – vlastní limit, nepočítá se do dotazů
  // přepis řeči: jen jedna zpráva a jen zvuk (ať se přes něj neobchází limit dotazů)
  if (isStt && (!audio || images.length !== 1 || messages.length !== 1)) return json({ code: "bad_request" }, 400);
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
  if (isTts || isStt || isWatch) {
    // hlas a přepis řeči mají vlastní (velkorysý) limit a nepočítají se do dotazů
    const { data: n, error } = await sb.rpc("bump_usage", { p_k: "voice:" + key });
    if (!error && typeof n === "number" && n > VOICE_LIMIT * (plus ? 3 : 1)) return json({ code: "usage" }, 429);
  } else if (!plus || isUi) {
    const { data: n, error } = await sb.rpc("bump_usage", { p_k: (isUi ? "ui:" : "") + key });
    if (!error && typeof n === "number" && n > (isUi ? UI_LIMIT : FREE_LIMIT)) return json({ code: "usage" }, 429);
  }
  if (isCheck) {
    if (!GEMINI_KEY) return json({ ok: false, detail: errDetail("no_gemini"), tried: [] });
    const tried: { model: string; status: number | string; ms: number; msg?: string }[] = [];
    let ok = "";
    for (const model of GEMINI_MODELS) {
      const t = Date.now();
      try {
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`, {
          method: "POST", signal: AbortSignal.timeout(25000), headers: { "content-type": "application/json" },
          body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "Reply with the single word: ok" }] }], generationConfig: { maxOutputTokens: 400 } }),
        });
        const d = await r.json().catch(() => ({}));
        tried.push({ model, status: r.status, ms: Date.now() - t, msg: r.ok ? undefined : String((d.error && d.error.message) || "").slice(0, 160) });
        if (r.ok) { ok = model; goodModel = model; break; }
      } catch (_e) { tried.push({ model, status: "timeout", ms: Date.now() - t }); }
    }
    let voice = "", live = "";
    if (ok) { try { await tts("Ok.", "Kore"); voice = "ok"; } catch (e) { voice = String((e as Error).message || e).slice(0, 200); } }
    try { await liveToken(); live = "ok (" + LIVE_MODEL + ")"; } catch (e) { live = String((e as Error).message || e).slice(0, 200); }
    return json({ ok: !!ok, model: ok, voice, live, tried });
  }
  if (body.purpose === "live") {
    if (!GEMINI_KEY) return json({ code: "unavailable", detail: errDetail("no_gemini") }, 502);
    try { return json(await liveToken()); }
    catch (e) { const m = String((e as Error).message || e); console.error(m); return json({ code: errCode(m), detail: errDetail(m) }, m.startsWith("busy") ? 429 : 502); }
  }
  if (isTts) {
    const text = messages[0].content.trim().slice(0, 1500);
    if (!text) return json({ code: "bad_request" }, 400);
    try { return json(await tts(text, String(body.voice || ""))); }
    catch (e) {
      const m = String((e as Error).message || e); console.error(m);
      return json({ code: errCode(m), detail: errDetail(m) }, m.startsWith("busy") ? 429 : 502);
    }
  }

  // automatické směrování: nejtěžší úlohy Claude (když je klíč), jinak Gemini; při chybě druhý poskytovatel
  // nové modely Gemini „přemýšlí“ a to se počítá do limitu – proto velkorysý strop (platí se jen za skutečně použité)
  const maxTokens = isStt ? 4000 : 8192;
  // zvuk umí jen Gemini
  const order = audio ? [gemini] : tier === "complex" && plus && CLAUDE_KEY ? [claude, gemini] : [gemini, claude];
  const fast = tier !== "complex";

  // průběžná odpověď (text se ukazuje hned, jak vzniká)
  if (body.stream && !wantJson && order[0] === gemini) {
    const enc = new TextEncoder();
    const stream = new ReadableStream({
      async start(ctrl) {
        const send = (o: unknown) => ctrl.enqueue(enc.encode("data: " + JSON.stringify(o) + "\n\n"));
        let sent = false;
        const ping = setInterval(() => { try { ctrl.enqueue(enc.encode(": ping\n\n")); } catch (_e) { /* zavřeno */ } }, 8000);
        try {
          await gemini(messages, images, false, maxTokens, fast, (t) => { sent = true; send({ t }); });
          send({ done: true });
        } catch (e) {
          const m = String((e as Error).message || e);
          // když Gemini selže ještě před prvním slovem, zkusí se Claude (bez streamu)
          if (!sent && m !== "refused" && CLAUDE_KEY) {
            try { send({ t: await claude(messages, images, false, maxTokens) }); send({ done: true }); clearInterval(ping); ctrl.close(); return; } catch (e2) { console.error(e2); }
          }
          console.error(m);
          send({ error: errCode(m), detail: errDetail(m) });
        }
        clearInterval(ping);
        ctrl.close();
      },
    });
    return new Response(stream, { headers: { ...cors, "content-type": "text/event-stream", "cache-control": "no-cache" } });
  }
  let lastErr = "";
  for (const fn of order) {
    try {
      const text = fn === gemini ? await gemini(messages, images, wantJson, maxTokens, fast) : await claude(messages, images, wantJson, maxTokens);
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
  return json({ code: errCode(lastErr), detail: errDetail(lastErr) }, lastErr.startsWith("busy") ? 429 : 502);
}
