


SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


CREATE EXTENSION IF NOT EXISTS "pg_cron" WITH SCHEMA "pg_catalog";






COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE EXTENSION IF NOT EXISTS "pg_stat_statements" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "supabase_vault" WITH SCHEMA "vault";






CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";






CREATE TYPE "public"."app_role" AS ENUM (
    'admin',
    'employee'
);


ALTER TYPE "public"."app_role" OWNER TO "postgres";


CREATE TYPE "public"."job_status" AS ENUM (
    'open',
    'in_progress',
    'completed'
);


ALTER TYPE "public"."job_status" OWNER TO "postgres";


CREATE TYPE "public"."job_type" AS ENUM (
    'single',
    'recurring'
);


ALTER TYPE "public"."job_type" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."complete_own_job"("job_id_input" "uuid", "completed_at_input" timestamp with time zone DEFAULT "now"()) RETURNS timestamp with time zone
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  update public.jobs
  set
    status       = 'completed',
    completed_at = completed_at_input
  where id          = job_id_input
    and assigned_to = auth.uid()
    and company_id  = public.current_user_company_id()
    and public.current_user_role() = 'employee'
    and job_type    = 'single';   -- Parent-Recurring-Regeln dürfen nicht abgeschlossen werden

  if not found then
    raise exception 'Job not found or not allowed';
  end if;

  return completed_at_input;
end;
$$;


ALTER FUNCTION "public"."complete_own_job"("job_id_input" "uuid", "completed_at_input" timestamp with time zone) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."current_user_company_id"() RETURNS "uuid"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select company_id
  from public.profiles
  where id = auth.uid()
  limit 1;
$$;


ALTER FUNCTION "public"."current_user_company_id"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."current_user_role"() RETURNS "text"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select role::text
  from public.profiles
  where id = auth.uid()
  limit 1;
$$;


ALTER FUNCTION "public"."current_user_role"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."enforce_active_assignee"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  must_check boolean := false;
begin
  -- Ohne Zuweisung gibt es nichts zu prüfen (offener Job ist erlaubt).
  if new.assigned_to is null then
    return new;
  end if;

  -- OLD wird bewusst NUR im UPDATE-Zweig gelesen (bei INSERT existiert es
  -- nicht). Re-Validierung bei UPDATE, wenn sich assigned_to oder
  -- company_id ändert (Firmenwechsel des Jobs muss die bestehende
  -- Zuweisung erneut gegen die neue Firma prüfen).
  if tg_op = 'INSERT' then
    must_check := true;
  else
    must_check :=
      new.assigned_to is distinct from old.assigned_to
      or new.company_id is distinct from old.company_id;
  end if;

  if not must_check then
    return new;
  end if;

  if not exists (
    select 1 from public.profiles p
    where p.id         = new.assigned_to
      and p.is_active  = true
      and p.role       = 'employee'
      and p.company_id = new.company_id
  ) then
    raise exception 'Assignee must be an active employee of the same company';
  end if;

  return new;
end;
$$;


ALTER FUNCTION "public"."enforce_active_assignee"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."generate_job_occurrences"("parent_job_id_input" "uuid") RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  parent           public.jobs%rowtype;
  generation_start date;
  generation_end   date;
  hard_limit       date;
  check_date       date;
  day_code         text;
  inserted_count   int := 0;
  rows_affected    int;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  if public.current_user_role() != 'admin' then
    raise exception 'Only admins can generate occurrences';
  end if;

  -- Parent-Job laden: muss recurring sein, darf selbst keine Occurrence sein
  select * into parent
  from public.jobs
  where id          = parent_job_id_input
    and company_id  = public.current_user_company_id()
    and job_type    = 'recurring'
    and parent_job_id is null;

  if not found then
    raise exception 'Recurring parent job not found or not accessible';
  end if;

  -- Startpunkt: frühestens heute — damit keine massenhaften Alttermine entstehen
  generation_start := greatest(
    coalesce(parent.recurrence_start_date, current_date),
    current_date
  );

  -- Hartes Limit: maximal 730 Tage (≈ 2 Jahre) ab Generierungsstart
  hard_limit := generation_start + interval '730 days';

  -- Endpunkt: Enddatum des Parents, begrenzt durch hard_limit
  -- Kein Enddatum gesetzt → 3 Monate voraus
  generation_end := least(
    case
      when parent.recurrence_end_date is not null
        then parent.recurrence_end_date
      else generation_start + interval '3 months'
    end,
    hard_limit
  );

  -- Über jeden Kalendertag im Bereich iterieren
  check_date := generation_start;
  while check_date <= generation_end loop

    -- extract(isodow) ist locale-unabhängig: 1=Mo … 7=So
    day_code := case extract(isodow from check_date)::int
      when 1 then 'mon'
      when 2 then 'tue'
      when 3 then 'wed'
      when 4 then 'thu'
      when 5 then 'fri'
      when 6 then 'sat'
      when 7 then 'sun'
    end;

    if parent.recurring_days @> array[day_code] then

      insert into public.jobs (
        company_id,
        parent_job_id,
        customer_name,
        service_name,
        location_address,
        notes,
        status,
        assigned_to,
        job_type,
        date,
        start_time,
        scheduled_start,
        is_active,
        created_by
      )
      values (
        parent.company_id,
        parent.id,
        parent.customer_name,
        parent.service_name,
        parent.location_address,
        parent.notes,
        'open',
        parent.assigned_to,
        'single',
        check_date,
        parent.start_time,
        -- scheduled_start: Kompatibilitäts-Fallback für bestehende Anzeigen.
        -- Primärquelle bleibt date + start_time.
        case
          when parent.start_time is not null
          then (check_date::text || ' ' || parent.start_time::text)::timestamptz
          else null
        end,
        parent.is_active,
        parent.created_by
      )
      -- Partieller Index: WHERE-Bedingung muss in ON CONFLICT wiederholt werden.
      on conflict (parent_job_id, date, start_time)
        where parent_job_id is not null
      do nothing;

      get diagnostics rows_affected = row_count;
      inserted_count := inserted_count + rows_affected;

    end if;

    check_date := check_date + 1;
  end loop;

  return inserted_count;
end;
$$;


ALTER FUNCTION "public"."generate_job_occurrences"("parent_job_id_input" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."generate_job_occurrences"("parent_job_id_input" "uuid") IS 'Erzeugt konkrete Single-Jobs aus einer Recurring-Regel. Liest Zeitraum aus recurrence_start_date/recurrence_end_date; Fallback: current_date + 3 Monate. Hartes Maximum: 730 Tage. Idempotent.';



CREATE OR REPLACE FUNCTION "public"."get_unread_comment_job_ids"() RETURNS SETOF "uuid"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select c.job_id
  from public.job_comments c
  join public.jobs j on j.id = c.job_id
  where j.company_id = public.current_user_company_id()
    and (
      public.current_user_role() = 'admin'
      or (
        public.current_user_role() = 'employee'
        and j.assigned_to = auth.uid()
      )
    )
    and c.author_id is distinct from auth.uid()
  group by c.job_id
  having max(c.created_at) > coalesce(
    (
      select r.last_seen_at
      from public.job_comment_reads r
      where r.job_id = c.job_id
        and r.user_id = auth.uid()
    ),
    'epoch'::timestamptz
  );
$$;


ALTER FUNCTION "public"."get_unread_comment_job_ids"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."handle_new_user"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  insert into public.profiles (id, full_name)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'full_name', 'New User')
  )
  on conflict (id) do nothing;

  return new;
end;
$$;


ALTER FUNCTION "public"."handle_new_user"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."register_admin_with_company"("p_full_name" "text", "p_company_name" "text", "p_company_slug" "text") RETURNS json
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_user_id    uuid;
  v_company_id uuid;
BEGIN
  v_user_id := auth.uid();

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF trim(p_full_name) = '' THEN
    RAISE EXCEPTION 'Full name is required';
  END IF;

  IF trim(p_company_name) = '' THEN
    RAISE EXCEPTION 'Company name is required';
  END IF;

  IF trim(p_company_slug) = '' THEN
    RAISE EXCEPTION 'Company slug is required';
  END IF;

  INSERT INTO public.companies (name, slug)
  VALUES (trim(p_company_name), trim(p_company_slug))
  RETURNING id INTO v_company_id;

  INSERT INTO public.profiles (
    id,
    full_name,
    role,
    company_id,
    is_active
  )
  VALUES (
    v_user_id,
    trim(p_full_name),
    'admin',
    v_company_id,
    true
  )
  ON CONFLICT (id) DO UPDATE SET
    full_name  = EXCLUDED.full_name,
    role       = 'admin',
    company_id = v_company_id,
    is_active  = true;

  RETURN json_build_object(
    'company_id', v_company_id
  );
END;
$$;


ALTER FUNCTION "public"."register_admin_with_company"("p_full_name" "text", "p_company_name" "text", "p_company_slug" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  new.updated_at = now();
  return new;
end;
$$;


ALTER FUNCTION "public"."set_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."setup_company_for_admin"("company_name" "text") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  new_company_id uuid;
  existing_company_id uuid;
  new_slug text;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  if trim(company_name) = '' then
    raise exception 'Company name is required';
  end if;

  select company_id
  into existing_company_id
  from public.profiles
  where id = auth.uid();

  if existing_company_id is not null then
    raise exception 'User already belongs to a company';
  end if;

  new_slug := lower(trim(company_name));

  new_slug := regexp_replace(new_slug, '\s+', '-', 'g');
  new_slug := regexp_replace(new_slug, '[^a-z0-9\-]', '', 'g');

  new_slug := new_slug || '-' ||
    substring(replace(gen_random_uuid()::text, '-', '') from 1 for 6);

  insert into public.companies (name, slug)
  values (trim(company_name), new_slug)
  returning id into new_company_id;

  update public.profiles
  set
    company_id = new_company_id,
    role = 'admin'
  where id = auth.uid();

  return new_company_id;
end;
$$;


ALTER FUNCTION "public"."setup_company_for_admin"("company_name" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."start_own_job"("job_id_input" "uuid", "started_at_input" timestamp with time zone DEFAULT "now"()) RETURNS timestamp with time zone
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  update public.jobs
  set
    status     = 'in_progress',
    started_at = started_at_input,
    completed_at = null
  where id          = job_id_input
    and assigned_to = auth.uid()
    and company_id  = public.current_user_company_id()
    and public.current_user_role() = 'employee'
    and job_type    = 'single';   -- Parent-Recurring-Regeln dürfen nicht gestartet werden

  if not found then
    raise exception 'Job not found or not allowed';
  end if;

  return started_at_input;
end;
$$;


ALTER FUNCTION "public"."start_own_job"("job_id_input" "uuid", "started_at_input" timestamp with time zone) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_job_occurrences"("parent_job_id_input" "uuid") RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  parent    public.jobs%rowtype;
  new_count int;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  if public.current_user_role() != 'admin' then
    raise exception 'Only admins can update occurrences';
  end if;

  -- Sicherheitscheck: Parent muss zur eigenen Firma gehören
  select * into parent
  from public.jobs
  where id         = parent_job_id_input
    and company_id = public.current_user_company_id()
    and job_type   = 'recurring'
    and parent_job_id is null;

  if not found then
    raise exception 'Recurring parent job not found';
  end if;

  -- Nur zukünftige offene Occurrences entfernen.
  -- 'in_progress' und 'completed' bleiben unangetastet.
  delete from public.jobs
  where parent_job_id = parent_job_id_input
    and status        = 'open'
    and date          >= current_date;

  -- Neu generieren auf Basis der aktualisierten Regel
  select public.generate_job_occurrences(parent_job_id_input)
  into new_count;

  return new_count;
end;
$$;


ALTER FUNCTION "public"."update_job_occurrences"("parent_job_id_input" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."update_job_occurrences"("parent_job_id_input" "uuid") IS 'Löscht zukünftige offene Occurrences und regeneriert auf Basis der aktuellen Regel. Abgeschlossene / laufende Occurrences bleiben erhalten.';


SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."companies" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "slug" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."companies" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."job_comment_reads" (
    "job_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "last_seen_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."job_comment_reads" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."job_comments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "company_id" "uuid" NOT NULL,
    "job_id" "uuid" NOT NULL,
    "author_id" "uuid",
    "message" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."job_comments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."job_photos" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "job_id" "uuid" NOT NULL,
    "company_id" "uuid" NOT NULL,
    "uploaded_by" "uuid" NOT NULL,
    "storage_path" "text" NOT NULL,
    "file_name" "text" NOT NULL,
    "file_size" integer,
    "mime_type" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."job_photos" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."jobs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "company_id" "uuid" NOT NULL,
    "assigned_to" "uuid",
    "created_by" "uuid",
    "customer_name" "text" NOT NULL,
    "service_name" "text" NOT NULL,
    "location_address" "text" NOT NULL,
    "scheduled_start" timestamp with time zone,
    "scheduled_end" timestamp with time zone,
    "status" "public"."job_status" DEFAULT 'open'::"public"."job_status" NOT NULL,
    "started_at" timestamp with time zone,
    "completed_at" timestamp with time zone,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "job_type" "public"."job_type" DEFAULT 'single'::"public"."job_type" NOT NULL,
    "date" "date",
    "start_time" time without time zone,
    "recurring_days" "text"[],
    "is_active" boolean DEFAULT true NOT NULL,
    "parent_job_id" "uuid",
    "recurrence_start_date" "date",
    "recurrence_end_date" "date",
    CONSTRAINT "chk_recurrence_dates" CHECK ((("recurrence_end_date" IS NULL) OR ("recurrence_start_date" IS NULL) OR ("recurrence_end_date" >= "recurrence_start_date"))),
    CONSTRAINT "jobs_completed_at_check" CHECK ((("status" <> 'completed'::"public"."job_status") OR ("completed_at" IS NOT NULL))),
    CONSTRAINT "jobs_started_at_check" CHECK ((("status" <> 'in_progress'::"public"."job_status") OR ("started_at" IS NOT NULL)))
);


ALTER TABLE "public"."jobs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."profiles" (
    "id" "uuid" NOT NULL,
    "company_id" "uuid",
    "full_name" "text" NOT NULL,
    "role" "public"."app_role" DEFAULT 'employee'::"public"."app_role" NOT NULL,
    "phone" "text",
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "expo_push_token" "text"
);


ALTER TABLE "public"."profiles" OWNER TO "postgres";


ALTER TABLE ONLY "public"."companies"
    ADD CONSTRAINT "companies_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."companies"
    ADD CONSTRAINT "companies_slug_key" UNIQUE ("slug");



ALTER TABLE ONLY "public"."job_comment_reads"
    ADD CONSTRAINT "job_comment_reads_pkey" PRIMARY KEY ("job_id", "user_id");



ALTER TABLE ONLY "public"."job_comments"
    ADD CONSTRAINT "job_comments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."job_photos"
    ADD CONSTRAINT "job_photos_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."jobs"
    ADD CONSTRAINT "jobs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_pkey" PRIMARY KEY ("id");



CREATE INDEX "idx_job_comment_reads_user_id" ON "public"."job_comment_reads" USING "btree" ("user_id");



CREATE INDEX "idx_job_comments_job_id" ON "public"."job_comments" USING "btree" ("job_id");



CREATE INDEX "idx_job_photos_company_id" ON "public"."job_photos" USING "btree" ("company_id");



CREATE INDEX "idx_job_photos_created_at" ON "public"."job_photos" USING "btree" ("created_at");



CREATE INDEX "idx_job_photos_job_id" ON "public"."job_photos" USING "btree" ("job_id");



CREATE INDEX "idx_jobs_assigned_to" ON "public"."jobs" USING "btree" ("assigned_to");



CREATE INDEX "idx_jobs_company_id" ON "public"."jobs" USING "btree" ("company_id");



CREATE INDEX "idx_jobs_is_active" ON "public"."jobs" USING "btree" ("is_active");



CREATE INDEX "idx_jobs_job_type" ON "public"."jobs" USING "btree" ("job_type");



CREATE UNIQUE INDEX "idx_jobs_occurrence_unique" ON "public"."jobs" USING "btree" ("parent_job_id", "date", "start_time") WHERE ("parent_job_id" IS NOT NULL);



CREATE INDEX "idx_jobs_parent_job_id" ON "public"."jobs" USING "btree" ("parent_job_id");



CREATE INDEX "idx_jobs_scheduled_start" ON "public"."jobs" USING "btree" ("scheduled_start");



CREATE INDEX "idx_jobs_status" ON "public"."jobs" USING "btree" ("status");



CREATE INDEX "idx_profiles_company_id" ON "public"."profiles" USING "btree" ("company_id");



CREATE INDEX "idx_profiles_role" ON "public"."profiles" USING "btree" ("role");



CREATE OR REPLACE TRIGGER "enforce_active_assignee_on_jobs" BEFORE INSERT OR UPDATE ON "public"."jobs" FOR EACH ROW EXECUTE FUNCTION "public"."enforce_active_assignee"();



CREATE OR REPLACE TRIGGER "trg_companies_updated_at" BEFORE UPDATE ON "public"."companies" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_jobs_updated_at" BEFORE UPDATE ON "public"."jobs" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_profiles_updated_at" BEFORE UPDATE ON "public"."profiles" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



ALTER TABLE ONLY "public"."job_comment_reads"
    ADD CONSTRAINT "job_comment_reads_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."job_comment_reads"
    ADD CONSTRAINT "job_comment_reads_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."job_comments"
    ADD CONSTRAINT "job_comments_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."job_comments"
    ADD CONSTRAINT "job_comments_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."job_comments"
    ADD CONSTRAINT "job_comments_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."job_photos"
    ADD CONSTRAINT "job_photos_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."job_photos"
    ADD CONSTRAINT "job_photos_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."job_photos"
    ADD CONSTRAINT "job_photos_uploaded_by_fkey" FOREIGN KEY ("uploaded_by") REFERENCES "public"."profiles"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."jobs"
    ADD CONSTRAINT "jobs_assigned_to_fkey" FOREIGN KEY ("assigned_to") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."jobs"
    ADD CONSTRAINT "jobs_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."jobs"
    ADD CONSTRAINT "jobs_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."jobs"
    ADD CONSTRAINT "jobs_parent_job_id_fkey" FOREIGN KEY ("parent_job_id") REFERENCES "public"."jobs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_id_fkey" FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



CREATE POLICY "admin delete jobs in own company" ON "public"."jobs" FOR DELETE TO "authenticated" USING ((("public"."current_user_role"() = 'admin'::"text") AND ("company_id" = "public"."current_user_company_id"())));



CREATE POLICY "admin insert comments in own company" ON "public"."job_comments" FOR INSERT TO "authenticated" WITH CHECK ((("public"."current_user_role"() = 'admin'::"text") AND ("author_id" = "auth"."uid"()) AND ("company_id" = "public"."current_user_company_id"()) AND (EXISTS ( SELECT 1
   FROM "public"."jobs" "j"
  WHERE (("j"."id" = "job_comments"."job_id") AND ("j"."company_id" = "public"."current_user_company_id"()))))));



CREATE POLICY "admin insert jobs in own company" ON "public"."jobs" FOR INSERT TO "authenticated" WITH CHECK ((("public"."current_user_role"() = 'admin'::"text") AND ("company_id" = "public"."current_user_company_id"())));



CREATE POLICY "admin insert photos in own company" ON "public"."job_photos" FOR INSERT TO "authenticated" WITH CHECK ((("public"."current_user_role"() = 'admin'::"text") AND ("uploaded_by" = "auth"."uid"()) AND ("company_id" = "public"."current_user_company_id"()) AND (EXISTS ( SELECT 1
   FROM "public"."jobs" "j"
  WHERE (("j"."id" = "job_photos"."job_id") AND ("j"."company_id" = "public"."current_user_company_id"()))))));



CREATE POLICY "admin read comments in own company" ON "public"."job_comments" FOR SELECT TO "authenticated" USING ((("public"."current_user_role"() = 'admin'::"text") AND ("company_id" = "public"."current_user_company_id"())));



CREATE POLICY "admin read jobs in own company" ON "public"."jobs" FOR SELECT TO "authenticated" USING ((("public"."current_user_role"() = 'admin'::"text") AND ("company_id" = "public"."current_user_company_id"())));



CREATE POLICY "admin read photos in own company" ON "public"."job_photos" FOR SELECT TO "authenticated" USING ((("public"."current_user_role"() = 'admin'::"text") AND ("company_id" = "public"."current_user_company_id"())));



CREATE POLICY "admin read profiles in own company" ON "public"."profiles" FOR SELECT TO "authenticated" USING ((("public"."current_user_role"() = 'admin'::"text") AND ("company_id" = "public"."current_user_company_id"())));



CREATE POLICY "admin update jobs in own company" ON "public"."jobs" FOR UPDATE TO "authenticated" USING ((("public"."current_user_role"() = 'admin'::"text") AND ("company_id" = "public"."current_user_company_id"()))) WITH CHECK ((("public"."current_user_role"() = 'admin'::"text") AND ("company_id" = "public"."current_user_company_id"())));



CREATE POLICY "admin update profiles in own company" ON "public"."profiles" FOR UPDATE TO "authenticated" USING ((("public"."current_user_role"() = 'admin'::"text") AND ("company_id" = "public"."current_user_company_id"()))) WITH CHECK ((("public"."current_user_role"() = 'admin'::"text") AND ("company_id" = "public"."current_user_company_id"())));



ALTER TABLE "public"."companies" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "employee insert comments on own jobs" ON "public"."job_comments" FOR INSERT TO "authenticated" WITH CHECK ((("public"."current_user_role"() = 'employee'::"text") AND ("author_id" = "auth"."uid"()) AND ("company_id" = "public"."current_user_company_id"()) AND (EXISTS ( SELECT 1
   FROM "public"."jobs" "j"
  WHERE (("j"."id" = "job_comments"."job_id") AND ("j"."assigned_to" = "auth"."uid"()) AND ("j"."company_id" = "public"."current_user_company_id"()))))));



CREATE POLICY "employee insert photos on own jobs" ON "public"."job_photos" FOR INSERT TO "authenticated" WITH CHECK ((("public"."current_user_role"() = 'employee'::"text") AND ("uploaded_by" = "auth"."uid"()) AND ("company_id" = "public"."current_user_company_id"()) AND (EXISTS ( SELECT 1
   FROM "public"."jobs" "j"
  WHERE (("j"."id" = "job_photos"."job_id") AND ("j"."assigned_to" = "auth"."uid"()) AND ("j"."company_id" = "public"."current_user_company_id"()))))));



CREATE POLICY "employee read comments on own jobs" ON "public"."job_comments" FOR SELECT TO "authenticated" USING ((("public"."current_user_role"() = 'employee'::"text") AND ("company_id" = "public"."current_user_company_id"()) AND (EXISTS ( SELECT 1
   FROM "public"."jobs" "j"
  WHERE (("j"."id" = "job_comments"."job_id") AND ("j"."assigned_to" = "auth"."uid"()))))));



CREATE POLICY "employee read own assigned jobs" ON "public"."jobs" FOR SELECT TO "authenticated" USING ((("public"."current_user_role"() = 'employee'::"text") AND ("job_type" = 'single'::"public"."job_type") AND ("assigned_to" = "auth"."uid"()) AND ("company_id" = "public"."current_user_company_id"())));



CREATE POLICY "employee read own profile" ON "public"."profiles" FOR SELECT TO "authenticated" USING (("id" = "auth"."uid"()));



CREATE POLICY "employee read photos on own jobs" ON "public"."job_photos" FOR SELECT TO "authenticated" USING ((("public"."current_user_role"() = 'employee'::"text") AND ("company_id" = "public"."current_user_company_id"()) AND (EXISTS ( SELECT 1
   FROM "public"."jobs" "j"
  WHERE (("j"."id" = "job_photos"."job_id") AND ("j"."assigned_to" = "auth"."uid"()))))));



CREATE POLICY "employee update own assigned jobs" ON "public"."jobs" FOR UPDATE TO "authenticated" USING ((("public"."current_user_role"() = 'employee'::"text") AND ("assigned_to" = "auth"."uid"()) AND ("company_id" = "public"."current_user_company_id"()))) WITH CHECK ((("public"."current_user_role"() = 'employee'::"text") AND ("assigned_to" = "auth"."uid"()) AND ("company_id" = "public"."current_user_company_id"())));



CREATE POLICY "insert own comment-read state" ON "public"."job_comment_reads" FOR INSERT TO "authenticated" WITH CHECK ((("user_id" = "auth"."uid"()) AND (EXISTS ( SELECT 1
   FROM "public"."jobs" "j"
  WHERE (("j"."id" = "job_comment_reads"."job_id") AND ("j"."company_id" = "public"."current_user_company_id"()) AND (("public"."current_user_role"() = 'admin'::"text") OR (("public"."current_user_role"() = 'employee'::"text") AND ("j"."assigned_to" = "auth"."uid"()))))))));



ALTER TABLE "public"."job_comment_reads" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."job_comments" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."job_photos" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "job_photos: Firma darf Fotos hochladen" ON "public"."job_photos" FOR INSERT TO "authenticated" WITH CHECK ((("company_id" = "public"."current_user_company_id"()) AND ("uploaded_by" = "auth"."uid"()) AND (EXISTS ( SELECT 1
   FROM "public"."jobs" "j"
  WHERE (("j"."id" = "job_photos"."job_id") AND ("j"."company_id" = "public"."current_user_company_id"()))))));



CREATE POLICY "job_photos: Firma darf Fotos lesen" ON "public"."job_photos" FOR SELECT TO "authenticated" USING ((("company_id" = "public"."current_user_company_id"()) AND (EXISTS ( SELECT 1
   FROM "public"."jobs" "j"
  WHERE (("j"."id" = "job_photos"."job_id") AND ("j"."company_id" = "public"."current_user_company_id"()))))));



ALTER TABLE "public"."jobs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."profiles" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "read own comment-read state" ON "public"."job_comment_reads" FOR SELECT TO "authenticated" USING (("user_id" = "auth"."uid"()));



CREATE POLICY "read own company" ON "public"."companies" FOR SELECT TO "authenticated" USING (("id" = "public"."current_user_company_id"()));



CREATE POLICY "update own comment-read state" ON "public"."job_comment_reads" FOR UPDATE TO "authenticated" USING (("user_id" = "auth"."uid"())) WITH CHECK ((("user_id" = "auth"."uid"()) AND (EXISTS ( SELECT 1
   FROM "public"."jobs" "j"
  WHERE (("j"."id" = "job_comment_reads"."job_id") AND ("j"."company_id" = "public"."current_user_company_id"()) AND (("public"."current_user_role"() = 'admin'::"text") OR (("public"."current_user_role"() = 'employee'::"text") AND ("j"."assigned_to" = "auth"."uid"()))))))));



CREATE POLICY "update own profile" ON "public"."profiles" FOR UPDATE TO "authenticated" USING (("id" = "auth"."uid"())) WITH CHECK (("id" = "auth"."uid"()));





ALTER PUBLICATION "supabase_realtime" OWNER TO "postgres";






ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."jobs";






GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";











































































































































































GRANT ALL ON FUNCTION "public"."complete_own_job"("job_id_input" "uuid", "completed_at_input" timestamp with time zone) TO "anon";
GRANT ALL ON FUNCTION "public"."complete_own_job"("job_id_input" "uuid", "completed_at_input" timestamp with time zone) TO "authenticated";
GRANT ALL ON FUNCTION "public"."complete_own_job"("job_id_input" "uuid", "completed_at_input" timestamp with time zone) TO "service_role";



REVOKE ALL ON FUNCTION "public"."current_user_company_id"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."current_user_company_id"() TO "anon";
GRANT ALL ON FUNCTION "public"."current_user_company_id"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."current_user_company_id"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."current_user_role"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."current_user_role"() TO "anon";
GRANT ALL ON FUNCTION "public"."current_user_role"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."current_user_role"() TO "service_role";



GRANT ALL ON FUNCTION "public"."enforce_active_assignee"() TO "anon";
GRANT ALL ON FUNCTION "public"."enforce_active_assignee"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."enforce_active_assignee"() TO "service_role";



GRANT ALL ON FUNCTION "public"."generate_job_occurrences"("parent_job_id_input" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."generate_job_occurrences"("parent_job_id_input" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."generate_job_occurrences"("parent_job_id_input" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_unread_comment_job_ids"() TO "anon";
GRANT ALL ON FUNCTION "public"."get_unread_comment_job_ids"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_unread_comment_job_ids"() TO "service_role";



GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "anon";
GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "service_role";



GRANT ALL ON FUNCTION "public"."register_admin_with_company"("p_full_name" "text", "p_company_name" "text", "p_company_slug" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."register_admin_with_company"("p_full_name" "text", "p_company_name" "text", "p_company_slug" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."register_admin_with_company"("p_full_name" "text", "p_company_name" "text", "p_company_slug" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."set_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."set_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."setup_company_for_admin"("company_name" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."setup_company_for_admin"("company_name" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."setup_company_for_admin"("company_name" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."start_own_job"("job_id_input" "uuid", "started_at_input" timestamp with time zone) TO "anon";
GRANT ALL ON FUNCTION "public"."start_own_job"("job_id_input" "uuid", "started_at_input" timestamp with time zone) TO "authenticated";
GRANT ALL ON FUNCTION "public"."start_own_job"("job_id_input" "uuid", "started_at_input" timestamp with time zone) TO "service_role";



GRANT ALL ON FUNCTION "public"."update_job_occurrences"("parent_job_id_input" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."update_job_occurrences"("parent_job_id_input" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_job_occurrences"("parent_job_id_input" "uuid") TO "service_role";
























GRANT ALL ON TABLE "public"."companies" TO "anon";
GRANT ALL ON TABLE "public"."companies" TO "authenticated";
GRANT ALL ON TABLE "public"."companies" TO "service_role";



GRANT ALL ON TABLE "public"."job_comment_reads" TO "anon";
GRANT ALL ON TABLE "public"."job_comment_reads" TO "authenticated";
GRANT ALL ON TABLE "public"."job_comment_reads" TO "service_role";



GRANT ALL ON TABLE "public"."job_comments" TO "anon";
GRANT ALL ON TABLE "public"."job_comments" TO "authenticated";
GRANT ALL ON TABLE "public"."job_comments" TO "service_role";



GRANT ALL ON TABLE "public"."job_photos" TO "anon";
GRANT ALL ON TABLE "public"."job_photos" TO "authenticated";
GRANT ALL ON TABLE "public"."job_photos" TO "service_role";



GRANT ALL ON TABLE "public"."jobs" TO "anon";
GRANT ALL ON TABLE "public"."jobs" TO "authenticated";
GRANT ALL ON TABLE "public"."jobs" TO "service_role";



GRANT ALL ON TABLE "public"."profiles" TO "anon";
GRANT ALL ON TABLE "public"."profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."profiles" TO "service_role";









ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";































