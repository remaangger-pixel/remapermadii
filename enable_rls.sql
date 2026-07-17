-- Enable Row Level Security + baseline policies for Movies, Series, Episodes
-- Public (anon key) can only SELECT. INSERT/UPDATE/DELETE require a logged-in
-- Supabase Auth session (matches admin.html / login.html flow).
-- Safe to re-run: drops existing policy with the same name before recreating.
--
-- NOTE: this table previously had legacy permissive policies ("Auth" granting
-- ALL to anon, "Enable read access for all users" granting ALL to
-- authenticated/public, "Allow public update view_count" granting unrestricted
-- UPDATE) that stayed active alongside any new restrictive policy, because
-- Postgres RLS policies are OR'd together. Those are dropped below — without
-- this, adding a restrictive policy does nothing since the old permissive one
-- still allows the request.

ALTER TABLE "Movies" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Series" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Episodes" ENABLE ROW LEVEL SECURITY;

-- Drop legacy policies that grant unrestricted or anon-unconditional access
DROP POLICY IF EXISTS "My Streaming" ON "Movies";
DROP POLICY IF EXISTS "Auth" ON "Movies";
DROP POLICY IF EXISTS "Enable read access for all users" ON "Movies";
DROP POLICY IF EXISTS "Allow public update view_count" ON "Movies";

DROP POLICY IF EXISTS "Series" ON "Series";
DROP POLICY IF EXISTS "Auth" ON "Series";
DROP POLICY IF EXISTS "Enable read access for all users" ON "Series";

DROP POLICY IF EXISTS "Episodes" ON "Episodes";
DROP POLICY IF EXISTS "Enable read access for all users" ON "Episodes";

-- Public read
DROP POLICY IF EXISTS "Public read Movies" ON "Movies";
CREATE POLICY "Public read Movies" ON "Movies" FOR SELECT USING (true);

DROP POLICY IF EXISTS "Public read Series" ON "Series";
CREATE POLICY "Public read Series" ON "Series" FOR SELECT USING (true);

DROP POLICY IF EXISTS "Public read Episodes" ON "Episodes";
CREATE POLICY "Public read Episodes" ON "Episodes" FOR SELECT USING (true);

-- Writes require an authenticated session
DROP POLICY IF EXISTS "Admin write Movies" ON "Movies";
CREATE POLICY "Admin write Movies" ON "Movies"
  FOR ALL USING (auth.role() = 'authenticated') WITH CHECK (auth.role() = 'authenticated');

DROP POLICY IF EXISTS "Admin write Series" ON "Series";
CREATE POLICY "Admin write Series" ON "Series"
  FOR ALL USING (auth.role() = 'authenticated') WITH CHECK (auth.role() = 'authenticated');

DROP POLICY IF EXISTS "Admin write Episodes" ON "Episodes";
CREATE POLICY "Admin write Episodes" ON "Episodes"
  FOR ALL USING (auth.role() = 'authenticated') WITH CHECK (auth.role() = 'authenticated');
