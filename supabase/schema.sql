-- Plate Ledger — cloud schema
--
-- Run this once in the Supabase SQL Editor (Dashboard → SQL Editor → New query).
-- It is idempotent: re-running it is safe.
--
-- SECURITY MODEL. The app is a static page in a public repo, so the publishable
-- key is public by design and row-level security is the ONLY thing protecting
-- data. Every table below denies access unless a policy allows it.
--
-- Sharing works in two tiers:
--   * summary  — day name, date, sets, volume, fuel totals, PRs, activity.
--                Visible to accepted friends automatically.
--   * detail   — the individual sets and weights, kept in session_details.
--                Visible only to a friend you have explicitly opted in, per
--                friend, per direction.

-- ---------------------------------------------------------------- extensions
create extension if not exists pgcrypto;

-- ------------------------------------------------------------------- profiles
create table if not exists public.profiles (
  id           uuid primary key references auth.users on delete cascade,
  handle       text unique not null check (handle ~ '^[a-z0-9_]{3,20}$'),
  display_name text not null default '',
  created_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------- friendships
-- One row per pair. Each side independently decides whether THAT friend may
-- see their detail, which is what makes the opt-in per friend and one-way.
create table if not exists public.friendships (
  id                      uuid primary key default gen_random_uuid(),
  requester               uuid not null references public.profiles(id) on delete cascade,
  addressee               uuid not null references public.profiles(id) on delete cascade,
  status                  text not null default 'pending'
                            check (status in ('pending', 'accepted', 'blocked')),
  requester_shares_detail boolean not null default false,
  addressee_shares_detail boolean not null default false,
  created_at              timestamptz not null default now(),
  unique (requester, addressee),
  check (requester <> addressee)
);

-- -------------------------------------------------------------------- lookups
-- SECURITY DEFINER so these can read friendships without tripping that table's
-- own policies — a policy that queries the table it protects recurses forever.
create or replace function public.is_friend(other uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from friendships f
    where f.status = 'accepted'
      and (   (f.requester = auth.uid() and f.addressee = other)
           or (f.addressee = auth.uid() and f.requester = other))
  );
$$;

create or replace function public.sees_detail(owner uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from friendships f
    where f.status = 'accepted'
      and (   (f.requester = owner and f.addressee = auth.uid() and f.requester_shares_detail)
           or (f.addressee = owner and f.requester = auth.uid() and f.addressee_shares_detail))
  );
$$;

-- Adding a friend needs a handle lookup, but the profiles table itself stays
-- closed so the whole user list cannot be enumerated. Exact match only.
create or replace function public.find_profile(handle_input text)
returns table (id uuid, handle text, display_name text)
language sql stable security definer set search_path = public as $$
  select p.id, p.handle, p.display_name
  from profiles p
  where p.handle = lower(trim(handle_input))
    and p.id <> auth.uid()
  limit 1;
$$;

-- ------------------------------------------------------------------- sessions
create table if not exists public.sessions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  client_key  text not null,                       -- local key, makes sync idempotent
  day_name    text not null,
  color       text,
  date        date not null,
  started_at  timestamptz,
  finished_at timestamptz,
  sets_done   int not null default 0,
  volume      numeric not null default 0,
  unit        text not null default 'kg',
  updated_at  timestamptz not null default now(),
  unique (user_id, client_key)
);

-- Split out so "detail" can carry a stricter policy than the summary above.
create table if not exists public.session_details (
  session_id uuid primary key references public.sessions(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  entries    jsonb not null default '{}'::jsonb
);

-- ------------------------------------------------------------------ fuel days
create table if not exists public.fuel_days (
  user_id         uuid not null references public.profiles(id) on delete cascade,
  date            date not null,
  protein         numeric not null default 0,
  creatine        numeric not null default 0,
  water           numeric not null default 0,
  target_protein  numeric,
  target_creatine numeric,
  target_water    numeric,
  updated_at      timestamptz not null default now(),
  primary key (user_id, date)
);

-- ------------------------------------------------------------------------ PRs
create table if not exists public.prs (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  exercise    text not null,
  weight      numeric not null,
  reps        numeric not null,
  e1rm        numeric not null,
  unit        text not null default 'kg',
  per_hand    boolean not null default false,
  achieved_on date not null,
  created_at  timestamptz not null default now(),
  unique (user_id, exercise, achieved_on, weight, reps)
);

-- ------------------------------------------------------------------ activity
create table if not exists public.events (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  type       text not null check (type in
               ('workout_started', 'workout_finished', 'goal_hit', 'pr')),
  payload    jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- --------------------------------------------------------- push subscriptions
create table if not exists public.push_subscriptions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles(id) on delete cascade,
  endpoint   text not null unique,
  p256dh     text not null,
  auth       text not null,
  created_at timestamptz not null default now()
);

-- -------------------------------------------------------------------- indexes
create index if not exists sessions_user_date_idx on public.sessions (user_id, date desc);
create index if not exists fuel_days_user_date_idx on public.fuel_days (user_id, date desc);
create index if not exists prs_user_exercise_idx on public.prs (user_id, exercise);
create index if not exists events_user_created_idx on public.events (user_id, created_at desc);
create index if not exists events_created_idx on public.events (created_at desc);
create index if not exists friendships_addressee_idx on public.friendships (addressee, status);
create index if not exists friendships_requester_idx on public.friendships (requester, status);

-- ------------------------------------------------------------------------ RLS
alter table public.profiles           enable row level security;
alter table public.friendships        enable row level security;
alter table public.sessions           enable row level security;
alter table public.session_details    enable row level security;
alter table public.fuel_days          enable row level security;
alter table public.prs                enable row level security;
alter table public.events             enable row level security;
alter table public.push_subscriptions enable row level security;

-- profiles: yourself and your accepted friends; handle lookup goes via find_profile()
drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles for select to authenticated
  using (id = auth.uid() or public.is_friend(id));

drop policy if exists profiles_write on public.profiles;
create policy profiles_write on public.profiles for insert to authenticated
  with check (id = auth.uid());

drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

-- friendships: only rows you are part of
drop policy if exists friendships_read on public.friendships;
create policy friendships_read on public.friendships for select to authenticated
  using (requester = auth.uid() or addressee = auth.uid());

drop policy if exists friendships_request on public.friendships;
create policy friendships_request on public.friendships for insert to authenticated
  with check (requester = auth.uid());

-- either side may update: the addressee to accept, either to change their own
-- detail flag. Which columns each may touch is enforced by the trigger below.
drop policy if exists friendships_update on public.friendships;
create policy friendships_update on public.friendships for update to authenticated
  using (requester = auth.uid() or addressee = auth.uid())
  with check (requester = auth.uid() or addressee = auth.uid());

drop policy if exists friendships_delete on public.friendships;
create policy friendships_delete on public.friendships for delete to authenticated
  using (requester = auth.uid() or addressee = auth.uid());

-- You may only flip your OWN detail flag, and only the addressee may accept.
create or replace function public.guard_friendship_update()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() = old.requester and new.addressee_shares_detail <> old.addressee_shares_detail then
    raise exception 'cannot change the other side''s sharing setting';
  end if;
  if auth.uid() = old.addressee and new.requester_shares_detail <> old.requester_shares_detail then
    raise exception 'cannot change the other side''s sharing setting';
  end if;
  if new.status = 'accepted' and old.status = 'pending' and auth.uid() <> old.addressee then
    raise exception 'only the addressee can accept a request';
  end if;
  return new;
end;
$$;

drop trigger if exists friendships_guard on public.friendships;
create trigger friendships_guard before update on public.friendships
  for each row execute function public.guard_friendship_update();

-- sessions: summary is friend-visible
drop policy if exists sessions_read on public.sessions;
create policy sessions_read on public.sessions for select to authenticated
  using (user_id = auth.uid() or public.is_friend(user_id));

drop policy if exists sessions_write on public.sessions;
create policy sessions_write on public.sessions for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- session_details: yours, or a friend you opted in
drop policy if exists session_details_read on public.session_details;
create policy session_details_read on public.session_details for select to authenticated
  using (user_id = auth.uid() or public.sees_detail(user_id));

drop policy if exists session_details_write on public.session_details;
create policy session_details_write on public.session_details for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- fuel, PRs, events: summary-tier, friend-visible
drop policy if exists fuel_read on public.fuel_days;
create policy fuel_read on public.fuel_days for select to authenticated
  using (user_id = auth.uid() or public.is_friend(user_id));

drop policy if exists fuel_write on public.fuel_days;
create policy fuel_write on public.fuel_days for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists prs_read on public.prs;
create policy prs_read on public.prs for select to authenticated
  using (user_id = auth.uid() or public.is_friend(user_id));

drop policy if exists prs_write on public.prs;
create policy prs_write on public.prs for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists events_read on public.events;
create policy events_read on public.events for select to authenticated
  using (user_id = auth.uid() or public.is_friend(user_id));

drop policy if exists events_write on public.events;
create policy events_write on public.events for insert to authenticated
  with check (user_id = auth.uid());

-- push subscriptions: strictly private, never friend-visible
drop policy if exists push_own on public.push_subscriptions;
create policy push_own on public.push_subscriptions for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ----------------------------------------------------------------- realtime
-- lets the app receive friends' activity without polling
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'events'
  ) then
    alter publication supabase_realtime add table public.events;
  end if;
end $$;
