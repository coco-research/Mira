const express = require('express');
const { listStories, saveStory, deleteStory } = require('../controllers/galleryController');

const router = express.Router();

router.get('/', listStories);
router.post('/', saveStory);
router.delete('/:id', deleteStory);

module.exports = router;
