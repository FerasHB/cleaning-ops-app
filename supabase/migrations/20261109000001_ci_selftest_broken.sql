-- CI self-test: deliberately broken migration. Never merge.
alter table public.ci_selftest_table_that_does_not_exist add column x integer;
