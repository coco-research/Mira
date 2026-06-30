const express = require('express');
const router = express.Router();
const storyboardLogStore = require('../services/storyboardLogStore');

router.get('/', (req, res) => {
  try {
    const logs = storyboardLogStore.getLogs();
    res.json({ logs });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/:id', (req, res) => {
  try {
    const log = storyboardLogStore.getLogById(req.params.id);
    if (!log) return res.status(404).json({ error: 'Log not found' });
    res.json({ log });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/:id', (req, res) => {
  try {
    storyboardLogStore.deleteLog(req.params.id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/', (req, res) => {
  try {
    storyboardLogStore.clearLogs();
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
