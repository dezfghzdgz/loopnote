-- Loopnote: základní tabulky. Spusť celé v Supabase → SQL Editor → New query → Run.

-- Profil uživatele: tarif a Stripe zákazník
create table if not exists public.profiles (
  id uuid primary key references auth.users on delete cascade,
  email text,
  plan text not null default 'free' check (plan in ('free','plus')),
  plan_until timestamptz,            -- konec Zkouškového (jednorázová platba); u předplatného null
  stripe_customer text,
  created_at timestamptz not null default now()
);
alter table public.profiles enable row level security;
drop policy if exists "read own profile" on public.profiles;
create policy "read own profile" on public.profiles for select using (auth.uid() = id);

-- profil se založí sám při registraci
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email) values (new.id, new.email) on conflict (id) do nothing;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Přihlášky do bety z webu
create table if not exists public.waitlist (
  id bigint generated always as identity primary key,
  email text not null unique,
  level text,
  device text,
  note text,
  lang text,
  created_at timestamptz not null default now()
);
alter table public.waitlist enable row level security;
drop policy if exists "anyone can join" on public.waitlist;
create policy "anyone can join" on public.waitlist for insert to anon, authenticated
  with check (char_length(email) between 5 and 200 and coalesce(char_length(note),0) <= 1000);

-- Počítadlo dotazů na AI (jen pro server)
create table if not exists public.ai_usage (
  k text not null,
  day date not null default current_date,
  n int not null default 0,
  primary key (k, day)
);
alter table public.ai_usage enable row level security;

create or replace function public.bump_usage(p_k text) returns int
language sql security definer set search_path = public as $$
  insert into public.ai_usage (k, day, n) values (p_k, current_date, 1)
  on conflict (k, day) do update set n = public.ai_usage.n + 1
  returning n;
$$;
revoke execute on function public.bump_usage(text) from public, anon, authenticated;
