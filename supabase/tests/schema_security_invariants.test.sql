-- =========================================================
-- TEST: Schema-wide security invariants
-- =========================================================
-- Guards the whole public schema, not one feature:
--   1. Every table in public has Row Level Security enabled.
--   2. Every SECURITY DEFINER function in public pins search_path.
--   3. Every view in public runs with security_invoker (no RLS bypass).
--   4. SECURITY DEFINER functions callable by anon (not logged in) are
--      exactly the reviewed helpers below. Anything new fails.
--   5. SECURITY DEFINER functions callable by authenticated users are on
--      the reviewed list below. A NEW privileged RPC fails this test until
--      it is added here on purpose, so every new RPC gets a review of its
--      own company / role / assignment checks.
--   6. The job-photos storage bucket is private.
--
-- Read-only (catalog queries only); safe in the hosted SQL Editor too.
-- Fails with RAISE EXCEPTION.
-- =========================================================

do $$
declare
  v_bad text;
  -- Reviewed: role/company lookups return NULL without a session, and the
  -- two trigger functions cannot be called directly ("trigger functions can
  -- only be called as triggers").
  anon_allowed text[] := array[
    'current_user_company_id', 'current_user_role',
    'enforce_active_assignee', 'handle_new_user'
  ];
  -- Reviewed client RPCs. Each one checks role, company and (for employee
  -- actions) assignment itself, see the respective migrations and tests.
  authenticated_allowed text[] := array[
    'accept_own_invite',
    'admin_add_vacation_adjustment',
    'admin_correct_assignment_time',
    'admin_create_absence',
    'admin_force_complete_job',
    'admin_initialize_vacation_year',
    'admin_restore_vacation_from_au',
    'admin_review_au',
    'admin_review_session_assignment',
    'admin_review_vacation',
    'cancel_own_sickness',
    'cancel_own_vacation',
    'clear_my_push_token',
    'complete_own_job',
    'complete_own_job_v2',
    'generate_job_occurrences',
    'get_account_deletion_context',
    'get_assignment_work_summary',
    'get_au_restoration_candidates',
    'get_company_employee_emails',
    'get_company_worktime_export',
    'get_effective_work_sessions',
    'get_job_comments',
    'get_session_correction_audit',
    'get_unread_comment_job_ids',
    'get_work_recovery_queue',
    'is_assigned_to_job',
    'job_in_current_company',
    'pause_own_job',
    'prepare_self_account_deletion',
    'register_admin_with_company',
    'report_own_sickness',
    'request_own_vacation',
    'reset_job_occurrence_assignments',
    'resume_own_job',
    'rollback_self_account_deletion',
    'set_job_assignments',
    'setup_company_for_admin',
    'start_own_job',
    'start_own_job_v2',
    'update_job_occurrences',
    'update_my_push_token',
    'update_own_company',
    'update_own_sickness_end'
  ];
begin
  -- 1
  select string_agg(c.relname, ', ' order by c.relname) into v_bad
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity;
  if v_bad is not null then
    raise exception 'Tables without RLS in public: %', v_bad;
  end if;

  -- 2
  select string_agg(p.oid::regprocedure::text, ', ') into v_bad
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prosecdef
    and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) cfg
                    where cfg like 'search_path=%');
  if v_bad is not null then
    raise exception 'SECURITY DEFINER functions without fixed search_path: %', v_bad;
  end if;

  -- 3
  select string_agg(c.relname, ', ' order by c.relname) into v_bad
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('v', 'm')
    and not coalesce((select bool_or(o in ('security_invoker=true', 'security_invoker=on'))
                      from unnest(c.reloptions) o), false)
    and (has_table_privilege('anon', c.oid, 'SELECT')
         or has_table_privilege('authenticated', c.oid, 'SELECT'));
  if v_bad is not null then
    raise exception 'Client-readable views without security_invoker: %', v_bad;
  end if;

  -- 4
  select string_agg(p.oid::regprocedure::text, ', ') into v_bad
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prosecdef
    and has_function_privilege('anon', p.oid, 'EXECUTE')
    and p.proname <> all (anon_allowed);
  if v_bad is not null then
    raise exception 'SECURITY DEFINER functions executable by anon (not reviewed): %', v_bad;
  end if;

  -- 5
  select string_agg(p.oid::regprocedure::text, ', ') into v_bad
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prosecdef
    and has_function_privilege('authenticated', p.oid, 'EXECUTE')
    and p.proname <> all (anon_allowed || authenticated_allowed);
  if v_bad is not null then
    raise exception 'New SECURITY DEFINER RPC(s) executable by authenticated: %. Review the role/company/assignment checks, then add the name to authenticated_allowed in this test.', v_bad;
  end if;

  -- 6
  if exists (select 1 from storage.buckets where id = 'job-photos' and public) then
    raise exception 'Storage bucket job-photos is public';
  end if;

  raise notice 'PASS schema security invariants (RLS, search_path, views, anon/authenticated definer RPCs, private job-photos bucket)';
end $$;
