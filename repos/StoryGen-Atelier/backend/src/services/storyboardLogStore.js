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
  CREATE TABLE IF NOT EXISTS storyboard_logs (
    id TEXT PRIMARY KEY,
    createdAt TEXT NOT NULL,
    status TEXT NOT NULL,
    sentence TEXT,
    style TEXT,
    requestedShots INTEGER,
    generatedShots INTEGER,
    model TEXT,
    storyboard TEXT,
    errorMessage TEXT,
    duration INTEGER
  );
`);

const generateId = () => `story_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

const toLog = (row) => ({
  id: row.id,
  createdAt: row.createdAt,
  status: row.status,
  sentence: row.sentence,
  style: row.style,
  requestedShots: row.requestedShots,
  generatedShots: row.generatedShots,
  model: row.model,
  storyboard: JSON.parse(row.storyboard || '[]'),
  errorMessage: row.errorMessage,
  duration: row.duration,
});

exports.createLog = ({ sentence, requestedShots, style, model }) => {
  const id = generateId();
  const createdAt = new Date().toISOString();
  db.prepare(
    `INSERT INTO storyboard_logs (id, createdAt, status, sentence, style, requestedShots, model)
     VALUES (@id, @createdAt, @status, @sentence, @style, @requestedShots, @model)`
  ).run({
    id,
    createdAt,
    status: 'started',
    sentence,
    style,
    requestedShots,
    model,
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
  if (updates.storyboard !== undefined) {
    fields.push('storyboard = @storyboard');
    params.storyboard = JSON.stringify(updates.storyboard);
  }
  if (updates.generatedShots !== undefined) {
    fields.push('generatedShots = @generatedShots');
    params.generatedShots = updates.generatedShots;
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
    db.prepare(`UPDATE storyboard_logs SET ${fields.join(', ')} WHERE id = @id`).run(params);
  }
};

exports.getLogs = () => {
  const rows = db.prepare('SELECT * FROM storyboard_logs ORDER BY datetime(createdAt) DESC LIMIT 100').all();
  return rows.map(toLog);
};

exports.getLogById = (id) => {
  const row = db.prepare('SELECT * FROM storyboard_logs WHERE id = ?').get(id);
  return row ? toLog(row) : null;
};

exports.deleteLog = (id) => {
  db.prepare('DELETE FROM storyboard_logs WHERE id = ?').run(id);
};

exports.clearLogs = () => {
  db.prepare('DELETE FROM storyboard_logs').run();
};
