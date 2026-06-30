const express = require('express');
console.log("Starting app.js...");
const dotenv = require('dotenv');
const path = require('path');
dotenv.config();

const cors = require('cors');

// Route outbound HTTP(S) through a proxy if the environment provides one.
const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy ||
  process.env.HTTP_PROXY || process.env.http_proxy ||
  process.env.ALL_PROXY || process.env.all_proxy;
if (proxyUrl) {
  const { ProxyAgent, setGlobalDispatcher } = require('undici');
  setGlobalDispatcher(new ProxyAgent(proxyUrl));
  console.log('Using proxy for outbound HTTP(S) requests.');
}

const storyboardRoutes = require('../src/routes/storyboardRoutes');
const galleryRoutes = require('../src/routes/galleryRoutes');
const videoLogRoutes = require('../src/routes/videoLogRoutes');
const storyboardLogRoutes = require('../src/routes/storyboardLogRoutes');

const app = express();
const port = process.env.PORT || 3005;

app.use(cors()); // Enable CORS for all routes
app.use(express.json({ limit: '20mb' })); // For parsing application/json (allow bigger payload for base64 images)
app.use('/videos', express.static(path.join(__dirname, '../data/videos')));

// Use storyboard routes
app.use('/api/storyboard', storyboardRoutes);
app.use('/api/gallery', galleryRoutes);
app.use('/api/video-logs', videoLogRoutes);
app.use('/api/storyboard-logs', storyboardLogRoutes);

app.get('/', (req, res) => {
  res.send('StoryGenApp Backend is running!');
});

app.listen(port, () => {
  console.log(`StoryGenApp Backend listening at http://localhost:${port}`);
});
