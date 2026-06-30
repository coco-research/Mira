"""
Persistent faster-whisper server for Locally Uncensored.
Communicates via stdin/stdout with line-based JSON protocol.

Input (one JSON per line on stdin):
  {"action": "transcribe", "path": "/tmp/audio.wav"}
  {"action": "status"}
  {"action": "quit"}

Output (one JSON per line on stdout):
  {"status": "ready", "backend": "faster-whisper"}
  {"transcript": "hello world", "language": "en"}
  {"error": "..."}
"""

import sys
import json
import os

def main():
    # Unbuffered stdout for real-time communication with Node.js
    sys.stdout.reconfigure(line_buffering=True)
    sys.stderr.reconfigure(line_buffering=True)

    print("Loading faster-whisper model...", file=sys.stderr, flush=True)

    try:
        from faster_whisper import WhisperModel
    except ImportError:
        respond({"status": "error", "error": "faster-whisper not installed"})
        sys.exit(1)

    # Load model once — this is the slow part (~170s on some systems)
    try:
        model = WhisperModel("base", device="cpu", compute_type="int8")
        print("Model loaded, ready for transcription.", file=sys.stderr, flush=True)
    except Exception as e:
        respond({"status": "error", "error": f"Model load failed: {e}"})
        sys.exit(1)

    # Signal readiness
    respond({"status": "ready", "backend": "faster-whisper"})

    # Main loop: read commands from stdin
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            cmd = json.loads(line)
        except json.JSONDecodeError:
            respond({"error": "Invalid JSON"})
            continue

        action = cmd.get("action", "")

        if action == "status":
            respond({"status": "ready", "backend": "faster-whisper"})

        elif action == "transcribe":
            audio_path = cmd.get("path", "")
            if not audio_path or not os.path.exists(audio_path):
                respond({"error": f"File not found: {audio_path}", "transcript": ""})
                continue

            try:
                segments, info = model.transcribe(audio_path)
                text = " ".join([s.text for s in segments]).strip()
                respond({"transcript": text, "language": info.language})
            except Exception as e:
                respond({"error": str(e), "transcript": ""})

        elif action == "quit":
            respond({"status": "stopped"})
            break

        else:
            respond({"error": f"Unknown action: {action}"})


def respond(data: dict):
    """Write a JSON response line to stdout."""
    print(json.dumps(data), flush=True)


if __name__ == "__main__":
    main()
