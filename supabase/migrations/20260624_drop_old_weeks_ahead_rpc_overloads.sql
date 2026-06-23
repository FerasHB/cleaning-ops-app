-- =========================================================
-- FIX: Alte RPC-Overloads mit weeks_ahead-Parameter entfernen
-- Datum: 2026-06-24
-- Problem: PostgreSQL hat die neue Signatur (ohne weeks_ahead) als
--   zusätzliche Überladung angelegt, statt die alte zu ersetzen.
--   Damit existieren beide Versionen parallel — das führt zu
--   Aufruf-Mehrdeutigkeiten sobald der App-Code weeks_ahead weglässt.
-- Fix: Alte Overloads explizit droppen.
-- =========================================================

drop function if exists public.generate_job_occurrences(uuid, int);
drop function if exists public.update_job_occurrences(uuid, int);
