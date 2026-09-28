"""Generate notebooks/HustlClip_Kaggle.ipynb from readable Python source.

Editing JSON notebooks by hand is error-prone and diffs badly, so the cells
live here as plain strings. Run ``python notebooks/build_notebook.py`` after
changing them; CI-free and dependency-free (no nbformat needed).
"""

from __future__ import annotations

import json
from pathlib import Path

REPO = "https://github.com/RehanKanjiyani/HustlClip"

INTRO = f"""# HustlClip — turn your VOD into 10 Shorts (free GPU)

This notebook runs [HustlClip]({REPO}) on Kaggle's free GPU, driven entirely from
your phone's browser. You get **10 finished vertical clips** (reframed, captioned,
loudness-normalised MP4s) and a zip to download.

**Before the first run** (full phone walkthrough: `docs/MOBILE.md` in the repo):

1. In the notebook's settings: **Accelerator → GPU** (T4 or P100) and **Internet → On**.
   Both need a phone-verified Kaggle account.
2. **Add-ons → Secrets**: add `NVIDIA_API_KEY` (free at build.nvidia.com) and switch it
   on for this notebook. Optional: `ANTHROPIC_API_KEY`, `TYPESAFE_API_KEY`.
3. Give it a video: paste a link into `VIDEO_URL` below, **or** leave it empty and add
   your video file as an input (**Add Input → Upload**).

Then **Run all**. The first run installs everything (a few minutes); the clips appear
in step 5.
"""

SETTINGS = """# 1 · Settings — edit these, then Run all
VIDEO_URL = ""            # a public video link; leave "" to use a video added with Add Input
CLIPS = 10                # how many clips to make
CAPTION_STYLE = "bold_pop"   # bold_pop | karaoke_fill | clean_lower | boxed
TRANSCRIPTION = "large-v3"   # large-v3 (best on GPU) | medium | small (fastest)
DYNAMIC_LAYOUTS = False   # let AI switch between following the speaker and the whole frame
BRANCH = "main"           # which version of HustlClip to use
"""

INSTALL = f"""# 2 · Install HustlClip (first run: a few minutes; later runs reuse it)
import os, shutil, subprocess, sys, tarfile, urllib.request
from pathlib import Path

WORK = Path("/kaggle/working") if Path("/kaggle/working").exists() else Path.cwd()
BASE = Path("/tmp/hustlclip")
CODE = BASE / "HustlClip"
BASE.mkdir(parents=True, exist_ok=True)

def sh(command, check=True):
    print("$", command, flush=True)
    return subprocess.run(command, shell=True, check=check)

if not shutil.which("uv"):
    sh(f"{{sys.executable}} -m pip install -q uv")

if (CODE / ".git").exists():
    sh(f"git -C {{CODE}} fetch -q --depth 1 origin {{BRANCH}} && git -C {{CODE}} reset -q --hard FETCH_HEAD")
else:
    sh(f"git clone -q --depth 1 -b {{BRANCH}} {REPO} {{CODE}}")

# HustlClip needs Python 3.11 or 3.12; uv fetches its own, whatever the image has.
if not (CODE / ".venv").exists():
    sh(f"cd {{CODE}} && uv venv -q --python 3.11 .venv")
# The [gpu] extra brings the CUDA 12 libraries faster-whisper needs.
sh(f"cd {{CODE}} && uv pip install -q --python .venv/bin/python -e '.[gpu]'")

def ffmpeg_can_caption():
    if not shutil.which("ffmpeg"):
        return False
    filters = subprocess.run(["ffmpeg", "-hide_banner", "-filters"], capture_output=True, text=True)
    return " ass " in filters.stdout

if not ffmpeg_can_caption():
    # A static build with libass (captions) and NVENC (GPU encoding).
    archive = BASE / "ffmpeg.tar.xz"
    url = "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz"
    print("Downloading ffmpeg...", flush=True)
    urllib.request.urlretrieve(url, archive)
    with tarfile.open(archive) as tar:
        tar.extractall(BASE / "ffmpeg")
    binary = next((BASE / "ffmpeg").glob("*/bin"))
    os.environ["PATH"] = f"{{binary}}:{{os.environ['PATH']}}"

assert ffmpeg_can_caption(), "ffmpeg without libass: captions cannot be burned in."
HUSTLCLIP = str(CODE / ".venv" / "bin" / "hustlclip")
ENV = dict(os.environ, AUTOCLIP_HOME=str(BASE / "home"), PYTHONUNBUFFERED="1", COLUMNS="100")
subprocess.run([HUSTLCLIP, "doctor"], env=ENV)
"""

KEYS = """# 3 · Load API keys from Secrets (never printed)
NAMES = ["NVIDIA_API_KEY", "ANTHROPIC_API_KEY", "TYPESAFE_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY"]

def read_secret(name):
    try:
        from kaggle_secrets import UserSecretsClient
        return UserSecretsClient().get_secret(name)
    except Exception:
        pass
    try:
        from google.colab import userdata  # the same notebook works on Colab
        return userdata.get(name)
    except Exception:
        return os.environ.get(name)

loaded = []
for name in NAMES:
    value = read_secret(name)
    if value:
        ENV[name] = value.strip()
        loaded.append(name)

print("Keys loaded:", ", ".join(loaded) or "none")
if not loaded:
    raise SystemExit("Add NVIDIA_API_KEY under Add-ons -> Secrets, switch it on, then run again.")
"""

SOURCE = """# 4 · Find the video
VIDEO_TYPES = {".mp4", ".mov", ".mkv", ".webm", ".m4v", ".avi", ".mp3", ".wav", ".m4a"}

if VIDEO_URL.strip():
    SOURCE = VIDEO_URL.strip()
else:
    inputs = [Path("/kaggle/input"), Path("/content")]
    found = [
        p for root in inputs if root.exists()
        for p in root.rglob("*") if p.is_file() and p.suffix.lower() in VIDEO_TYPES
    ]
    if not found:
        raise SystemExit("No video found. Paste a link into VIDEO_URL, or use Add Input -> Upload.")
    SOURCE = str(max(found, key=lambda p: p.stat().st_size))

print("Video:", SOURCE)
"""

RUN = """# 5 · Make the clips (the long step — progress prints below)
OUT = WORK / "hustlclip_clips"
shutil.rmtree(OUT, ignore_errors=True)

command = [HUSTLCLIP, "clip", SOURCE, "--max-clips", str(CLIPS), "--style", CAPTION_STYLE,
           "--whisper-model", TRANSCRIPTION, "--output-dir", str(OUT)]
if DYNAMIC_LAYOUTS:
    command.append("--dynamic-layouts")

process = subprocess.Popen(command, env=ENV, cwd=str(CODE), stdout=subprocess.PIPE,
                           stderr=subprocess.STDOUT, text=True)
for line in process.stdout:
    print(line, end="", flush=True)
if process.wait() != 0:
    raise SystemExit("HustlClip stopped — the message above says why. Run this cell again to "
                     "resume: finished steps (like transcription) are not repeated.")
"""

DOWNLOAD = """# 6 · Download
import json
from IPython.display import FileLink, HTML, display

manifest = json.loads((OUT / "manifest.json").read_text())
archive = shutil.make_archive(str(WORK / "hustlclip_clips"), "zip", OUT)

rows = "".join(
    f"<tr><td>{c['rank']}</td><td>{c['title']}</td><td>{c['duration_s']:.0f}s</td>"
    f"<td>{'filler' if c['quality'] == 'fallback' else c['moment_type']}</td></tr>"
    for c in manifest["clips"]
)
display(HTML(f"<b>{len(manifest['clips'])} clips ready.</b><table>{rows}</table>"))
os.chdir(WORK)
display(FileLink(Path(archive).name))  # tap to download the zip
print("Also in the notebook's Output panel: hustlclip_clips.zip and each MP4.")
"""

APP_INTRO = """## Optional · Use the HustlClip app on your phone instead

Run the cell below to start the HustlClip web app inside this notebook and get a
private link for your phone (through a free Cloudflare quick tunnel). The link carries
a random access token; without it the server refuses every request. Keep the notebook
open while you use it — when the Kaggle session ends, the app stops.
"""

APP = """# 7 · (Optional) Open the app on your phone
import re, secrets, time

TOKEN = secrets.token_urlsafe(24)
server = subprocess.Popen(
    [HUSTLCLIP, "serve", "--host", "127.0.0.1", "--port", "8000", "--no-open"],
    env=dict(ENV, HUSTLCLIP_ACCESS_TOKEN=TOKEN), cwd=str(CODE),
    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
)

cloudflared = BASE / "cloudflared"
if not cloudflared.exists():
    urllib.request.urlretrieve(
        "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64",
        cloudflared,
    )
    cloudflared.chmod(0o755)

tunnel = subprocess.Popen(
    [str(cloudflared), "tunnel", "--no-autoupdate", "--url", "http://127.0.0.1:8000"],
    stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
)
public = None
deadline = time.time() + 60
while time.time() < deadline and public is None:
    line = tunnel.stdout.readline()
    match = re.search(r"https://[a-z0-9-]+\\.trycloudflare\\.com", line)
    if match:
        public = match.group(0)

if public:
    display(HTML(f'<p>Open this on your phone (keep it private):</p>'
                 f'<p><a href="{public}/?token={TOKEN}" target="_blank">{public}/?token=…</a></p>'))
else:
    print("The tunnel did not start. Run the cell again.")
"""


def cell(kind: str, source: str) -> dict:
    lines = source.strip("\n").splitlines(keepends=True)
    base = {"cell_type": kind, "metadata": {}, "source": lines}
    if kind == "code":
        base.update({"execution_count": None, "outputs": []})
    return base


def build() -> dict:
    return {
        "cells": [
            cell("markdown", INTRO),
            cell("code", SETTINGS),
            cell("code", INSTALL),
            cell("code", KEYS),
            cell("code", SOURCE),
            cell("code", RUN),
            cell("code", DOWNLOAD),
            cell("markdown", APP_INTRO),
            cell("code", APP),
        ],
        "metadata": {
            "kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"},
            "language_info": {"name": "python"},
            "kaggle": {"accelerator": "gpu", "isInternetEnabled": True},
        },
        "nbformat": 4,
        "nbformat_minor": 5,
    }


if __name__ == "__main__":
    target = Path(__file__).with_name("HustlClip_Kaggle.ipynb")
    target.write_text(json.dumps(build(), indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Wrote {target}")
