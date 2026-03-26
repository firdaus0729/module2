import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import jwt from 'jsonwebtoken';
import { v5 as uuidv5 } from 'uuid';
import { ensureDatabaseAndSchema } from './ensureDb.js';
import { query } from './db.js';
import { verifyWebhookSignature } from './webhookAuth.js';
import { startWorker } from './worker.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const webDir = path.resolve(__dirname, '..', 'web');

const app = express();
const PORT = Number(process.env.PORT || 4100);
const JWT_SECRET = process.env.JWT_SECRET || '';
const REPORTER_NS = '4fa39f9d-f7c6-4bf8-98dc-cf393f84e6f6';

app.use(cors({ origin: true, credentials: true }));

app.get('/health', (_req, res) => res.json({ ok: true }));

app.use('/web', express.static(webDir));
app.get('/', (_req, res) => res.sendFile(path.join(webDir, 'index.html')));

function auth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    req.role = decoded?.role === 'admin' ? 'admin' : (decoded?.role === 'editor' ? 'editor' : 'reporter');
    return next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

function adminOnly(req, res, next) {
  if (req.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  return next();
}

app.use('/api/webhooks', express.raw({ type: 'application/json', limit: '5mb' }));

async function handleWebhook(req, res, sourceType) {
  const signature = req.headers['x-webhook-signature'];
  const rawBody = req.body instanceof Buffer ? req.body : Buffer.from([]);
  if (!verifyWebhookSignature(rawBody, signature)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }
  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return res.status(400).json({ error: 'Invalid JSON payload' });
  }

  const reporterId = Number(payload.reporter_id);
  const fileUrl = String(payload.file_url || '').trim();
  const title = String(payload.title || '').trim();
  if (!reporterId || !fileUrl || !title) {
    return res.status(400).json({ error: 'reporter_id, file_url and title are required' });
  }

  try {
    const reporterUuid = uuidv5(`reporter:${reporterId}`, REPORTER_NS);
    const insert = await query(
      `INSERT INTO stories
        (reporter_external_id, reporter_uuid, source_type, source_upload_id, title, location, language, status, file_url, original_filename, mime_type, file_size)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'uploaded', $8, $9, $10, $11)
       ON CONFLICT (source_upload_id) WHERE source_upload_id IS NOT NULL
       DO UPDATE SET updated_at = NOW()
       RETURNING id, story_uuid`,
      [
        reporterId,
        reporterUuid,
        sourceType,
        payload.upload_id || null,
        title,
        payload.location || null,
        payload.language || 'as',
        fileUrl,
        payload.original_name || payload.filename || null,
        payload.mime_type || 'application/octet-stream',
        payload.file_size || null,
      ]
    );
    const story = insert.rows[0];

    await query(
      `INSERT INTO processing_jobs (story_id, job_type, status, payload, available_at)
       VALUES ($1, 'ingest_download', 'queued', $2::jsonb, NOW())`,
      [story.id, JSON.stringify({ source_type: sourceType })]
    );

    return res.status(202).json({
      status: 'accepted',
      story_id: story.story_uuid,
      message: 'Story created and processing pipeline enqueued',
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

app.post('/api/webhooks/upload-complete', (req, res) => handleWebhook(req, res, 'upload'));
app.post('/api/webhooks/live-complete', (req, res) => handleWebhook(req, res, 'live_completion'));

app.use(express.json());

app.get('/api/stories', auth, async (req, res) => {
  try {
    const status = req.query.status ? String(req.query.status) : null;
    const sql = `
      SELECT s.id, s.story_uuid, s.reporter_external_id, s.source_type, s.title, s.location, s.language,
             s.status, s.file_url, s.created_at, s.updated_at,
             (SELECT COUNT(*)::int FROM processing_jobs j WHERE j.story_id = s.id AND j.status IN ('queued','retrying','running')) AS pending_jobs,
             (SELECT COUNT(*)::int FROM generated_clips c WHERE c.story_id = s.id) AS clip_count
      FROM stories s
      WHERE ($1::text IS NULL OR s.status = $1)
      ORDER BY s.created_at DESC
      LIMIT 200`;
    const { rows } = await query(sql, [status]);
    return res.json(rows);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

app.get('/api/stories/:id', auth, async (req, res) => {
  try {
    const id = req.params.id;
    const storyQ = await query(
      `SELECT * FROM stories WHERE story_uuid::text = $1 OR id::text = $1 LIMIT 1`,
      [id]
    );
    const story = storyQ.rows[0];
    if (!story) return res.status(404).json({ error: 'Story not found' });

    const [assets, jobs, clips, transcript, events, reviews] = await Promise.all([
      query(`SELECT * FROM story_assets WHERE story_id = $1 ORDER BY created_at DESC`, [story.id]),
      query(`SELECT * FROM processing_jobs WHERE story_id = $1 ORDER BY created_at DESC`, [story.id]),
      query(`SELECT * FROM generated_clips WHERE story_id = $1 ORDER BY created_at DESC`, [story.id]),
      query(`SELECT * FROM transcript_segments WHERE story_id = $1 ORDER BY start_seconds ASC`, [story.id]),
      query(`SELECT * FROM job_events WHERE story_id = $1 ORDER BY created_at DESC LIMIT 200`, [story.id]),
      query(`SELECT * FROM clip_reviews WHERE story_id = $1 ORDER BY created_at DESC`, [story.id]),
    ]);
    return res.json({
      story,
      assets: assets.rows,
      jobs: jobs.rows,
      clips: clips.rows,
      transcript_segments: transcript.rows,
      job_events: events.rows,
      clip_reviews: reviews.rows,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

app.post('/api/stories/:id/retry-job', auth, adminOnly, async (req, res) => {
  try {
    const jobId = Number(req.body?.job_id);
    if (!jobId) return res.status(400).json({ error: 'job_id required' });
    const { rows } = await query(
      `UPDATE processing_jobs
       SET status = 'queued', error_log = NULL, available_at = NOW(), updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [jobId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Job not found' });
    return res.json(rows[0]);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

async function reviewClip(req, res, action) {
  try {
    const clipId = Number(req.body?.clip_id);
    const note = req.body?.note || null;
    if (!clipId) return res.status(400).json({ error: 'clip_id required' });
    const upd = await query(
      `UPDATE generated_clips
       SET status = $2, review_note = $3, updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [clipId, action === 'approve' ? 'approved' : 'rejected', note]
    );
    const clip = upd.rows[0];
    if (!clip) return res.status(404).json({ error: 'Clip not found' });
    await query(
      `INSERT INTO clip_reviews (story_id, clip_id, reviewer_role, reviewer_id, action, note)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [clip.story_id, clip.id, req.role, String(req.user?.id || ''), action, note]
    );
    return res.json(clip);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

app.post('/api/stories/:id/approve-clip', auth, (req, res) => reviewClip(req, res, 'approve'));
app.post('/api/stories/:id/reject-clip', auth, (req, res) => reviewClip(req, res, 'reject'));

app.get('/api/jobs/queue-health', auth, adminOnly, async (_req, res) => {
  try {
    const [jobs, stories] = await Promise.all([
      query(`SELECT status, COUNT(*)::int AS count FROM processing_jobs GROUP BY status ORDER BY status`),
      query(`SELECT status, COUNT(*)::int AS count FROM stories GROUP BY status ORDER BY status`),
    ]);
    return res.json({
      jobs: jobs.rows,
      stories: stories.rows,
      timestamp: new Date().toISOString(),
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

async function start() {
  await ensureDatabaseAndSchema();
  startWorker();
  app.listen(PORT, () => {
    console.log(`Module 2 listening on http://localhost:${PORT}`);
  });
}

start().catch((e) => {
  console.error('Startup failed:', e.message);
  process.exit(1);
});
