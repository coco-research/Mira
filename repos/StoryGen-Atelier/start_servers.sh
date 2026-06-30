#!/bin/bash
# Start StoryGenApp backend and frontend (run from StoryGenApp directory)

cd "$(dirname "$0")"
echo "Starting StoryGenApp on Ports 3005 (Backend) and 5180 (Frontend)..."

cd backend
nohup npm start > ../backend.log 2>&1 &
echo "Backend started (PID $!)."

cd ../frontend
nohup npm run dev > ../frontend.log 2>&1 &
echo "Frontend started (PID $!)."

echo "Servers are running in background. Logs: backend.log / frontend.log"
echo "Access the app at: http://localhost:5180"
