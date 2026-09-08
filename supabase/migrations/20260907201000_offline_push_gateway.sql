create extension if not exists pgcrypto with schema extensions;

create schema if not exists offline_push_private;
revoke all on schema offline_push_private from public, anon, authenticated;

create table if not exists offline_push_private.config (
  id boolean primary key default true check (id),
  token_hash text not null,
  updated_at timestamptz not null default now()
);
revoke all on offline_push_private.config from public, anon, authenticated;

insert into offline_push_private.config (id, token_hash)
values (true, '1e4745dfbef9986addc23dc508835d9b4fbf859e0472f1e073e36b9beb0af5f0')
on conflict (id) do update set token_hash = excluded.token_hash, updated_at = now();

create or replace function public.offline_push_gateway(
  p_token text,
  p_action text,
  p_payload jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  expected_hash text;
  result jsonb;
begin
  select c.token_hash into expected_hash
  from offline_push_private.config c
  where c.id = true;

  if expected_hash is null
     or p_token is null
     or encode(extensions.digest(convert_to(p_token, 'UTF8'), 'sha256'), 'hex') <> expected_hash then
    raise insufficient_privilege using message = 'invalid offline push gateway token';
  end if;

  if p_action = 'upsert' then
    insert into public.offline_push_schedules (
      endpoint_hash, char_id, char_name, push_endpoint, push_p256dh, push_auth,
      interval_ms, max_interval_ms, next_fire_at, lease_until,
      snapshot_cipher, snapshot_iv, snapshot_version, snapshot_updated_at,
      last_heartbeat, last_error, fail_count, enabled, updated_at
    ) values (
      p_payload->>'endpoint_hash', p_payload->>'char_id', left(p_payload->>'char_name', 120),
      p_payload->>'push_endpoint', p_payload->>'push_p256dh', p_payload->>'push_auth',
      (p_payload->>'interval_ms')::bigint, (p_payload->>'max_interval_ms')::bigint,
      (p_payload->>'next_fire_at')::timestamptz, null,
      decode(p_payload->>'snapshot_cipher_hex', 'hex'), decode(p_payload->>'snapshot_iv_hex', 'hex'),
      1, now(), now(), null, 0, true, now()
    )
    on conflict (endpoint_hash, char_id) do update set
      char_name = excluded.char_name,
      push_endpoint = excluded.push_endpoint,
      push_p256dh = excluded.push_p256dh,
      push_auth = excluded.push_auth,
      interval_ms = excluded.interval_ms,
      max_interval_ms = excluded.max_interval_ms,
      next_fire_at = excluded.next_fire_at,
      lease_until = null,
      snapshot_cipher = excluded.snapshot_cipher,
      snapshot_iv = excluded.snapshot_iv,
      snapshot_version = 1,
      snapshot_updated_at = now(),
      last_heartbeat = now(),
      last_error = null,
      fail_count = 0,
      enabled = true,
      updated_at = now();
    return jsonb_build_object('ok', true, 'nextFireAt', p_payload->>'next_fire_at');

  elsif p_action = 'disable' then
    update public.offline_push_schedules
    set enabled = false, lease_until = null, updated_at = now()
    where endpoint_hash = p_payload->>'endpoint_hash'
      and (nullif(p_payload->>'char_id', '') is null or char_id = p_payload->>'char_id');
    return jsonb_build_object('ok', true);

  elsif p_action = 'claim' then
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
      limit greatest(1, least(coalesce((p_payload->>'limit')::integer, 1), 3))
      for update skip locked
    ),
    claimed as (
      update public.offline_push_schedules s
      set lease_until = now() + interval '4 minutes', last_attempt_at = now(), updated_at = now()
      from due
      where s.endpoint_hash = due.endpoint_hash and s.char_id = due.char_id
      returning s.*
    )
    select coalesce(jsonb_agg(to_jsonb(claimed)), '[]'::jsonb) into result from claimed;
    return result;

  elsif p_action = 'update' then
    update public.offline_push_schedules
    set lease_until = case when p_payload ? 'lease_until' then
          case when p_payload->>'lease_until' is null then null else (p_payload->>'lease_until')::timestamptz end
        else lease_until end,
        enabled = coalesce((p_payload->>'enabled')::boolean, enabled),
        fail_count = coalesce((p_payload->>'fail_count')::integer, fail_count),
        last_error = case when p_payload ? 'last_error' then p_payload->>'last_error' else last_error end,
        last_sent_at = coalesce((p_payload->>'last_sent_at')::timestamptz, last_sent_at),
        sent_day = coalesce((p_payload->>'sent_day')::date, sent_day),
        sent_today = coalesce((p_payload->>'sent_today')::integer, sent_today),
        next_fire_at = coalesce((p_payload->>'next_fire_at')::timestamptz, next_fire_at),
        decision_state = coalesce(p_payload->'decision_state', decision_state),
        updated_at = now()
    where endpoint_hash = p_payload->>'endpoint_hash' and char_id = p_payload->>'char_id';
    return jsonb_build_object('ok', true);

  elsif p_action = 'log' then
    insert into public.offline_push_delivery_log (
      endpoint_hash, char_id, message_id, outcome, error_code, metadata
    ) values (
      p_payload->>'endpoint_hash', p_payload->>'char_id', p_payload->>'message_id',
      p_payload->>'outcome', p_payload->>'error_code', coalesce(p_payload->'metadata', '{}'::jsonb)
    );
    return jsonb_build_object('ok', true);
  end if;

  raise exception 'unsupported offline push gateway action';
end;
$$;

revoke all on function public.offline_push_gateway(text, text, jsonb) from public;

alter function public.offline_push_gateway(text, text, jsonb)
set schema offline_push_private;

revoke all on function offline_push_private.offline_push_gateway(text, text, jsonb) from public;
grant usage on schema offline_push_private to anon, authenticated, service_role;
grant execute on function offline_push_private.offline_push_gateway(text, text, jsonb) to anon, authenticated, service_role;

create or replace function public.offline_push_gateway(
  p_token text,
  p_action text,
  p_payload jsonb default '{}'::jsonb
)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select offline_push_private.offline_push_gateway(p_token, p_action, p_payload);
$$;

revoke all on function public.offline_push_gateway(text, text, jsonb) from public;
grant execute on function public.offline_push_gateway(text, text, jsonb) to anon, authenticated, service_role;
