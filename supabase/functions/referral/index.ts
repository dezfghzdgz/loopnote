// Loopnote – doporučení: kamarád zadá tvůj kód (nebo otevře tvůj odkaz) a oba dostanete týden Plus zdarma.
// Pravidla: jen nový účet (do 14 dní od registrace), jen jednou, ne sám sobě, jedno zařízení jen jednou.
// Kamarád dostane týden hned; zvoucí až ve chvíli, kdy kamarád v appce opravdu něco zapíše (max. 12 odměn).
// Nasazení: Edge Functions → Deploy a new function → Via Editor → název "referral".
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-device",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "content-type": "application/json" } });
const DAYS = 7, MAX_INVITES = 12, NEW_ACCOUNT_DAYS = 14;

// deno-lint-ignore no-explicit-any
async function extendPlus(sb: any, id: string) {
  const { data: p } = await sb.from("profiles").select("plan, plan_until").eq("id", id).maybeSingle();
  if (p?.plan === "plus" && !p.plan_until) return; // má předplatné – nic neměnit
  const pu = p?.plan_until ? new Date(String(p.plan_until)) : null;
  const from = pu && pu > new Date() ? pu : new Date();
  const until = new Date(from.getTime() + DAYS * 864e5).toISOString();
  await sb.from("profiles").update({ plan: "plus", plan_until: until }).eq("id", id);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ code: "bad_request" }, 405);
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: u } = await sb.auth.getUser(token);
  const me = u?.user;
  if (!me) return json({ code: "not_signed_in" }, 401);
  let body: { action?: string; code?: string } = {};
  try { body = await req.json(); } catch { /* prázdné */ }

  // můj kód, kolik lidí jsem pozval + vyplacení odměn za kamarády, kteří už appku používají
  if (body.action === "me") {
    const { data: open } = await sb.from("referrals").select("invitee, created_at").eq("inviter", me.id).eq("rewarded", false);
    const { count: done } = await sb.from("referrals").select("invitee", { count: "exact", head: true }).eq("inviter", me.id).eq("rewarded", true);
    let paid = done ?? 0;
    for (const r of open ?? []) {
      if (paid >= MAX_INVITES) break;
      const after = new Date(new Date(String(r.created_at)).getTime() + 10 * 60e3).toISOString();
      const { count: used } = await sb.from("docs").select("path", { count: "exact", head: true })
        .like("path", `data/users/${r.invitee}/%/objs/%`).gt("updated_at", after);
      if ((used ?? 0) >= 20) {
        const { data: upd } = await sb.from("referrals").update({ rewarded: true }).eq("invitee", r.invitee).eq("rewarded", false).select("invitee");
        if (upd && upd.length) { await extendPlus(sb, me.id); paid++; }
      }
    }
    let { data: p } = await sb.from("profiles").select("ref_code").eq("id", me.id).maybeSingle();
    if (!p) { await sb.from("profiles").insert({ id: me.id, email: me.email }); ({ data: p } = await sb.from("profiles").select("ref_code").eq("id", me.id).maybeSingle()); }
    const { count } = await sb.from("referrals").select("invitee", { count: "exact", head: true }).eq("inviter", me.id);
    return json({ code: p?.ref_code ?? null, invited: count ?? 0, max: MAX_INVITES, days: DAYS });
  }

  // uplatnit kód kamaráda
  const code = String(body.code ?? "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  if (code.length < 6) return json({ code: "bad_code" }, 400);
  const { data: inv } = await sb.from("profiles").select("id").eq("ref_code", code).maybeSingle();
  if (!inv) return json({ code: "bad_code" }, 404);
  if (inv.id === me.id) return json({ code: "self" }, 400);
  if (Date.now() - new Date(me.created_at).getTime() > NEW_ACCOUNT_DAYS * 864e5) return json({ code: "not_new" }, 400);
  const { data: already } = await sb.from("referrals").select("invitee").eq("invitee", me.id).maybeSingle();
  if (already) return json({ code: "used" }, 400);
  const device = (req.headers.get("x-device") ?? "").slice(0, 64);
  if (device) {
    const { count: dev } = await sb.from("referrals").select("invitee", { count: "exact", head: true }).eq("device", device);
    if ((dev ?? 0) > 0) return json({ code: "used" }, 400);
  }
  const { error } = await sb.from("referrals").insert({ invitee: me.id, inviter: inv.id, device: device || null });
  if (error) return json({ code: "used" }, 400);
  await extendPlus(sb, me.id);
  return json({ ok: true, days: DAYS });
});
