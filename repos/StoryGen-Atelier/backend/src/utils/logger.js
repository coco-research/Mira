// StoryGenApp/backend/src/utils/logger.js
const fs = require('fs');
const path = require('path');
const util = require('util');

const logPath = path.join(__dirname, '../../..', 'backend.log');

const log = (event, payload = {}) => {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${event} ${JSON.stringify(payload)}\n`;
  try {
    fs.appendFileSync(logPath, line, 'utf8');
  } catch (err) {
    // Fallback to console if file write fails
    console.error('Logger write failed', err);
  }
  console.log(`[${ts}][${event}]`, util.inspect(payload, { depth: null }));
};

module.exports = { log };
