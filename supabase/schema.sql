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

-- Weaker than is_friend: any connection at all, accepted or still pending.
-- An incoming request has to show WHO it is from, and until it is accepted the
-- two of you are not friends yet.
create or replace function public.knows(other uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from friendships f
    where (f.requester = auth.uid() and f.addressee = other)
       or (f.addressee = auth.uid() and f.requester = other)
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
  day_id      text,                                -- which day of the program, for comparisons
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

-- ------------------------------------------------------------ shared days
-- A training day sent to one friend. Re-sending the same day updates this row
-- and bumps version, so the recipient is offered an update rather than a
-- second copy — and their logged history stays attached to it.
create table if not exists public.shared_days (
  id           uuid primary key default gen_random_uuid(),
  owner_id     uuid not null references public.profiles(id) on delete cascade,
  recipient_id uuid not null references public.profiles(id) on delete cascade,
  day_key      text not null,                      -- the owner's local day id
  day          jsonb not null,                     -- {name, color, ex:[...]}
  version      int not null default 1,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (owner_id, recipient_id, day_key),
  check (owner_id <> recipient_id)
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

-- ----------------------------------------------------------------- migrations
-- Columns added after the first run. Safe on a fresh database too.
alter table public.sessions add column if not exists day_id text;

-- Activity is re-derived from the local log on every sync, so each event needs
-- a stable identity or the feed fills up with copies of the same PR.
alter table public.events add column if not exists dedup_key text;
update public.events set dedup_key = 'legacy:' || id where dedup_key is null;
alter table public.events alter column dedup_key set not null;
create unique index if not exists events_dedup_idx on public.events (user_id, dedup_key);

-- Whether an event has already been pushed to friends' phones. Separate from
-- dedup_key: that stops duplicate ROWS, this stops a second BUZZ for a row
-- that was already announced.
alter table public.events add column if not exists notified boolean not null default false;

-- 16:00 has to mean the user's 16:00, so the reminder job needs their zone.
alter table public.profiles add column if not exists timezone text;

-- -------------------------------------------------------------------- indexes
create index if not exists sessions_user_date_idx on public.sessions (user_id, date desc);
create index if not exists fuel_days_user_date_idx on public.fuel_days (user_id, date desc);
create index if not exists prs_user_exercise_idx on public.prs (user_id, exercise);
create index if not exists events_user_created_idx on public.events (user_id, created_at desc);
create index if not exists events_created_idx on public.events (created_at desc);
create index if not exists friendships_addressee_idx on public.friendships (addressee, status);
create index if not exists friendships_requester_idx on public.friendships (requester, status);
create index if not exists shared_days_recipient_idx on public.shared_days (recipient_id, updated_at desc);

-- ------------------------------------------------------------------------ RLS
alter table public.profiles           enable row level security;
alter table public.friendships        enable row level security;
alter table public.sessions           enable row level security;
alter table public.session_details    enable row level security;
alter table public.fuel_days          enable row level security;
alter table public.prs                enable row level security;
alter table public.events             enable row level security;
alter table public.shared_days       enable row level security;
alter table public.push_subscriptions enable row level security;

-- profiles: yourself and anyone you have a friendship row with, pending
-- included, so a request can show its sender. Everyone else stays invisible;
-- finding someone new goes through find_profile().
drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles for select to authenticated
  using (id = auth.uid() or public.knows(id));

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

-- shared days: both sides of the exchange can read it; only the owner writes,
-- and only to someone who is actually an accepted friend
drop policy if exists shared_days_read on public.shared_days;
create policy shared_days_read on public.shared_days for select to authenticated
  using (owner_id = auth.uid() or recipient_id = auth.uid());

drop policy if exists shared_days_write on public.shared_days;
create policy shared_days_write on public.shared_days for all to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid() and public.is_friend(recipient_id));

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
