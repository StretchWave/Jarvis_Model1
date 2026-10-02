#!/usr/bin/env python3
"""
JARVIS Kokoro-82M Local Neural Voice Installer & Validator
- Sets up an isolated virtual environment in ~/.jarvis/models/tts/kokoro/venv
- Installs kokoro-onnx, soundfile, and onnxruntime
- Downloads official Kokoro-82M ONNX model and British voice profiles (bm_george, bm_lewis, bf_emma)
- Creates the synthesize.py runner
- Performs a validation synthesis test
- Never pollutes the global Python installation
"""

import os
import sys
import subprocess
import shutil
import json
import base64
import urllib.request
from pathlib import Path

# Fix Windows console charmap encoding for Unicode characters
if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

DEFAULT_MODEL_DIR = Path.home() / ".jarvis" / "models" / "tts" / "kokoro"

SYNTHESIZE_SCRIPT = '''#!/usr/bin/env python3
import sys
import os
import json
import base64
import io

try:
    import numpy as np
    import soundfile as sf
    from kokoro_onnx import Kokoro
except ImportError as e:
    print(json.dumps({"error": f"Missing kokoro dependency: {str(e)}"}))
    sys.exit(1)

def run():
    payload_str = ""
    if len(sys.argv) >= 3 and sys.argv[1] == "--b64":
        payload_str = base64.b64decode(sys.argv[2]).decode("utf-8")
    elif len(sys.argv) >= 3 and sys.argv[1] == "--json":
        payload_str = sys.argv[2]
    elif not sys.stdin.isatty():
        payload_str = sys.stdin.read()
    else:
        print(json.dumps({"error": "Invalid arguments. Usage: synthesize.py --b64 <base64> or --json <payload>"}))
        sys.exit(1)
        
    try:
        data = json.loads(payload_str)
        text = data.get("text", "").strip()
        voice_name = data.get("voice", "bm_george")
        speed = float(data.get("speed", 1.0))
        model_dir = data.get("model_dir", "")
        
        model_path = os.path.join(model_dir, "kokoro-v0_19.onnx")
        voices_path = os.path.join(model_dir, "voices.bin")
        if not os.path.exists(voices_path):
            voices_path = os.path.join(model_dir, "voices.json")
        
        if not os.path.exists(model_path):
            print(json.dumps({"error": f"Model file missing at {model_path}"}))
            sys.exit(1)
            
        kokoro = Kokoro(model_path, voices_path)
        samples, sample_rate = kokoro.create(text, voice=voice_name, speed=speed, lang="en-gb")
        
        buffer = io.BytesIO()
        sf.write(buffer, samples, sample_rate, format="WAV")
        wav_bytes = buffer.getvalue()
        
        b64 = base64.b64encode(wav_bytes).decode("ascii")
        duration = len(samples) / float(sample_rate)
        
        print(json.dumps({
            "success": True,
            "sampleRate": sample_rate,
            "durationSec": duration,
            "audioBase64": b64
        }))
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)

if __name__ == "__main__":
    run()
'''

def download_file(url: str, dest_path: Path, description: str):
    print(f"\n▶ Downloading {description}...")
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"})
    with urllib.request.urlopen(req) as response, open(dest_path, "wb") as out_file:
        total_size = int(response.info().get("Content-Length", 0))
        downloaded = 0
        block_size = 1024 * 1024  # 1MB
        while True:
            chunk = response.read(block_size)
            if not chunk:
                break
            downloaded += len(chunk)
            out_file.write(chunk)
            if total_size > 0:
                percent = downloaded * 100 / total_size
                mb_down = downloaded / (1024 * 1024)
                mb_total = total_size / (1024 * 1024)
                print(f"\r  Progress: {percent:5.1f}% ({mb_down:6.1f} MB / {mb_total:6.1f} MB)", end="", flush=True)
        print()
    print(f"✔ Completed download: {dest_path.name}")

def main():
    print("=" * 65)
    print("       JARVIS Kokoro-82M Local Neural Voice Setup              ")
    print("=" * 65)
    print(f"Target directory: {DEFAULT_MODEL_DIR}\n")

    os.makedirs(DEFAULT_MODEL_DIR, exist_ok=True)
    venv_dir = DEFAULT_MODEL_DIR / "venv"

    # 1. Create Virtual Environment
    if not venv_dir.exists():
        print("▶ Creating isolated virtual environment...")
        subprocess.check_call([sys.executable, "-m", "venv", str(venv_dir)])
        print("✔ Virtual environment created.")
    else:
        print("✔ Existing virtual environment detected.")

    # Locate Python inside venv
    if sys.platform == "win32":
        venv_python = venv_dir / "Scripts" / "python.exe"
    else:
        venv_python = venv_dir / "bin" / "python"

    # 2. Install Dependencies into venv using python -m pip to avoid Windows binary lock
    print("\n▶ Installing inference dependencies (kokoro-onnx, soundfile, onnxruntime)...")
    try:
        subprocess.run([str(venv_python), "-m", "pip", "install", "--upgrade", "pip"], check=False)
        subprocess.check_call([str(venv_python), "-m", "pip", "install", "kokoro-onnx", "soundfile", "numpy", "onnxruntime"])
        print("✔ Dependencies successfully installed into isolated environment.")
    except Exception as e:
        print(f"✖ Failed installing dependencies: {e}")
        return 1

    # 3. Create synthesize.py runner
    synth_file = DEFAULT_MODEL_DIR / "synthesize.py"
    with open(synth_file, "w", encoding="utf-8") as f:
        f.write(SYNTHESIZE_SCRIPT)
    print("✔ Generated synthesize.py execution script.")

    # 4. Download Model & Voice Artifacts
    onnx_url = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files/kokoro-v0_19.onnx"
    voices_bin_url = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files/voices.bin"
    
    onnx_file = DEFAULT_MODEL_DIR / "kokoro-v0_19.onnx"
    voices_bin_file = DEFAULT_MODEL_DIR / "voices.bin"

    if not onnx_file.exists():
        try:
            download_file(onnx_url, onnx_file, "Kokoro-82M ONNX model (~311MB)")
        except Exception as e:
            print(f"✖ Failed to download model: {e}")
            print("  You can manually place kokoro-v0_19.onnx inside:", DEFAULT_MODEL_DIR)
    else:
        print("✔ Model file kokoro-v0_19.onnx already exists.")

    if not voices_bin_file.exists():
        try:
            download_file(voices_bin_url, voices_bin_file, "Voices binary dictionary (~5.7MB)")
        except Exception as e:
            print(f"✖ Failed to download voices.bin: {e}")
    else:
        print("✔ voices.bin already exists.")

    # 5. Validation Test Synthesis
    if onnx_file.exists() and voices_bin_file.exists():
        print("\n▶ Running validation test synthesis...")
        test_payload = json.dumps({
            "text": "Good day, Sir. Neural voice synthesis initialized.",
            "voice": "bm_george",
            "speed": 1.0,
            "model_dir": str(DEFAULT_MODEL_DIR)
        })
        b64_payload = base64.b64encode(test_payload.encode("utf-8")).decode("ascii")
        try:
            res = subprocess.check_output([str(venv_python), str(synth_file), "--b64", b64_payload], text=True)
            data = json.loads(res)
            if data.get("success"):
                print(f"✔ Synthesis verification passed: generated {data.get('durationSec', 0):.2f}s of 24kHz audio.")
            else:
                print(f"✖ Verification returned error: {data.get('error')}")
        except Exception as e:
            print(f"✖ Verification failed: {e}")

    print("\n" + "=" * 65)
    print("      JARVIS Neural Voice installation check complete!        ")
    print("=" * 65 + "\n")
    return 0

if __name__ == "__main__":
    sys.exit(main())
