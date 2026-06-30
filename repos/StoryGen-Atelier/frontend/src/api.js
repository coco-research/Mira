// StoryGenApp/frontend/src/api.js
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3005/api';

export const generateStoryboardApi = async (sentence, shotCount, style) => {
  try {
    const response = await fetch(`${API_BASE_URL}/storyboard/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ sentence, shotCount, style }),
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error || 'Something went wrong on the server.');
    }

    const data = await response.json();
    return data.storyboard;
  } catch (error) {
    console.error('API Error:', error);
    throw error;
  }
};

export const generateVideoApi = async (storyboard) => {
  try {
    const response = await fetch(`${API_BASE_URL}/storyboard/generate-video`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ storyboard }),
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error || 'Something went wrong on the server.');
    }

    const data = await response.json();
    return data.videoUrl;
  } catch (error) {
    console.error('API Error (Video):', error);
    throw error;
  }
};

// Gallery APIs
export const listGalleryApi = async () => {
  const response = await fetch(`${API_BASE_URL}/gallery`);
  if (!response.ok) throw new Error('Failed to load gallery');
  const data = await response.json();
  return data.stories || [];
};

export const saveGalleryApi = async (story) => {
  const response = await fetch(`${API_BASE_URL}/gallery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(story),
  });
  if (!response.ok) throw new Error('Failed to save story');
  const data = await response.json();
  return data.story;
};

export const deleteGalleryApi = async (id) => {
  const response = await fetch(`${API_BASE_URL}/gallery/${id}`, { method: 'DELETE' });
  if (!response.ok) throw new Error('Failed to delete story');
  const data = await response.json();
  return data.stories || [];
};

// Video Logs APIs
export const listVideoLogsApi = async () => {
  const response = await fetch(`${API_BASE_URL}/video-logs`);
  if (!response.ok) throw new Error('Failed to load video logs');
  const data = await response.json();
  return data.logs || [];
};

export const getVideoLogApi = async (id) => {
  const response = await fetch(`${API_BASE_URL}/video-logs/${id}`);
  if (!response.ok) throw new Error('Failed to load video log');
  const data = await response.json();
  return data.log;
};

export const deleteVideoLogApi = async (id) => {
  const response = await fetch(`${API_BASE_URL}/video-logs/${id}`, { method: 'DELETE' });
  if (!response.ok) throw new Error('Failed to delete video log');
  return true;
};

export const clearVideoLogsApi = async () => {
  const response = await fetch(`${API_BASE_URL}/video-logs`, { method: 'DELETE' });
  if (!response.ok) throw new Error('Failed to clear video logs');
  return true;
};

// Storyboard Logs APIs
export const listStoryboardLogsApi = async () => {
  const response = await fetch(`${API_BASE_URL}/storyboard-logs`);
  if (!response.ok) throw new Error('Failed to load storyboard logs');
  const data = await response.json();
  return data.logs || [];
};

export const getStoryboardLogApi = async (id) => {
  const response = await fetch(`${API_BASE_URL}/storyboard-logs/${id}`);
  if (!response.ok) throw new Error('Failed to load storyboard log');
  const data = await response.json();
  return data.log;
};

export const deleteStoryboardLogApi = async (id) => {
  const response = await fetch(`${API_BASE_URL}/storyboard-logs/${id}`, { method: 'DELETE' });
  if (!response.ok) throw new Error('Failed to delete storyboard log');
  return true;
};

export const clearStoryboardLogsApi = async () => {
  const response = await fetch(`${API_BASE_URL}/storyboard-logs`, { method: 'DELETE' });
  if (!response.ok) throw new Error('Failed to clear storyboard logs');
  return true;
};

export const regenerateShotImageApi = async (shot, style, referenceImageBase64, heroSubject, previousStyleHint) => {
  const response = await fetch(`${API_BASE_URL}/storyboard/regenerate-shot`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ shot, style, referenceImageBase64, heroSubject, previousStyleHint }),
  });
  if (!response.ok) {
    const errorData = await response.json();
    throw new Error(errorData.error || 'Failed to regenerate image');
  }
  const data = await response.json();
  return data.imageUrl;
};
