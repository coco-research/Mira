const path = require('path');
const Database = require('better-sqlite3');
const fs = require('fs');

const dataDir = path.join(__dirname, '../../data');
const dbPath = path.join(dataDir, 'gallery.db');

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS video_logs (
    id TEXT PRIMARY KEY,
    createdAt TEXT NOT NULL,
    status TEXT NOT NULL,
    storyboard TEXT,
    transitionPlans TEXT,
    clipResults TEXT,
    finalVideoUrl TEXT,
    errorMessage TEXT,
    duration INTEGER
  );
`);

const generateId = () => `log_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

const sanitizeStoryboard = (storyboard) =>
  (storyboard || []).map((shot) => ({
    shot: shot.shot,
    description: shot.description,
    prompt: shot.prompt,
    duration: shot.duration,
    heroSubject: shot.heroSubject,
    shotStory: shot.shotStory,
    // Deliberately drop imageUrl/base64 to keep payload small
  }));

const sanitizeTransitionPlans = (plans) =>
  (plans || []).map((plan) => ({
    index: plan.index,
    shotA: plan.shotA,
    shotB: plan.shotB,
    prompt: plan.prompt,
    duration: plan.duration,
    isClosing: plan.isClosing || false,
  }));

const sanitizeClipResults = (clips) =>
  (clips || []).map((clip) => ({
    index: clip.index,
    duration: clip.duration,
    prompt: clip.prompt,
    videoPath: clip.videoPath,
    provider: clip.provider,
  }));

const toLog = (row) => ({
  id: row.id,
  createdAt: row.createdAt,
  status: row.status,
  storyboard: sanitizeStoryboard(JSON.parse(row.storyboard || '[]')),
  transitionPlans: sanitizeTransitionPlans(JSON.parse(row.transitionPlans || '[]')),
  clipResults: sanitizeClipResults(JSON.parse(row.clipResults || '[]')),
  finalVideoUrl: row.finalVideoUrl,
  errorMessage: row.errorMessage,
  duration: row.duration,
});

exports.createLog = (storyboard) => {
  const id = generateId();
  const createdAt = new Date().toISOString();
  db.prepare(
    `INSERT INTO video_logs (id, createdAt, status, storyboard)
     VALUES (@id, @createdAt, @status, @storyboard)`
  ).run({
    id,
    createdAt,
    status: 'started',
    storyboard: JSON.stringify(storyboard),
  });
  return id;
};

exports.updateLog = (id, updates) => {
  const fields = [];
  const params = { id };
  
  if (updates.status !== undefined) {
    fields.push('status = @status');
    params.status = updates.status;
  }
  if (updates.transitionPlans !== undefined) {
    fields.push('transitionPlans = @transitionPlans');
    params.transitionPlans = JSON.stringify(updates.transitionPlans);
  }
  if (updates.clipResults !== undefined) {
    fields.push('clipResults = @clipResults');
    params.clipResults = JSON.stringify(updates.clipResults);
  }
  if (updates.finalVideoUrl !== undefined) {
    fields.push('finalVideoUrl = @finalVideoUrl');
    params.finalVideoUrl = updates.finalVideoUrl;
  }
  if (updates.errorMessage !== undefined) {
    fields.push('errorMessage = @errorMessage');
    params.errorMessage = updates.errorMessage;
  }
  if (updates.duration !== undefined) {
    fields.push('duration = @duration');
    params.duration = updates.duration;
  }
  
  if (fields.length > 0) {
    db.prepare(`UPDATE video_logs SET ${fields.join(', ')} WHERE id = @id`).run(params);
  }
};

exports.getLogs = () => {
  const rows = db.prepare('SELECT * FROM video_logs ORDER BY datetime(createdAt) DESC LIMIT 100').all();
  return rows.map(toLog);
};

exports.getLogById = (id) => {
  const row = db.prepare('SELECT * FROM video_logs WHERE id = ?').get(id);
  return row ? toLog(row) : null;
};

exports.deleteLog = (id) => {
  db.prepare('DELETE FROM video_logs WHERE id = ?').run(id);
};

exports.clearLogs = () => {
  db.prepare('DELETE FROM video_logs').run();
};
