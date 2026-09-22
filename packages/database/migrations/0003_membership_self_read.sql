-- "Which organizations do I belong to?" is asked before any organization is
-- known — at login, and when rendering the organization switcher. Under the
-- tenant policy alone that query can never be satisfied, since there is no
-- current organization yet.
--
-- Rather than weakening tenant isolation (or reading memberships as a
-- privileged role), memberships gets a second, narrower policy: a user may
-- SELECT their own membership rows. Writes remain organization-scoped, so this
-- grants visibility of one's own memberships and nothing else.

CREATE OR REPLACE FUNCTION app_current_user() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.current_user_id', true), '')::uuid
$$;
--> statement-breakpoint

CREATE POLICY memberships_self_read ON memberships
  FOR SELECT
  USING (user_id = app_current_user());
