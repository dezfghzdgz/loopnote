// Loopnote – Stripe webhook: po zaplacení zapne Plus, po zrušení předplatného ho vypne. Vše automaticky.
// Secrets: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET
// Nasazení s vypnutou kontrolou JWT (Stripe nemá Supabase token): "Verify JWT" = off.
import Stripe from "npm:stripe@14.25.0";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const env = (k: string, d = "") => Deno.env.get(k) ?? d;
const stripe = new Stripe(env("STRIPE_SECRET_KEY"), { apiVersion: "2023-10-16", httpClient: Stripe.createFetchHttpClient() });
const crypto = Stripe.createSubtleCryptoProvider();
const sb = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"));

async function userFor(customer: string | null, meta?: Record<string, string> | null) {
  if (meta?.user_id) return meta.user_id;
  if (!customer) return null;
  const { data } = await sb.from("profiles").select("id").eq("stripe_customer", customer).maybeSingle();
  return data?.id ?? null;
}

async function setPlan(userId: string, plan: "plus" | "free", until: string | null) {
  await sb.from("profiles").update({ plan, plan_until: until }).eq("id", userId);
}

Deno.serve(async (req) => {
  const sig = req.headers.get("stripe-signature");
  const raw = await req.text();
  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(raw, sig!, env("STRIPE_WEBHOOK_SECRET"), undefined, crypto);
  } catch (e) {
    return new Response("bad signature: " + (e as Error).message, { status: 400 });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const s = event.data.object as Stripe.Checkout.Session;
        const uid = s.client_reference_id ?? await userFor(s.customer as string, s.metadata);
        if (!uid) break;
        if (s.mode === "payment") {
          // Zkouškové: 30 dní Plus (prodlouží případný zbývající čas)
          const { data: p } = await sb.from("profiles").select("plan_until").eq("id", uid).maybeSingle();
          const from = p?.plan_until && new Date(p.plan_until) > new Date() ? new Date(p.plan_until) : new Date();
          await setPlan(uid, "plus", new Date(from.getTime() + 30 * 864e5).toISOString());
        } else {
          await setPlan(uid, "plus", null);
        }
        break;
      }
      case "customer.subscription.updated":
      case "customer.subscription.created": {
        const sub = event.data.object as Stripe.Subscription;
        const uid = await userFor(sub.customer as string, sub.metadata);
        if (!uid) break;
        const active = ["active", "trialing"].includes(sub.status);
        await setPlan(uid, active ? "plus" : "free", null);
        break;
      }
      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;
        const uid = await userFor(sub.customer as string, sub.metadata);
        if (uid) await setPlan(uid, "free", null);
        break;
      }
    }
  } catch (e) {
    console.error(e);
    return new Response("error", { status: 500 });
  }
  return new Response(JSON.stringify({ received: true }), { headers: { "content-type": "application/json" } });
});
