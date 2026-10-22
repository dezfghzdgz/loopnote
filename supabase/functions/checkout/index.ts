// Loopnote – spuštění platby (Stripe Checkout). Appka sem pošle tarif, funkce vrátí odkaz na platební stránku.
// Secrets: STRIPE_SECRET_KEY, STRIPE_PRICE_MONTH, STRIPE_PRICE_YEAR, STRIPE_PRICE_EXAM, (volitelně) TRIAL_DAYS, SITE_URL
import Stripe from "npm:stripe@14.25.0";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "content-type": "application/json" } });
const env = (k: string, d = "") => Deno.env.get(k) ?? d;

const stripe = new Stripe(env("STRIPE_SECRET_KEY"), { apiVersion: "2023-10-16", httpClient: Stripe.createFetchHttpClient() });
const PRICES: Record<string, { price: string; mode: "subscription" | "payment" }> = {
  month: { price: env("STRIPE_PRICE_MONTH"), mode: "subscription" },
  year: { price: env("STRIPE_PRICE_YEAR"), mode: "subscription" },
  exam: { price: env("STRIPE_PRICE_EXAM"), mode: "payment" },
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const sb = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"));
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: u } = await sb.auth.getUser(token);
  const user = u?.user;
  if (!user) return json({ code: "login" }, 401);

  const { plan, back } = await req.json().catch(() => ({}));
  const p = PRICES[plan as string];
  if (!p?.price) return json({ code: "bad_plan" }, 400);

  // návratová adresa: jen vlastní web
  const site = env("SITE_URL");
  const base = typeof back === "string" && (!site || back.startsWith(site)) ? back : (site ? site + "/app/" : "");
  if (!base) return json({ code: "no_site_url" }, 500);

  // Stripe zákazník = jeden na účet
  const { data: prof } = await sb.from("profiles").select("stripe_customer").eq("id", user.id).maybeSingle();
  let customer = prof?.stripe_customer as string | undefined;
  if (!customer) {
    const c = await stripe.customers.create({ email: user.email ?? undefined, metadata: { user_id: user.id } });
    customer = c.id;
    await sb.from("profiles").upsert({ id: user.id, email: user.email, stripe_customer: customer });
  }

  const trial = Number(env("TRIAL_DAYS", "7"));
  const session = await stripe.checkout.sessions.create({
    mode: p.mode,
    customer,
    line_items: [{ price: p.price, quantity: 1 }],
    client_reference_id: user.id,
    metadata: { user_id: user.id, plan },
    ...(p.mode === "subscription"
      ? { subscription_data: { metadata: { user_id: user.id }, ...(trial > 0 ? { trial_period_days: trial } : {}) } }
      : {}),
    allow_promotion_codes: true,
    locale: "auto",
    success_url: base + "?paid=1",
    cancel_url: base + "?paid=0",
  });
  return json({ url: session.url });
});
