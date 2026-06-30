const crypto = require('crypto');
const galleryStore = require('../services/galleryStore');

exports.listStories = async (_req, res) => {
  try {
    const stories = await galleryStore.getStories();
    res.json({ stories });
  } catch (err) {
    console.error('Error listing stories:', err);
    res.status(500).json({ error: 'Failed to load gallery' });
  }
};

exports.saveStory = async (req, res) => {
  try {
    const { id, title, createdAt, shotCount, storyboard, style, videos } = req.body || {};
    if (!title || !Array.isArray(storyboard) || storyboard.length === 0) {
      return res.status(400).json({ error: 'title and storyboard are required' });
    }
    const story = {
      id: id || crypto.randomUUID(),
      title,
      createdAt: createdAt || new Date().toISOString(),
      shotCount: shotCount || storyboard.length,
      storyboard,
      style: style || null,
      videos: videos || [],
    };
    await galleryStore.saveStory(story);
    res.json({ story });
  } catch (err) {
    console.error('Error saving story:', err);
    res.status(500).json({ error: 'Failed to save story' });
  }
};

exports.deleteStory = async (req, res) => {
  try {
    const { id } = req.params;
    if (!id) return res.status(400).json({ error: 'id is required' });
    const stories = await galleryStore.deleteStory(id);
    res.json({ stories });
  } catch (err) {
    console.error('Error deleting story:', err);
    res.status(500).json({ error: 'Failed to delete story' });
  }
};
