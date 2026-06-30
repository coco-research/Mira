-- Project Mira — Supabase coordination tables (Phase 8)
-- SECURITY INVARIANT: NO column for API keys, .env values, raw media, or
-- rendered video paths ever belongs in this schema.  Only coordination
-- metadata, capacity counters, signed preview URLs, and queue items are
-- stored here.  Secrets stay on each member's local machine (SECURITY.md §2).

-- Enable pgcrypto so gen_random_uuid() works on PG < 13 without pgcrypto
-- (PG 13+ has it built in; this is a no-op on modern Supabase).
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  pods — tenant root; one row per collaborative pod                      ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
CREATE TABLE IF NOT EXISTS pods (
    id              TEXT        PRIMARY KEY,          -- e.g. "pod_alpha"
    name            TEXT        NOT NULL,
    owner_user_id   TEXT        NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    -- ASSERTION: no api_key, secret, token, .env value column here or ever
);

-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  pod_members — role roster; drives all RLS membership checks            ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
-- role: admin | editor | viewer
CREATE TABLE IF NOT EXISTS pod_members (
    pod_id      TEXT        NOT NULL REFERENCES pods(id) ON DELETE CASCADE,
    user_id     TEXT        NOT NULL,
    role        TEXT        NOT NULL DEFAULT 'editor'
                    CHECK (role IN ('admin', 'editor', 'viewer')),
    joined_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (pod_id, user_id)
);

-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  channels — channel config (no keys); scoped to a pod                  ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
-- config_json: language, aspect, lane, trust, length_band, platforms, etc.
-- ASSERTION: config_json MUST NOT contain api_key, token, or any .env value.
CREATE TABLE IF NOT EXISTS channels (
    id              TEXT        PRIMARY KEY,          -- e.g. "chn_aitools"
    pod_id          TEXT        NOT NULL REFERENCES pods(id) ON DELETE CASCADE,
    owner_user_id   TEXT        NOT NULL,
    name            TEXT        NOT NULL,
    config_json     JSONB       NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  topics — idea / queue items; scoped to channel + pod                  ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
-- pod_id is denormalized from channels so RLS can filter by pod_id directly
-- without an extra join, keeping policy expressions simple and fast.
CREATE TABLE IF NOT EXISTS topics (
    id              TEXT        PRIMARY KEY,          -- e.g. "top_5free"
    channel_id      TEXT        NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    pod_id          TEXT        NOT NULL,             -- denormalized for RLS
    title           TEXT        NOT NULL,
    status          TEXT        NOT NULL DEFAULT 'queued'
                        CHECK (status IN ('idea', 'queued')),
    scheduled_for   TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  jobs — dispatch queue; SINGLE-ASSIGNMENT enforced by DB                ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
-- Single-assignment contract (SECURITY.md §4):
--   • UNIQUE (video_id): one job record per video — prevents duplicate dispatch.
--   • Claiming is done via UPDATE … WHERE assigned_user_id IS NULL (atomic).
--     Two concurrent PATCH calls race at the DB level; only the first wins.
--   • Once assigned_user_id is set it is immutable (enforced by RLS policy
--     and application logic; a DB trigger may be added at hardening Phase 9).
-- pod_id is denormalized for efficient RLS (same reason as topics above).
CREATE TABLE IF NOT EXISTS jobs (
    id                  TEXT        PRIMARY KEY,      -- e.g. "job_001"
    video_id            TEXT        NOT NULL,
    channel_id          TEXT        REFERENCES channels(id),
    pod_id              TEXT        NOT NULL,         -- denormalized for RLS
    assigned_user_id    TEXT,                         -- NULL = unclaimed
    state               TEXT        NOT NULL DEFAULT 'pending',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Single-assignment unique constraint: one job slot per video
    CONSTRAINT jobs_video_unique UNIQUE (video_id)
);

-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  quota_ledger — capacity counters only; NO secrets whatsoever           ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
-- The swarm router reads this table to pick the member with free headroom
-- and to back off providers that 429'd.  It stores ONLY counts — never keys.
-- window codes: rpm (requests/min) | rpd (requests/day)
--               tpm (tokens/min)   | tpd (tokens/day)
-- ASSERTION: no api_key, credential, or secret column here or ever.
CREATE TABLE IF NOT EXISTS quota_ledger (
    pod_id          TEXT        NOT NULL,
    user_id         TEXT        NOT NULL,
    provider        TEXT        NOT NULL,
    window          TEXT        NOT NULL
                        CHECK (window IN ('rpm', 'rpd', 'tpm', 'tpd')),
    used            INTEGER     NOT NULL DEFAULT 0,
    "limit"         INTEGER     NOT NULL DEFAULT 0,  -- 0 = unlimited
    window_start    TIMESTAMPTZ,
    healthy         BOOLEAN     NOT NULL DEFAULT true,
    last_429_at     TIMESTAMPTZ,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (pod_id, user_id, provider, window)
);

-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  analytics — aggregated engagement metrics; pulled by owner agent       ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
-- pod_id denormalized for RLS (no join through videos/topics needed).
CREATE TABLE IF NOT EXISTS analytics (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    video_id    TEXT        NOT NULL,
    pod_id      TEXT        NOT NULL,             -- denormalized for RLS
    views       INTEGER     NOT NULL DEFAULT 0,
    retention   NUMERIC(5, 2),                    -- percentage 0.00–100.00
    ts          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  previews — short-lived signed URLs; NO raw video or media bytes        ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
-- signed_url: a temporary URL to a rendered preview (e.g. Supabase Storage
-- signed link); expires after expires_at and should be pruned by a cron.
-- pod_id denormalized for RLS.
-- ASSERTION: no raw video path, no API key, no secret in any column.
CREATE TABLE IF NOT EXISTS previews (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    video_id    TEXT        NOT NULL,
    pod_id      TEXT        NOT NULL,             -- denormalized for RLS
    signed_url  TEXT        NOT NULL,             -- short-lived signed link only
    expires_at  TIMESTAMPTZ NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
