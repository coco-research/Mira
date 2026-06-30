-- Project Mira — Row-Level Security policies (Phase 8)
-- Every table is RLS-protected.  The governing principle (SECURITY.md §4):
--   • Any row is readable / writable ONLY by members of its pod.
--   • jobs rows are additionally restricted to the assigned_user_id OR a
--     pod admin (matching SCHEMA.md §3 and DEV_PLAN Phase 8 security gate).
--
-- auth.uid() returns the Supabase Auth UUID of the calling user; we cast
-- to text to match our text-PK user_id convention.
--
-- Each policy is documented with its intent and the reasoning for its scope.

-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  Enable RLS on every coordination table                                 ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
ALTER TABLE pods         ENABLE ROW LEVEL SECURITY;
ALTER TABLE pod_members  ENABLE ROW LEVEL SECURITY;
ALTER TABLE channels     ENABLE ROW LEVEL SECURITY;
ALTER TABLE topics       ENABLE ROW LEVEL SECURITY;
ALTER TABLE jobs         ENABLE ROW LEVEL SECURITY;
ALTER TABLE quota_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics    ENABLE ROW LEVEL SECURITY;
ALTER TABLE previews     ENABLE ROW LEVEL SECURITY;

-- Reusable helper: the set of pod_ids the calling user belongs to.
-- Inlined as a subquery in every policy (a security-definer function would
-- also work, but inline keeps the policy self-contained and auditable).

-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  pods                                                                   ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

-- Members can read the pod rows for pods they belong to.
CREATE POLICY "pods: members can read"
ON pods FOR SELECT
USING (
    id IN (
        SELECT pod_id FROM pod_members
        WHERE user_id = auth.uid()::text
    )
);

-- Any authenticated user can create a pod; they must declare themselves owner.
CREATE POLICY "pods: creator is owner"
ON pods FOR INSERT
WITH CHECK (owner_user_id = auth.uid()::text);

-- Only the pod owner can rename/update pod metadata.
CREATE POLICY "pods: owner can update"
ON pods FOR UPDATE
USING  (owner_user_id = auth.uid()::text)
WITH CHECK (owner_user_id = auth.uid()::text);

-- Only the pod owner can delete a pod (cascades to all child rows).
CREATE POLICY "pods: owner can delete"
ON pods FOR DELETE
USING (owner_user_id = auth.uid()::text);

-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  pod_members                                                            ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

-- Any member can see the roster of their pod (needed for UI presence display).
CREATE POLICY "pod_members: members can read"
ON pod_members FOR SELECT
USING (
    pod_id IN (
        SELECT pod_id FROM pod_members pm2
        WHERE pm2.user_id = auth.uid()::text
    )
);

-- A user can add themselves (join invitation flow); pod admins can add others.
CREATE POLICY "pod_members: self join or admin insert"
ON pod_members FOR INSERT
WITH CHECK (
    user_id = auth.uid()::text
    OR EXISTS (
        SELECT 1 FROM pod_members pm_admin
        WHERE pm_admin.pod_id = pod_members.pod_id
          AND pm_admin.user_id = auth.uid()::text
          AND pm_admin.role = 'admin'
    )
);

-- Admins can change any member's role; members can update their own row (e.g. display name future ext).
CREATE POLICY "pod_members: admin or self can update"
ON pod_members FOR UPDATE
USING (
    user_id = auth.uid()::text
    OR EXISTS (
        SELECT 1 FROM pod_members pm_admin
        WHERE pm_admin.pod_id = pod_members.pod_id
          AND pm_admin.user_id = auth.uid()::text
          AND pm_admin.role = 'admin'
    )
);

-- Users can leave (delete their own row); admins can remove others.
CREATE POLICY "pod_members: admin or self can delete"
ON pod_members FOR DELETE
USING (
    user_id = auth.uid()::text
    OR EXISTS (
        SELECT 1 FROM pod_members pm_admin
        WHERE pm_admin.pod_id = pod_members.pod_id
          AND pm_admin.user_id = auth.uid()::text
          AND pm_admin.role = 'admin'
    )
);

-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  channels                                                               ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

-- Any pod member can read channels (needed for queue display and routing).
CREATE POLICY "channels: pod members can read"
ON channels FOR SELECT
USING (
    pod_id IN (
        SELECT pod_id FROM pod_members
        WHERE user_id = auth.uid()::text
    )
);

-- Editors and admins can create channels in their pod.
CREATE POLICY "channels: editor+ can insert"
ON channels FOR INSERT
WITH CHECK (
    pod_id IN (
        SELECT pod_id FROM pod_members
        WHERE user_id = auth.uid()::text
          AND role IN ('admin', 'editor')
    )
);

-- Channel owner or pod admin can update channel config.
-- Note: config_json MUST NOT contain API keys (application-layer contract).
CREATE POLICY "channels: owner or admin can update"
ON channels FOR UPDATE
USING (
    owner_user_id = auth.uid()::text
    OR pod_id IN (
        SELECT pod_id FROM pod_members
        WHERE user_id = auth.uid()::text AND role = 'admin'
    )
);

-- Channel owner or pod admin can delete.
CREATE POLICY "channels: owner or admin can delete"
ON channels FOR DELETE
USING (
    owner_user_id = auth.uid()::text
    OR pod_id IN (
        SELECT pod_id FROM pod_members
        WHERE user_id = auth.uid()::text AND role = 'admin'
    )
);

-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  topics                                                                 ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
-- pod_id is denormalized so all policies use a single equality check.

-- Any pod member can read the topic queue for their pod.
CREATE POLICY "topics: pod members can read"
ON topics FOR SELECT
USING (
    pod_id IN (
        SELECT pod_id FROM pod_members
        WHERE user_id = auth.uid()::text
    )
);

-- Editors and admins can enqueue topics.
CREATE POLICY "topics: editor+ can insert"
ON topics FOR INSERT
WITH CHECK (
    pod_id IN (
        SELECT pod_id FROM pod_members
        WHERE user_id = auth.uid()::text
          AND role IN ('admin', 'editor')
    )
);

-- Editors and admins can update topic status / scheduling.
CREATE POLICY "topics: editor+ can update"
ON topics FOR UPDATE
USING (
    pod_id IN (
        SELECT pod_id FROM pod_members
        WHERE user_id = auth.uid()::text
          AND role IN ('admin', 'editor')
    )
);

-- Only admins can delete topics (prevents accidental data loss).
CREATE POLICY "topics: admin can delete"
ON topics FOR DELETE
USING (
    pod_id IN (
        SELECT pod_id FROM pod_members
        WHERE user_id = auth.uid()::text AND role = 'admin'
    )
);

-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  jobs — additionally restricted to assigned_user_id + pod admin         ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
-- SELECT: any pod member can see the job board (to know what jobs are
-- available to claim); they can only *act on* rows once they claim them.
CREATE POLICY "jobs: pod members can read"
ON jobs FOR SELECT
USING (
    pod_id IN (
        SELECT pod_id FROM pod_members
        WHERE user_id = auth.uid()::text
    )
);

-- Editors and admins can create job records (e.g. the scheduler agent).
CREATE POLICY "jobs: editor+ can insert"
ON jobs FOR INSERT
WITH CHECK (
    pod_id IN (
        SELECT pod_id FROM pod_members
        WHERE user_id = auth.uid()::text
          AND role IN ('admin', 'editor')
    )
);

-- UPDATE is the claiming operation: only the assigned user can update their
-- own job row post-claim; admins can update any job in the pod (e.g. cancel).
-- Single-assignment atomicity is enforced at the DB level: the agent sends
-- PATCH WHERE assigned_user_id IS NULL; only the first concurrent winner gets
-- a non-empty response (PostgREST returns the updated rows).
CREATE POLICY "jobs: assigned user or admin can update"
ON jobs FOR UPDATE
USING (
    assigned_user_id = auth.uid()::text
    OR pod_id IN (
        SELECT pod_id FROM pod_members
        WHERE user_id = auth.uid()::text AND role = 'admin'
    )
);

-- Only admins can delete jobs (e.g. cleanup after video is posted).
CREATE POLICY "jobs: admin can delete"
ON jobs FOR DELETE
USING (
    pod_id IN (
        SELECT pod_id FROM pod_members
        WHERE user_id = auth.uid()::text AND role = 'admin'
    )
);

-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  quota_ledger                                                           ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
-- All members need to see the whole pod's capacity so the router can pick
-- the member with the most headroom (SCHEMA.md §3 routing policy).
CREATE POLICY "quota_ledger: pod members can read"
ON quota_ledger FOR SELECT
USING (
    pod_id IN (
        SELECT pod_id FROM pod_members
        WHERE user_id = auth.uid()::text
    )
);

-- Each user can only publish their own capacity rows.
CREATE POLICY "quota_ledger: user can publish own capacity"
ON quota_ledger FOR INSERT
WITH CHECK (
    user_id = auth.uid()::text
    AND pod_id IN (
        SELECT pod_id FROM pod_members
        WHERE user_id = auth.uid()::text
    )
);

-- Users update their own rows; admins can reset any row (e.g. clear a stale 429).
CREATE POLICY "quota_ledger: user or admin can update"
ON quota_ledger FOR UPDATE
USING (
    user_id = auth.uid()::text
    OR pod_id IN (
        SELECT pod_id FROM pod_members
        WHERE user_id = auth.uid()::text AND role = 'admin'
    )
);

-- Only admins can prune stale ledger rows.
CREATE POLICY "quota_ledger: admin can delete"
ON quota_ledger FOR DELETE
USING (
    pod_id IN (
        SELECT pod_id FROM pod_members
        WHERE user_id = auth.uid()::text AND role = 'admin'
    )
);

-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  analytics                                                              ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

-- Any pod member can view analytics for videos in their pod.
CREATE POLICY "analytics: pod members can read"
ON analytics FOR SELECT
USING (
    pod_id IN (
        SELECT pod_id FROM pod_members
        WHERE user_id = auth.uid()::text
    )
);

-- Editors and admins can push analytics rows (owner agent publishes data).
CREATE POLICY "analytics: editor+ can insert"
ON analytics FOR INSERT
WITH CHECK (
    pod_id IN (
        SELECT pod_id FROM pod_members
        WHERE user_id = auth.uid()::text
          AND role IN ('admin', 'editor')
    )
);

-- Editors and admins can update analytics (e.g. refresh with latest numbers).
CREATE POLICY "analytics: editor+ can update"
ON analytics FOR UPDATE
USING (
    pod_id IN (
        SELECT pod_id FROM pod_members
        WHERE user_id = auth.uid()::text
          AND role IN ('admin', 'editor')
    )
);

-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  previews                                                               ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
-- signed_url rows are short-lived; any pod member can read preview links
-- for videos in their pod (used by the dashboard to show a quick preview).
CREATE POLICY "previews: pod members can read"
ON previews FOR SELECT
USING (
    pod_id IN (
        SELECT pod_id FROM pod_members
        WHERE user_id = auth.uid()::text
    )
);

-- Editors and admins can insert new signed-URL preview records.
CREATE POLICY "previews: editor+ can insert"
ON previews FOR INSERT
WITH CHECK (
    pod_id IN (
        SELECT pod_id FROM pod_members
        WHERE user_id = auth.uid()::text
          AND role IN ('admin', 'editor')
    )
);

-- Editors and admins can refresh a signed URL before it expires.
CREATE POLICY "previews: editor+ can update"
ON previews FOR UPDATE
USING (
    pod_id IN (
        SELECT pod_id FROM pod_members
        WHERE user_id = auth.uid()::text
          AND role IN ('admin', 'editor')
    )
);

-- Admins prune expired preview rows.
CREATE POLICY "previews: admin can delete"
ON previews FOR DELETE
USING (
    pod_id IN (
        SELECT pod_id FROM pod_members
        WHERE user_id = auth.uid()::text AND role = 'admin'
    )
);
