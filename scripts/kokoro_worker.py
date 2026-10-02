#!/usr/bin/env python3
"""
JARVIS Kokoro-82M Persistent Low-Latency Worker

Protocol:
- Reads newline-delimited JSON requests from stdin:
  {"id": "req-1", "text": "Hello world", "voice": "bm_george", "speed": 1.0}
- Loads ONNX model and voice tensors ONCE at startup.
- Keeps model resident in memory across arbitrary requests.
- Writes newline-delimited JSON responses to stdout:
  {"id": "req-1", "success": true, "audioBase64": "...", "sampleRate": 24000, "durationSec": 0.85}
- Handles errors per-request without process termination.
"""

import sys
import os
import json
import base64
import io
import time

# Reconfigure stdout/stderr for line-buffered UTF-8 output
if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)
        sys.stderr.reconfigure(encoding="utf-8", line_buffering=True)
    except Exception:
        pass

def send_response(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()

def main():
    model_dir = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser("~/.jarvis/models/tts/kokoro")
    
    # Locate model and voices
    model_path = os.path.join(model_dir, "kokoro-v0_19.onnx")
    if not os.path.exists(model_path):
        model_path = os.path.join(model_dir, "kokoro-v1_0.onnx")
        
    voices_path = os.path.join(model_dir, "voices.bin")
    if not os.path.exists(voices_path):
        voices_path = os.path.join(model_dir, "voices.json")
        
    if not os.path.exists(model_path) or not os.path.exists(voices_path):
        send_response({
            "type": "init_error",
            "error": f"Model files missing in {model_dir}. Please run 'npm run tts:setup'."
        })
        sys.exit(1)

    try:
        import numpy as np
        import soundfile as sf
        from kokoro_onnx import Kokoro
        
        sys.stderr.write(f"[Kokoro Worker] Initializing Kokoro model from {model_path}...\n")
        kokoro = Kokoro(model_path, voices_path)
        sys.stderr.write("[Kokoro Worker] Model loaded successfully. Ready for synthesis requests.\n")
        
        # Signal ready to parent
        send_response({"type": "ready", "model": os.path.basename(model_path)})
    except Exception as e:
        sys.stderr.write(f"[Kokoro Worker Init Error] {str(e)}\n")
        send_response({"type": "init_error", "error": str(e)})
        sys.exit(1)

    # Persistent request loop
    while True:
        try:
            line = sys.stdin.readline()
            if not line:
                # EOF reached, parent closed stdin
                break
                
            line = line.strip()
            if not line:
                continue
                
            try:
                req = json.loads(line)
            except Exception as pe:
                send_response({"id": "unknown", "success": False, "error": f"Invalid JSON input: {str(pe)}"})
                continue
                
            req_id = req.get("id", f"synth_{int(time.time() * 1000)}")
            
            # Check shutdown command
            if req.get("type") == "shutdown":
                send_response({"id": req_id, "success": True, "type": "shutdown_ack"})
                break

            text = req.get("text", "").strip()
            if not text:
                send_response({"id": req_id, "success": False, "error": "Empty text provided."})
                continue

            voice = req.get("voice", "bm_george")
            speed = float(req.get("speed", 1.0))
            lang = req.get("lang", "en-gb" if voice.startswith("b") else "en-us")

            try:
                t0 = time.time()
                samples, sample_rate = kokoro.create(text, voice=voice, speed=speed, lang=lang)
                latency_ms = (time.time() - t0) * 1000
                
                buffer = io.BytesIO()
                sf.write(buffer, samples, sample_rate, format="WAV")
                wav_bytes = buffer.getvalue()
                
                b64 = base64.b64encode(wav_bytes).decode("ascii")
                duration = len(samples) / float(sample_rate)

                send_response({
                    "id": req_id,
                    "success": True,
                    "sampleRate": sample_rate,
                    "durationSec": duration,
                    "latencyMs": latency_ms,
                    "audioBase64": b64
                })
            except Exception as se:
                sys.stderr.write(f"[Kokoro Worker Synth Error] req={req_id}: {str(se)}\n")
                send_response({
                    "id": req_id,
                    "success": False,
                    "error": str(se)
                })

        except KeyboardInterrupt:
            break
        except Exception as e:
            sys.stderr.write(f"[Kokoro Worker Loop Error] {str(e)}\n")

    sys.stderr.write("[Kokoro Worker] Exiting worker process cleanly.\n")

if __name__ == "__main__":
    main()
