import pg from 'pg';

const SCHEMA_SQL = `
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS stories (
  id                    BIGSERIAL PRIMARY KEY,
  story_uuid            UUID NOT NULL DEFAULT gen_random_uuid(),
  reporter_external_id  INTEGER NOT NULL,
  reporter_uuid         UUID NOT NULL,
  source_type           VARCHAR(32) NOT NULL DEFAULT 'upload',
  source_upload_id      BIGINT,
  title                 TEXT NOT NULL,
  location              TEXT,
  language              VARCHAR(16) NOT NULL DEFAULT 'as',
  status                VARCHAR(32) NOT NULL DEFAULT 'uploaded',
  file_url              TEXT NOT NULL,
  original_filename     TEXT,
  mime_type             VARCHAR(128),
  file_size             BIGINT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_stories_source_upload
  ON stories (source_upload_id) WHERE source_upload_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_stories_status_created
  ON stories (status, created_at DESC);

CREATE TABLE IF NOT EXISTS story_assets (
  id               BIGSERIAL PRIMARY KEY,
  story_id         BIGINT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  asset_type       VARCHAR(32) NOT NULL,
  file_path        TEXT NOT NULL,
  mime_type        VARCHAR(128),
  metadata         JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_story_assets_story ON story_assets (story_id, asset_type, created_at DESC);

CREATE TABLE IF NOT EXISTS processing_jobs (
  id               BIGSERIAL PRIMARY KEY,
  story_id         BIGINT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  job_type         VARCHAR(64) NOT NULL,
  status           VARCHAR(16) NOT NULL DEFAULT 'queued',
  attempt_count    INTEGER NOT NULL DEFAULT 0,
  max_attempts     INTEGER NOT NULL DEFAULT 3,
  payload          JSONB NOT NULL DEFAULT '{}'::jsonb,
  error_log        TEXT,
  available_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at       TIMESTAMPTZ,
  completed_at     TIMESTAMPTZ,
  heartbeat_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_jobs_queue ON processing_jobs (status, available_at, created_at);

CREATE TABLE IF NOT EXISTS transcript_segments (
  id               BIGSERIAL PRIMARY KEY,
  story_id         BIGINT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  start_seconds    NUMERIC(10,2) NOT NULL,
  end_seconds      NUMERIC(10,2) NOT NULL,
  text             TEXT NOT NULL,
  confidence       NUMERIC(5,4),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS generated_clips (
  id               BIGSERIAL PRIMARY KEY,
  story_id         BIGINT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  preset           VARCHAR(32) NOT NULL,
  title            TEXT NOT NULL,
  start_seconds    NUMERIC(10,2) NOT NULL DEFAULT 0,
  end_seconds      NUMERIC(10,2) NOT NULL DEFAULT 0,
  status           VARCHAR(16) NOT NULL DEFAULT 'generated',
  review_note      TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS clip_reviews (
  id               BIGSERIAL PRIMARY KEY,
  story_id         BIGINT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  clip_id          BIGINT NOT NULL REFERENCES generated_clips(id) ON DELETE CASCADE,
  reviewer_role    VARCHAR(16) NOT NULL,
  reviewer_id      TEXT,
  action           VARCHAR(16) NOT NULL,
  note             TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS job_events (
  id               BIGSERIAL PRIMARY KEY,
  story_id         BIGINT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  job_id           BIGINT REFERENCES processing_jobs(id) ON DELETE CASCADE,
  event_type       VARCHAR(32) NOT NULL,
  message          TEXT,
  payload          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

export async function ensureDatabaseAndSchema() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(SCHEMA_SQL);
  } finally {
    await client.end();
  }
}
