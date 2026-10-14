-- Restrict the public (anon key) read policy on Movies/Series so is18 = true rows are no
-- longer readable without going through /api/vip (see api/vip.js, api/_vip-auth.js).
--
-- Before this, "Public read Movies"/"Public read Series" (from enable_rls.sql) used
-- `USING (true)` — every row, VIP included, was readable by anyone who called the Supabase
-- REST API directly with the anon key (same key shipped in every page), with zero PIN check.
-- adult.html's PIN gate was UI-only and never actually restricted the data.
--
-- Safe to re-run: drops the existing policy before recreating.
--
-- admin.html and dashboard.html keep working unchanged: they use a real Supabase Auth login
-- session, which is still covered by the separate "Admin write Movies"/"Admin write Series"
-- policies (FOR ALL, including SELECT, for the authenticated role).
--
-- IMPORTANT: this only takes effect once api/vip.js has SUPABASE_SERVICE_ROLE_KEY configured
-- as an environment variable. Until then, run this migration AFTER deploying that change, or
-- adult.html/player.html will show no VIP content at all (fail-closed, not fail-open — safe,
-- just broken-looking rather than insecure in the meantime).

DROP POLICY IF EXISTS "Public read Movies" ON "Movies";
CREATE POLICY "Public read Movies" ON "Movies" FOR SELECT USING (is18 = false);

DROP POLICY IF EXISTS "Public read Series" ON "Series";
CREATE POLICY "Public read Series" ON "Series" FOR SELECT USING (is18 = false);
