-- Loopnote: synchronizace sešitů mezi zařízeními, sdílené sešity se spolužáky, doporučení za odměnu.
-- Supabase → SQL Editor → New query → vlož celé → Run. Jde spustit i opakovaně.

-- 1) dokumenty (sešity, objekty na stránkách, nastavení) – jeden řádek = jedna věc
create table if not exists public.docs (
  path text primary key,
  parent text not null,
  data jsonb,
  deleted boolean not null default false,
  owner uuid default auth.uid(),
  updated_at timestamptz not null default clock_timestamp()
);
alter table public.docs add column if not exists seq bigint;
create sequence if not exists public.docs_seq;
create index if not exists docs_parent_idx on public.docs (parent);
create index if not exists docs_seq_idx on public.docs (seq);
create index if not exists docs_updated_idx on public.docs (updated_at);

-- každá změna dostane rostoucí pořadové číslo – podle něj si zařízení stahují novinky
create or replace function public.docs_touch() returns trigger language plpgsql security definer set search_path = public as $$
begin new.updated_at := clock_timestamp(); new.seq := nextval('public.docs_seq'); return new; end $$;
drop trigger if exists docs_touch on public.docs;
create trigger docs_touch before insert or update on public.docs for each row execute function public.docs_touch();

-- 2) členové sdílených sešitů (kdo zná odkaz/kód, může se připojit)
create table if not exists public.shared_members (
  sid text not null check (length(sid) >= 16),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (sid, user_id)
);

-- kdo smí k dokumentu: data/users/<id>/… jen vlastník, shared/<sid>… jen členové
create or replace function public.can_doc(p text) returns boolean
language sql stable security definer set search_path = public as $$
  select case
    when split_part(p, '/', 1) = 'data' and split_part(p, '/', 2) = 'users' then split_part(p, '/', 3) = auth.uid()::text
    when split_part(p, '/', 1) = 'shared' then exists (select 1 from public.shared_members m where m.sid = split_part(p, '/', 2) and m.user_id = auth.uid())
    else false end
$$;

alter table public.docs enable row level security;
alter table public.shared_members enable row level security;

drop policy if exists docs_select on public.docs;
drop policy if exists docs_insert on public.docs;
drop policy if exists docs_update on public.docs;
drop policy if exists docs_delete on public.docs; -- mazání jen jako značka "deleted", ať se o něm dozví všechna zařízení
create policy docs_select on public.docs for select to authenticated using (public.can_doc(path));
create policy docs_insert on public.docs for insert to authenticated with check (public.can_doc(path) and parent = regexp_replace(path, '/[^/]*$', ''));
create policy docs_update on public.docs for update to authenticated using (public.can_doc(path)) with check (public.can_doc(path) and parent = regexp_replace(path, '/[^/]*$', ''));

drop policy if exists members_select on public.shared_members;
drop policy if exists members_insert on public.shared_members;
drop policy if exists members_delete on public.shared_members;
create policy members_select on public.shared_members for select to authenticated using (user_id = auth.uid());
create policy members_insert on public.shared_members for insert to authenticated with check (user_id = auth.uid());
create policy members_delete on public.shared_members for delete to authenticated using (user_id = auth.uid());

-- čas serveru (aby synchronizace nezávisela na hodinách v zařízení)
create or replace function public.server_now() returns timestamptz language sql stable as $$ select clock_timestamp() $$;
grant execute on function public.server_now() to authenticated;
-- poslední pořadové číslo změny (odkud začít stahovat novinky)
create or replace function public.docs_last_seq() returns bigint language sql stable security definer set search_path = public as $$ select coalesce(max(seq), 0) from public.docs $$;
grant execute on function public.docs_last_seq() to authenticated;

-- 3) doporučení: kód pro pozvání kamaráda, oba dostanou týden Plus
create table if not exists public.referrals (
  invitee uuid primary key references auth.users on delete cascade,
  inviter uuid not null references auth.users on delete cascade,
  created_at timestamptz not null default now(),
  check (invitee <> inviter)
);
alter table public.referrals add column if not exists rewarded boolean not null default false;  -- odměna pro zvoucího až kamarád appku opravdu používá
alter table public.referrals add column if not exists device text;
alter table public.referrals enable row level security;
drop policy if exists referrals_select on public.referrals;
create policy referrals_select on public.referrals for select to authenticated using (inviter = auth.uid() or invitee = auth.uid());
-- zapisuje jen serverová funkce "referral" (service role), uživatel přímo ne

-- kód pro pozvání (každý má svůj, sdílí ho kamarádům)
alter table public.profiles add column if not exists ref_code text;
update public.profiles set ref_code = substr(md5(random()::text || id::text), 1, 8) where ref_code is null;
alter table public.profiles alter column ref_code set default substr(md5(random()::text), 1, 8);
create unique index if not exists profiles_ref_code_idx on public.profiles (ref_code);
