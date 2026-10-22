# Loopnote – web, appky a server

Co je v repozitáři:

| Cesta | Co to je |
|---|---|
| `index.html` | Web: kdo jsme, komu pomáháme, ceník, návod na instalaci, přihláška do bety |
| `app/` | Appka Loopnote jako instalovatelná web appka (PWA) – Android tablet, iPad, počítač |
| `config.js` | Sem doplníš adresu a veřejný klíč Supabase (jediný soubor, který upravuješ) |
| `supabase/migrations/0001_init.sql` | Tabulky: profily a tarify, přihlášky do bety, limit dotazů |
| `supabase/functions/ai` | AI pro appku – Gemini, volitelně Claude, automatické přepínání |
| `supabase/functions/checkout` | Spuštění platby (Stripe) |
| `supabase/functions/stripe-webhook` | Po zaplacení zapne Plus, po zrušení vypne – automaticky |
| `vercel.json` | Nastavení hostingu |
| `desktop/` | Appka pro Windows, Mac a Linux (s bublinou nad obrazovkou) |
| `mobile/` | Appka pro Android (Capacitor) |
| `.github/workflows/build-apps.yml` | GitHub z toho sám sestaví instalačky |
| `scripts/prepare-www.mjs` | Zkopíruje web appku do desktopové a mobilní appky |

Žádný build ani `npm install` – je to čistý web. Celé to jde nastavit jen v prohlížeči.

---

## 1. GitHub
1. Založ nový repozitář (např. `krouzek`).
2. **Add file → Upload files** a přetáhni obsah ZIPu (složky `app`, `supabase` a soubory vedle).
3. Commit.

## 2. Supabase (databáze, účty, AI)
1. [supabase.com](https://supabase.com) → **New project** (region Frankfurt / `eu-central-1`).
2. **SQL Editor → New query** → vlož celý `supabase/migrations/0001_init.sql` → **Run**.
3. **Project Settings → API**: zkopíruj **Project URL** a **anon public** klíč → vlož je do `config.js` na GitHubu.
4. **Edge Functions → Deploy a new function → Via Editor** – třikrát:
   - název `ai` → vlož `supabase/functions/ai/index.ts` → Deploy
   - název `checkout` → vlož `supabase/functions/checkout/index.ts` → Deploy
   - název `stripe-webhook` → vlož `supabase/functions/stripe-webhook/index.ts` → v nastavení funkce **vypni „Enforce JWT verification“** → Deploy
5. **Edge Functions → Secrets** – přidej:
   - `GEMINI_API_KEY` – klíč z [aistudio.google.com](https://aistudio.google.com) → Get API key
   - `SITE_URL` – adresa webu z Vercelu, např. `https://krouzek.vercel.app` (bez lomítka na konci)
   - volitelně `ANTHROPIC_API_KEY` – pak volba „Nejchytřejší“ u Plus běží na Claudovi
   - volitelně `FREE_LIMIT` (výchozí 10 dotazů denně zdarma), `GEMINI_MODEL` (výchozí `gemini-3.6-flash`)
6. **Authentication → URL Configuration**: Site URL = adresa webu, do Redirect URLs přidej `https://TVUJ-WEB/app/**`.

> Odesílání e-mailů: Supabase má v základu jen pár přihlašovacích e-mailů za hodinu. Na betu to stačí, později v **Authentication → SMTP** připoj třeba Resend.

## 3. Stripe (automatické platby)
1. [stripe.com](https://stripe.com) → účet. Začni v **Test mode** (přepínač vpravo nahoře).
2. **Product catalog → Add product** „Loopnote Plus“ se třemi cenami v **EUR** a u každé přidej i měny USD a GBP (**Add currency** – Checkout pak zákazníkovi sám ukáže jeho měnu):
   - 3,99 € / 3,99 $ / 3,49 £ měsíčně (recurring, monthly)
   - 29,99 € / 29,99 $ / 25,99 £ ročně (recurring, yearly)
   - produkt „Zkouškové“ 4,99 € / 4,99 $ / 4,49 £ jednorázově (one-off)
3. U každé ceny zkopíruj ID (`price_…`) → do Supabase Secrets jako `STRIPE_PRICE_MONTH`, `STRIPE_PRICE_YEAR`, `STRIPE_PRICE_EXAM`.
   Ceny v appce a na webu se ukazují podle místa (Evropa €, Spojené království £, jinde $). Když je změníš ve Stripe, uprav i `PRICES` v `app/index.html` a na webu v `index.html`.
4. **Developers → API keys** → Secret key → Secret `STRIPE_SECRET_KEY`.
5. **Developers → Webhooks → Add endpoint**:
   - URL: `https://TVUJ-PROJEKT.supabase.co/functions/v1/stripe-webhook`
   - události: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`
   - zkopíruj **Signing secret** → Secret `STRIPE_WEBHOOK_SECRET`.
6. Test: v appce Loopnote Plus → Měsíčně → přihlas se odkazem z e-mailu → zaplať testovací kartou `4242 4242 4242 4242` (jakékoli datum v budoucnu, CVC 123). Po návratu se Plus zapne sám.
7. Až bude vše fungovat, přepni Stripe na **Live** a vyměň klíče a ceny za ostré.

Volitelně: `TRIAL_DAYS` (výchozí 7 dní zdarma u předplatného).

## 4. Vercel (hosting)
1. [vercel.com](https://vercel.com) → **Add New → Project** → vyber repozitář → Framework: **Other** → Deploy.
2. Adresu webu dej do Supabase (`SITE_URL`, Redirect URLs) – viz výše.

## 5. Vyzkoušet na Android tabletu
1. Na tabletu otevři web v **Chromu** → sekce **Vyzkoušet** → **Otevřít appku**.
2. **⋮ → Nainstalovat aplikaci**. Loopnote se objeví na ploše a běží přes celou obrazovku.
3. Zkus: psaní stylusem i prstem, zakroužkování příkladu, Zeptej se, denní lekci, test, import PDF, 12 jazyků (Nastavení → Language).

---

## 6. Stahovací appky (Windows, Mac, Linux, Android)
Appky sestaví GitHub sám – nic neinstaluješ.

1. Do `config.js` přidej dva řádky (vedle `supabaseUrl` a `anonKey`):
   ```js
   siteUrl: "https://TVUJ-WEB.vercel.app",   // kvůli platbám z nainstalované appky
   githubRepo: "tvuj-ucet/loopnote",         // web pak odkazuje na stažení
   ```
2. GitHub → **Actions** → **Build apps** → **Run workflow**. Za ~10 minut jsou dole v běhu ke stažení (Artifacts): `Loopnote-android.apk`, `Loopnote-Setup.exe`, `Loopnote-mac.dmg`, `Loopnote-linux.AppImage`.
3. Veřejné stažení z webu: **Releases → Draft a new release → tag `v0.1.0` → Publish**. Workflow se spustí znovu a soubory nahraje do releasu. Tlačítka v sekci Download na webu pak fungují samy.

**Instalace (beta není podepsaná):**
- Android tablet/mobil: stáhni APK → otevři → povol „Instalovat z tohoto zdroje“.
- Windows: Další informace → Přesto spustit.
- Mac: pravý klik na appku → Otevřít. Pro bublinu povol Nastavení → Soukromí → **Nahrávání obrazovky**.
- iPad/iPhone: zatím přes web (Safari → Sdílet → Přidat na plochu). Nativní appka pro iOS potřebuje Mac s Xcode a Apple Developer účet (99 $/rok).

**Bublina na počítači:** plave nad všemi aplikacemi. Klik nebo **Ctrl+Shift+L** → obrazovka ztmavne → zakroužkuješ cokoli (web, video, PDF) → výřez se uloží do sešitu „From screen“ a otevře se pomocník. Přetažením ji posuneš, trojklikem schováš do dalšího spuštění. Zavřením okna appka běží dál v liště u hodin.

**Přihlášení v nainstalované appce:** kódem z e-mailu. V Supabase → **Authentication → Email Templates → Magic Link** přidej do textu řádek `Kód: {{ .Token }}`. Platba se otevře v prohlížeči a po zaplacení se Plus v appce zapne sám.

## Jak funguje AI a kolik stojí
- Appka posílá dotazy funkci `ai`. Ta hlídá limit zdarma (10/den na zařízení nebo účet), u Plus bez limitu.
- Výchozí je **Gemini Flash** – levné (zhruba haléře za dotaz). Když je nastavený `ANTHROPIC_API_KEY`, nejtěžší úlohy Plus jdou na Clauda. Když jeden poskytovatel neodpoví, funkce automaticky zkusí druhý.
- Překlad rozhraní do dalších jazyků se dělá jednou na zařízení a nepočítá se do limitu dotazů.

## Co zatím chybí (další kroky)
- Synchronizace sešitů mezi zařízeními přes Supabase (teď se ukládá v zařízení; v prototypu na claude.ai sync funguje).
- Bublina mimo appku na **Androidu** (povolení „zobrazovat přes ostatní aplikace“) a rozšíření do Safari pro iPad. Na počítači už funguje.
- Nativní appky pro App Store a Google Play. Pozor: v obchodech se digitální předplatné musí platit přes Apple / Google (In-App Purchase), web dál může přes Stripe.
