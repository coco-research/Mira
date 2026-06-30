#!/bin/bash
# Stop StoryGenApp backend and frontend (run from StoryGenApp directory)

echo "Stopping StoryGenApp servers..."

# Backend on 3005
lsof -ti :3005 | xargs kill -9 2>/dev/null

# Frontend on 5180
lsof -ti :5180 | xargs kill -9 2>/dev/null

echo "✅ Servers stopped successfully."
