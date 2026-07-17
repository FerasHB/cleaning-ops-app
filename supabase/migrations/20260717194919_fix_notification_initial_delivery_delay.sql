-- Make push-token ownership exclusive to the currently authenticated user
-- and immediately wake deliveries postponed because the token was missing.

create or replace function public.update_my_push_token(new_token text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_token text := nullif(btrim(new_token), '');
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  if v_token is null then
    raise exception 'Push token is required';
  end if;

  if v_token !~ '^ExponentPushToken\[[A-Za-z0-9_-]+\]$'
     and v_token !~ '^ExpoPushToken\[[A-Za-z0-9_-]+\]$' then
    raise exception 'Invalid Expo push token';
  end if;

  if not exists (
    select 1
    from public.profiles
    where id = v_user_id
      and is_active = true
  ) then
    raise exception 'Active profile not found';
  end if;

  update public.profiles
  set expo_push_token = null
  where expo_push_token = v_token
    and id <> v_user_id;

  update public.profiles
  set expo_push_token = v_token
  where id = v_user_id
    and is_active = true;

  if not found then
    raise exception 'Active profile not found';
  end if;

  update public.notification_deliveries
  set next_attempt_at = now(),
      last_error = null
  where recipient_id = v_user_id
    and status = 'pending'
    and last_error = 'missing_push_token';
end;
$$;

revoke all on function public.update_my_push_token(text) from public;
grant execute on function public.update_my_push_token(text) to authenticated;
