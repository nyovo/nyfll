create table if not exists public.offline_push_personas (
  persona_hash text primary key,
  cipher_text bytea not null,
  cipher_iv bytea not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.offline_push_schedules (
  endpoint_hash text not null,
  char_id text not null,
  char_name text not null,
  push_endpoint text not null,
  push_p256dh text not null,
  push_auth text not null,
  interval_ms bigint not null check (interval_ms >= 60000),
  max_interval_ms bigint not null check (max_interval_ms >= interval_ms),
  next_fire_at timestamptz not null,
  lease_until timestamptz,
  snapshot_cipher bytea,
  snapshot_iv bytea,
  snapshot_version bigint not null default 0 check (snapshot_version >= 0),
  persona_hash text references public.offline_push_personas(persona_hash) on delete set null,
  snapshot_updated_at timestamptz,
  last_heartbeat timestamptz not null default now(),
  decision_state jsonb not null default '{}'::jsonb,
  last_attempt_at timestamptz,
  last_error text,
  fail_count integer not null default 0 check (fail_count >= 0),
  last_sent_at timestamptz,
  sent_today integer not null default 0 check (sent_today >= 0),
  sent_day date not null default current_date,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (endpoint_hash, char_id)
);

create table if not exists public.offline_push_delivery_log (
  id bigint generated always as identity primary key,
  endpoint_hash text not null,
  char_id text not null,
  message_id text,
  attempted_at timestamptz not null default now(),
  outcome text not null check (outcome in ('dispatched', 'send_failed', 'skipped', 'disabled')),
  error_code text,
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists offline_push_due_idx on public.offline_push_schedules(next_fire_at) where enabled;
create index if not exists offline_push_lease_idx on public.offline_push_schedules(lease_until) where enabled;
create index if not exists offline_push_schedule_persona_idx on public.offline_push_schedules(persona_hash);
create index if not exists offline_push_delivery_lookup_idx on public.offline_push_delivery_log(endpoint_hash, char_id, attempted_at desc);

alter table public.offline_push_personas enable row level security;
alter table public.offline_push_schedules enable row level security;
alter table public.offline_push_delivery_log enable row level security;

revoke all on public.offline_push_personas from public, anon, authenticated;
revoke all on public.offline_push_schedules from public, anon, authenticated;
revoke all on public.offline_push_delivery_log from public, anon, authenticated;
grant all on public.offline_push_personas to service_role;
grant all on public.offline_push_schedules to service_role;
grant all on public.offline_push_delivery_log to service_role;
grant usage, select on sequence public.offline_push_delivery_log_id_seq to service_role;

create or replace function public.claim_offline_push_schedules(
  p_limit integer default 1,
  p_lease_seconds integer default 240
)
returns setof public.offline_push_schedules
language sql
security invoker
set search_path = ''
as $$
  with due as (
    select s.endpoint_hash, s.char_id
    from public.offline_push_schedules s
    where s.enabled
      and s.snapshot_cipher is not null
      and s.snapshot_iv is not null
      and s.next_fire_at <= now()
      and (s.lease_until is null or s.lease_until < now())
      and s.last_heartbeat >= now() - interval '7 days'
      and (case when s.sent_day = current_date then s.sent_today else 0 end) < 8
    order by s.next_fire_at
    limit greatest(1, least(p_limit, 10))
    for update skip locked
  )
  update public.offline_push_schedules s
  set lease_until = now() + make_interval(secs => greatest(30, least(p_lease_seconds, 900))),
      last_attempt_at = now(),
      updated_at = now()
  from due
  where s.endpoint_hash = due.endpoint_hash
    and s.char_id = due.char_id
  returning s.*;
$$;

revoke all on function public.claim_offline_push_schedules(integer, integer) from public, anon, authenticated;
grant execute on function public.claim_offline_push_schedules(integer, integer) to service_role;
