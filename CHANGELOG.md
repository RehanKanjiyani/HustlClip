# Changelog

Notable changes. Format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## 2.0.2: long videos, 2026-10-01

### Fixed

- **Long videos stopped at "Listening" with "Server error 413".** Cutting a speech piece out of the whole-video
  Ogg copied the entire file whenever the piece didn't start at 0, so every piece after the first was the full
  audio (20 MB for a 1 h 46 min stream) and Vercel refused it. Pieces are now cut straight from the video
  (each is only its own minutes of sound), any piece still over 3.5 MB is split in half automatically, and a
  platform 413 shows a clear message instead of "Server error 413". Jobs that already stopped can tap Resume.

## 2.0.0: HustlClip on the web, 2026-09-30

HustlClip becomes a phone web app. The Python backend and the Kaggle notebook are gone (they remain in git history).

### Changed

- **Runs in the phone's browser.** Decoding, silence detection, face detection (MediaPipe), layout, caption drawing
  and H.264/AAC rendering (WebCodecs via Mediabunny) all happen on the phone. Clips are 1080x1920 MP4s.
- **Hosted on Vercel (free).** Tiny serverless functions hold the keys and the password gate:
  `/api/transcribe` (NVIDIA Riva speech-to-text over gRPC) and `/api/chat` (registry models only).
- **Speech-to-text moved to NVIDIA's cloud:** Parakeet TDT 0.6B v2 for English (word timings, CTC 1.1B as fallback),
  Whisper large v3 for Hindi and other languages (timings estimated inside short silence-cut pieces).
- **Same selection rules:** word-index-only AI answers, sentence snap + silence alignment, exactly N distinct clips,
  labelled filler when the AI finds too few.
- **AI manager** keeps health tracking, validation, repair and fallback, and adds hedging (a second model starts if the
  first is stuck in NVIDIA's free queue) and load spreading across models.
- **New layouts:** two people too far apart are stacked; a streamer's small facecam goes on top with gameplay below.
- **Resumable on the phone:** every step is saved in IndexedDB/OPFS; Resume continues where it stopped.
- **Share to HustlClip** from Android's share sheet (installed web app), and **Save / share all** for finished clips.

### Verified

- 45 unit tests (engine, AI manager, reframe, API gate and proxies).
- Live NVIDIA calls with a real key: speech-to-text (English word timings; Hindi) and the full AI funnel.
- A real 3-minute talk, end to end in Chromium: transcript -> 4 judged clips -> faces tracked -> 1080x1920 H.264/AAC
  clips with word-highlighted captions (checked frame by frame).
- Not yet verified: a real Android phone, a 1-3 hour stream end to end, the share-target flow, Vercel itself.

### Fixed along the way

- Ogg pages from the browser's Opus encoder were too large for NVIDIA's decoder ("number of audio samples <= 0");
  pages are now limited to one second.
## HustlClip — 2026-09-29

AutoClip becomes HustlClip: exactly N distinct Shorts per video, chosen by a
multi-model funnel behind a deterministic AI manager, and runnable from a phone
through a free Kaggle GPU notebook.

### Added

- **AI manager, model registry, capability contracts** (`intelligence/`):
  capability-based routing, job-scoped health and cooldowns, safe retries,
  fallback, token budget, decision records (`ai_decisions` table, API).
- **Providers:** NVIDIA hosted catalogue; TypeSafe Jev (typed decisions); usage
  reporting and error categories for all adapters.
- **Funnel:** discovery → normalisation → triage → scoring (with context and
  validated boundary suggestions) → selective visual analysis → final judgment →
  duplicate risk, each step cached for resume.
- **Global selection** with exact count, distinctness, diversity penalties and
  marked fallback windows.
- **Optional dynamic composition** (per-shot layouts executed as crop paths).
- **Links from anywhere yt-dlp supports** (`POST /api/sources/url`), with private
  and loopback targets refused; **access-token gate** for exposed servers.
- **Phone-first UI**: create / progress / results screens, download-all zip,
  installable web app; AI keys and routing in Settings.
- **Kaggle notebook** and **docs/MOBILE.md**.
- CLI `--output-dir` (rank-named files + `manifest.json`) and `--dynamic-layouts`.

### Fixed

- Anthropic adapter sent assistant prefill and `temperature`, which current
  Claude models reject with a 400 — including the previous default model.
- The SPA route served files outside the frontend bundle for `..` paths.
- Per-job settings (clip count, caption style, …) were stored but ignored by
  the job queue.
- `--centre-crop` was accepted and silently ignored.
- A retry re-rendered every clip; renders now resume at the one that failed.
- Clips with equal titles overwrote each other's output file.
- The UI's secondary text colour was never defined and rendered at full
  brightness.

### Removed

- The single-model detect-and-rank path (`highlights.detect`,
  `LLMProvider.detect_highlights`, `highlight_v1.txt`), superseded by the funnel.

### Verification notes

Run on Windows 10, Python 3.11, CPU only, ffmpeg 9.0.2:

- `pytest -m "not slow"`: all pass. Lint (`ruff check`, `ruff format --check`)
  clean; `mypy` clean on the new modules; frontend typechecks and builds.
- `pytest -m e2e` on a 200-second public-domain talking-head video (White House
  weekly address, Wikimedia Commons): full pipeline with real Faster-Whisper,
  MediaPipe reframing, dynamic composition, libass captions and encoding;
  exact configured count, distinct clips, correct dimensions/codec/audio,
  durations matching cuts, resume without re-transcribing, re-asking models or
  re-rendering. Final run on `main`: 28/29 passed; the one failure was
  a 0.00007 backwards step of the overall progress bar during rendering (ffmpeg
  progress overshooting a clip). Fixed by making overall progress monotonic,
  pinned by `tests/test_runner_progress.py`; the full e2e was not re-run after
  that one-line fix.
- `hustlclip clip <video> -n 10 --dynamic-layouts -o out/` (the notebook's
  command) against a local OpenAI-compatible stub over real HTTP: 10 clips,
  1080×1920 H.264 + AAC, zero overlap between clips, captions visible, 5 AI
  picks + 5 marked fallback windows (the stub proposed only 5 distinct moments).

Not verified on the build machine: live calls to NVIDIA, Anthropic or TypeSafe
(no keys there — the adapters are tested against their documented contracts with
mocks; model ids were checked against NVIDIA's public catalogue), image input on
Kimi K3 / DeepSeek V4.1 Flash (handled as a fallback if unsupported), the
notebook on Kaggle itself, GPU transcription/encoding, and clip *quality* with
real models — that needs real videos and real keys.

## Earlier (AutoClip)

The first tagged release waits on the reframe acceptance bar
being validated against a fixed golden video set.

### Added

- **Pipeline** — ingest (YouTube via yt-dlp, or file upload), audio preparation,
  transcription with word-level timings, LLM highlight detection, speaker-tracked
  reframing, ASS caption generation, and export at 9:16 / 1:1 / 16:9.
- **Four LLM providers** behind one interface: Anthropic, OpenAI-compatible (any
  `base_url`, covering OpenRouter, Groq, DeepSeek, LM Studio), Google Gemini, and
  Ollama. Malformed responses are retried once with the validation error attached.
- **Reframing** with shot detection, MediaPipe face tracking, active-speaker
  selection from mouth movement correlated against diarization, and a
  One Euro Filter with dead zone and velocity clamp. Shots are framed as TRACK,
  WIDE, or GENERAL; subjects too far apart to crop get a fitted frame over a
  blurred fill rather than someone being cut out.
- **Four caption styles** with bundled OFL fonts, so nothing is fetched at runtime.
- **Web UI** — ingest, live job progress over SSE, clip review with word-snapping
  trim handles and caption editing, and export.
- **Resumable stages.** Artifacts live on disk per job, so a retry restarts at the
  stage that failed.
- **`autoclip doctor`** — probes ffmpeg features, GPU acceleration, compute-type
  support, and provider reachability, and explains what to do about each.
- **End-to-end test** against real media, covering every stage with only the
  language model's answer scripted.

### Notable fixes during development

Each of these was found by running the thing, not by reading it:

- **Compute-type selection asked the wrong question.** Inferring from CUDA compute
  capability chose `int8_float16` on a GTX 1060, which advertises fp16 to CUDA and
  then can't use it. Selection now queries CTranslate2 for what it actually
  supports.
- **CUDA libraries were installed and unloadable.** pip places them where the OS
  loader doesn't look, so the model loaded and died at first inference. AutoClip
  registers the directories itself.
- **`h264_nvenc` being listed is not proof it works.** A build can require a newer
  NVENC API than the driver provides. Encoder selection now runs a one-frame probe.
- **Filtergraph paths need two levels of escaping**, and quoting interacts badly
  with apostrophes. Renders now use bare relative names with ffmpeg's working
  directory set, removing the problem instead of out-escaping it.
- **The wheel shipped with no UI.** hatchling honours `.gitignore`, and the built
  frontend is gitignored; declared via `artifacts`.
- **Retry could never clear a job's error message**, because the update helper
  skipped `None` values.
- **Progress ran backwards** at every stage boundary, double-counting each
  completed stage.
- **A 9:16 preview rendered nearly square.** A max-height clamp shortened the box
  without narrowing it, silently violating the declared aspect ratio.
- **The preview showed different framing from the export**, centre-cropping while
  the renderer tracked the speaker.
