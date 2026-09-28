# HustlClip

**Turn your VOD into 10 Shorts.** One long video in → ten distinct, reframed, captioned,
loudness-normalised 9:16 clips out.

[![CI](https://github.com/RehanKanjiyani/HustlClip/actions/workflows/ci.yml/badge.svg)](https://github.com/RehanKanjiyani/HustlClip/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Python 3.11 | 3.12](https://img.shields.io/badge/python-3.11%20%7C%203.12-blue.svg)](https://www.python.org/)

Upload a video or paste a link, tap **Create 10 Clips**, and download ten finished
Shorts. Underneath, HustlClip transcribes with Faster-Whisper, has cheap AI models scan
the whole transcript for candidate moments, scores the promising ones with a mid-tier
model, looks at frames only where the picture matters, lets a strong model compare the
finalists, and then **code** — not a model — picks exactly ten distinct clips, cuts them
on measured word timings, follows the speaker into vertical, burns in captions and
renders MP4s.

HustlClip optimises for what tends to work in short-form (a strong hook, context a
stranger understands, a payoff that lands). It cannot guarantee that anything goes
viral, and doesn't claim to.

> **On a phone, with no computer?** See **[docs/MOBILE.md](docs/MOBILE.md)** — HustlClip
> runs on Kaggle's free GPU and is driven from your phone's browser.

---

## How it works

```
video ─► prepare ─► Faster-Whisper (word timings)
      ─► candidate discovery   (fast model, compact transcript windows, word indices only)
      ─► normalisation         (code: index → measured timestamp, sentence snap, dedupe)
      ─► triage                (TypeSafe Jev or a cheap model, only for large pools)
      ─► scoring               (mid-tier model: hook, context, payoff, … 13 dimensions)
      ─► visual check          (vision model, only for flagged finalists)
      ─► final judgment        (strongest configured model, one compact call)
      ─► global selection      (code: exactly N, distinct, diverse)
      ─► reframe ─► [dynamic layouts] ─► captions ─► loudness ─► ffmpeg ─► N MP4s
```

The load-bearing rules:

- **Models return references, code owns facts.** AI answers are word indices,
  candidate ids and shot numbers — never timestamps. Durations, overlap, duplicates,
  the exact clip count, and every cut are decided in Python from measured data.
- **Exactly N.** The selector keeps going until it has the requested number of
  distinct clips. If the video has fewer strong moments, it fills from the best
  remaining material and marks those clips as *filler*. It never duplicates a clip to
  hit the number; a video too short for N distinct clips gets fewer, and says so.
- **One AI manager.** The pipeline asks for *capabilities* (`candidate_discovery`,
  `text_scoring`, `final_judgment`, …). A deterministic router picks the model, retries
  what is safe to retry, falls back to the next model on rate limits, outages, bad keys
  or unusable answers, and records every call (provider, model, latency, and token
  usage exactly as reported — `null` when a provider doesn't report it).
- **Everything resumes.** Each step writes an artifact; a retry after an AI hiccup or
  a render failure never re-transcribes, and never re-asks the models what they already
  answered.

[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) has the details.

## AI providers

Each provider is optional; configure at least one.

| Provider | Used for (default routing) | Key |
|---|---|---|
| **NVIDIA** (build.nvidia.com) | discovery (Nemotron 3.5 Lightning → GLM-5.3 Flash → Kimi K3), scoring (GLM-5.3 Flash → Kimi K3), vision (Kimi K3 → DeepSeek V4.1 Flash → GLM-5.3 Flash), fallback judge (Kimi K3) | `NVIDIA_API_KEY` |
| **Anthropic** | final judgment (your configured Claude model, default `claude-opus-5`) | `ANTHROPIC_API_KEY` |
| **TypeSafe Jev** | fast typed decisions: triage, repeat detection | `TYPESAFE_API_KEY` |
| OpenAI-compatible, Gemini, Ollama | general fallbacks | `OPENAI_API_KEY`, `GEMINI_API_KEY`, — |

Model IDs live in one registry (`backend/autoclip/intelligence/registry.py`) and can be
overridden or disabled in **Settings → AI routing → Advanced** without code changes.
Routing strategies: **Automatic**, **Efficiency first** (keeps premium models out),
**Quality first** (uses the strongest model for more steps).

What leaves your machine: transcript excerpts go to the AI providers you configured;
with visual checks on, a few still frames of *promising* clips go to a vision model.
Audio and full video are never sent to any AI provider.

## Requirements

| | |
|---|---|
| **Python** | 3.11 or 3.12 — **not 3.13** (MediaPipe has no 3.13 wheels). |
| **ffmpeg** | A *full* build with `libass` and `libx264`; `ffmpeg` and `ffprobe` on PATH. |
| **Node** | 20+, only to build the UI. |
| **GPU** | Optional locally; NVIDIA or Apple Silicon speeds transcription up several-fold. |

`hustlclip doctor` checks all of this and explains what to fix.

**Installing ffmpeg correctly** — captions need libass, and the obvious package lacks it
on two platforms. macOS: `brew install ffmpeg-full`. Windows: `winget install Gyan.FFmpeg`
(the full build, not *Essentials*). Linux: `sudo apt install ffmpeg`.

## Quickstart (computer)

```bash
git clone https://github.com/RehanKanjiyani/HustlClip.git
```

```bash
cd HustlClip && uv venv --python 3.11 && uv pip install -e ".[dev]"
```

```bash
cd frontend && npm install && npm run build && cd ..
```

```bash
hustlclip doctor
```

```bash
hustlclip serve
```

That opens `http://localhost:8000`. Add a key in **Settings → AI keys**, or:

```bash
hustlclip config set-secret nvidia
```

Keys are stored in the OS keyring (never in a config file), or read from the
environment variables in the table above. They are never sent to the browser.

### Command line

| command | does |
|---|---|
| `hustlclip clip <link\|file> -o clips/` | run everything; copy `01-….mp4 … 10-….mp4` + `manifest.json` to `clips/` |
| `hustlclip serve` | start the web app |
| `hustlclip doctor` | check this machine |
| `hustlclip providers` | check which providers are reachable |
| `hustlclip jobs` | list recent jobs |
| `hustlclip config show` | print settings (never keys) |

`hustlclip clip` options: `-n/--max-clips`, `--style`, `--whisper-model`,
`--dynamic-layouts`, `--diarize`, `--centre-crop`. (`autoclip` still works as an alias.)

### API

The browser is just a client of the REST API (`/docs` for the full schema). Main calls:
`POST /api/sources/upload` or `POST /api/sources/url` → `POST /api/jobs` →
`GET /api/jobs/{id}/events` (SSE progress) → `GET /api/jobs/{id}/clips` →
`GET /api/jobs/{id}/download-all`. Also: cancel, retry, `GET /api/jobs/{id}/ai-decisions`,
`GET /api/ai/status`.

If you expose the server beyond your own machine, set `HUSTLCLIP_ACCESS_TOKEN`: every
request then needs the token (open `/?token=…` once; API clients send
`Authorization: Bearer …`).

### Docker

```bash
docker compose -f docker/compose.yaml up --build
```

## Caption styles

| style | look |
|---|---|
| `bold_pop` | chunky white, heavy outline, the spoken word grows and turns yellow |
| `karaoke_fill` | words fill with colour as they're spoken |
| `clean_lower` | minimal lower third |
| `boxed` | high-contrast text on a solid block |

## Troubleshooting

**"No AI model is available…"** — add a key (Settings → AI keys, or `NVIDIA_API_KEY`).

**"The AI providers are temporarily rate-limited."** — HustlClip already tried every
configured model. Retry the job later; finished steps are reused.

**Captions missing / "No such filter: ass".** Your ffmpeg lacks libass — see above.

**YouTube downloads fail with a bot check.** YouTube blocks most anonymous downloads,
especially from cloud machines. Set **Settings → Ingest → cookies from browser** on a
computer, or upload the file instead.

**Transcription fails with "Library cublas64_12.dll is not found".**
`uv pip install -e ".[gpu]"`.

## What has and hasn't been verified

See the verification notes in [CHANGELOG.md](CHANGELOG.md) for the exact commands and
results of the last verification run.

## Non-goals

No automatic posting, no accounts or billing, no professional timeline editor, no DRM
circumvention.

## Credits and license

HustlClip is built on [AutoClip](https://github.com/artbyjazi/autoclip) by Jad Ghazi.
MIT — see [LICENSE](LICENSE). Bundled fonts (Anton, Inter) are under the SIL Open Font
License. HustlClip bundles yt-dlp: **only process video you own or have the rights to
use.**
