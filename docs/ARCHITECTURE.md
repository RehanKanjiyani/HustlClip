# HustlClip architecture

A single Python process serving a REST API and a compiled React bundle on one
port, with a pipeline that turns long video into short clips.

```
                     ┌──────────────────────────────────────┐
  browser  ◀────────▶│ FastAPI (backend/autoclip/app.py)   │
                     │  · /api/*        REST + SSE          │
                     │  · /*            built React bundle  │
                     └───────────────┬──────────────────────┘
                                     │
                     ┌───────────────▼──────────────────────┐
                     │ JobQueue — one video at a time, FIFO │
                     └───────────────┬──────────────────────┘
                                     │
   ┌─────────────────────────────────▼─────────────────────────────────┐
   │ PipelineRunner                                                    │
   │                                                                   │
   │  prepare → transcribe → discover → evaluate → select              │
   │          → reframe [→ compose] → captions → export               │
   │                                                                   │
   │  each stage writes artifacts to work/{job_id}/                    │
   └───────────────────────────────────────────────────────────────────┘
                                     │
                     ┌───────────────▼──────────────────────┐
                     │ SQLite (~/.autoclip/autoclip.db)   │
                     └──────────────────────────────────────┘
```

## Why one process

HustlClip is used by one person at a time (on their computer, or on a free
cloud GPU driven from a phone — see MOBILE.md). A queue broker, a worker
fleet, and a separate frontend server would each add an install step and a
failure mode in exchange for concurrency nobody needs. The whole thing is
`pip install autoclip && autoclip serve`.

The same reasoning drives the FIFO queue: transcription, face detection, and
encoding each want the entire GPU. Running two jobs at once on a 6 GB card makes
both slower than running them in sequence.

## Layout

```
backend/autoclip/
├── app.py            FastAPI application and static serving
├── cli.py            Typer CLI — doctor, clip, serve, config
├── paths.py          artifact layout under AUTOCLIP_HOME
├── config.py         settings + OS-keyring secrets
├── system.py         environment probing (ffmpeg, GPU, deps)
├── models.py         ML model bundle download and cache
├── api/              REST routers and wire schemas
├── db/               SQLite schema, migrations, row models, CRUD
├── jobs/             queue and SSE broker
├── product.py        user-facing name and tagline, in one place
├── intelligence/     capability contracts, model registry, the AI manager
├── providers/        provider adapters (Anthropic, NVIDIA, OpenAI-compatible,
│                     Gemini, Ollama, TypeSafe Jev)
├── prompts/          versioned prompt text
├── assets/fonts/     bundled OFL caption fonts
└── pipeline/
    ├── ffmpeg.py     probing, running, filtergraph escaping
    ├── transcript.py the shared word-level model
    ├── ingest.py     yt-dlp and file upload
    ├── prepare.py    audio extraction, thumbnails, silence map
    ├── transcribe.py faster-whisper + WhisperX diarization
    ├── boundaries.py sentence snap, duration clamp, silence alignment
    ├── highlights.py transcript windowing for discovery
    ├── candidates.py canonical candidate model + deterministic normalisation
    ├── funnel.py     discovery → triage → scoring → visual → judgment
    ├── selection.py  deterministic global selection (exact count)
    ├── composition.py optional AI-chosen layouts, executed as crop paths
    ├── captions.py   ASS generation and the four presets
    ├── export.py     the render
    ├── runner.py     stage orchestration and resume
    └── reframe/      scenes, faces, tracker, speaker, smoothing, croppath
```

## Load-bearing decisions

### Word indices, not seconds

Highlight detection returns `start_word_index` / `end_word_index`. Timing is
then looked up from measured word timestamps.

Language models are unreliable at arithmetic and completely reliable at copying
a number they can see. Asking for seconds produces clips that start in the wrong
place; asking for an index the model is reading off the page does not.

### Stages are resumable because artifacts are files

Every stage writes its output to `work/{job_id}/`. A retry checks what exists and
starts at the first missing artifact. When transcription took eleven minutes and
the LLM call then hit a rate limit, that difference matters.

### Crop paths never interpolate across a cut

The reframe stage detects shots first and computes a crop path per shot. Panning
through an edit is the single most obvious sign of an auto-reframed video.

### Per-shot segments, concatenated in one filtergraph

ffmpeg filtergraphs cannot change frame size mid-stream, so a clip containing
both a wide two-shot and a tight single can't use one crop. Each shot is trimmed,
cropped independently, scaled to a common output size, and concatenated — all in
a single pass.

Panning within a segment is a piecewise-linear expression over `t` rather than a
`sendcmd` script: it stays in one filtergraph, survives seeking, and can be read
in a log when a render looks wrong.

### Filtergraph paths use bare relative names

Filter option values pass through two unescaping rounds, so a Windows drive
letter needs `C\\:`, not `C\:`. Quoting interacts badly with apostrophes.

Rather than out-escaping this, renders run with ffmpeg's working directory set to
the render workspace and reference `captions.ass` and `fonts` by bare name.
Nothing needs escaping because nothing has a special character in it. Input and
output paths stay absolute — they are ordinary argv arguments, not filtergraph
values.

### Probe capabilities, don't assume them

Two checks look redundant and are not:

- `nvidia-smi` seeing a GPU does not mean CTranslate2 can use it. Missing cuDNN
  is common, and the failure appears at first transcribe.
- `h264_nvenc` appearing in `ffmpeg -encoders` does not mean it encodes. A build
  can require a newer NVENC API than the installed driver provides, and that
  also only surfaces mid-render.

Both are probed functionally, and `autoclip doctor` reports what it actually
tried.

### Compute type follows the hardware

Pre-Volta CUDA devices have no fp16 tensor cores, so `float16` inference is no
faster than `int8_float16` and often slower. `system.py` picks by compute
capability rather than assuming "GPU means float16".

## Data model

Seven tables (`db/schema.py`), migrated by SQLite's `user_version` pragma. Each
migration is append-only: once a user's database is at v3, editing migration 2
silently diverges their schema from a fresh install's.

| table        | holds                                              |
| ------------ | -------------------------------------------------- |
| `sources`    | ingested media and probed metadata                 |
| `jobs`       | pipeline runs, status, progress, settings snapshot |
| `transcripts`| pointer to the transcript JSON, model, diarization  |
| `clips`      | selected clips with boundaries, scores, `details_json` |
| `clip_edits` | user caption edits, style, ratio                    |
| `exports`    | rendered files                                      |
| `ai_decisions` | one row per AI attempt (added in v2)                 |

## The intelligence layer

### Capabilities, not models

Pipeline code asks the AI manager (`intelligence/manager.py`) for a capability —
`candidate_discovery`, `candidate_triage`, `text_scoring`, `visual_understanding`,
`final_judgment`, `duplicate_risk`, `dynamic_composition` — and gets back a
normalised result. It never names a provider or model.

Each capability's contract lives in `intelligence/capabilities.py`: the payload (the
minimum context the decision needs), the prompt, and validation that turns an HTTP
200 into either a usable result or a categorised failure (malformed JSON, schema,
incomplete coverage, hallucinated references, out-of-range scores). Decision
capabilities have two executions — TypeSafe Jev typed questions or an LLM JSON
prompt — that normalise to the same result type, so falling back between them is
invisible to the pipeline.

Transcription (Faster-Whisper) and candidate normalisation (Python) are
deliberately not capabilities: they are never routed to a model.

### One registry

`intelligence/registry.py` holds every model the system may use: provider, API
model id, capabilities with priorities, input modalities, timeouts, retry and
output limits. Routing strategies (automatic / efficiency / quality / custom) and
per-model user overrides are applied there. Changing which model does discovery is
a registry or settings change, never a pipeline change.

### Routing, health, fallback

For each request the manager filters the registry by capability, modality,
enabled state and configured provider, skips models that are unhealthy for this
job, and tries the rest in priority order under a wall-clock timeout:

| failure | response |
|---|---|
| rate limit | cool the model down (provider's retry-after, else 60 s), fall back |
| timeout / connection | one retry on the same model, then cool down and fall back |
| bad or missing key | disable that provider for the job, fall back |
| unknown model | disable that model for the job, fall back |
| unsupported modality | disable that model for that capability, fall back |
| malformed / schema / incomplete / bad references | one repair retry carrying the validation error; two strikes disable the pairing for the job |
| bad request / refusal | no retry, fall back |
| token budget reached | stop; fail the capability with a clear message |

Health is job-scoped and cooldowns expire, so nothing is ever permanently disabled.
Every attempt produces a decision record (provider, model, attempt, fallback reason,
latency, reported token usage or `null`, schema/quality validity, error category),
persisted to `ai_decisions` and exposed at `GET /api/jobs/{id}/ai-decisions`.

### The funnel

`pipeline/funnel.py` spends cheap tokens widely and expensive tokens narrowly:

1. **Discovery** on 8-minute transcript windows (1-minute overlap), roughly one
   proposal per minute of speech, word indices only.
2. **Normalisation** in code: index → measured timestamp, sentence snap, duration
   clamp, silence alignment, dedupe (agreement between overlapping windows nudges
   the prior up), features (speech density, silence ratio, speakers).
3. **Triage** (Jev when configured) only when the pool exceeds the shortlist
   (4 × target, at least 24).
4. **Scoring** of the shortlist in batches of six, with 45 words of context either
   side. The scorer may propose better edges as word indices; code accepts them only
   if they refine to a valid boundary and still overlap the original moment.
5. **Visual** analysis only for promising candidates whose value plausibly depends
   on the picture (gaming, reactions, not self-contained, flagged by triage): three
   still frames each, capped per job.
6. **Final judgment**: one call with at most 24 finalists, allowed to reject any.
7. **Duplicate risk** on genuinely ambiguous pairs only.

Every step writes `work/{job_id}/intel/<step>.json` and reuses it on retry.
Optional steps that fail degrade the job; only discovery failing everywhere fails
it.

### Selection

`pipeline/selection.py` is a greedy selector with explicit, logged penalties. Hard
rule: no two selected clips overlap by more than 15% of the shorter. Soft penalties:
same story (judge or duplicate-risk), topic similarity, same moment type, temporal
crowding. Tier adjustments put judge-kept clips first and fallback windows last.
If the AI pool can't fill the target, sentence-bounded fallback windows are cut by
code and marked `quality: "fallback"`. A video too short for N distinct clips gets
fewer; clips are never duplicated.

### Dynamic composition (optional)

Off by default. When on, a model picks a layout per *shot number* (never seconds)
from what the renderer supports — follow the speaker, or fit the whole frame over a
blurred fill. Code merges flicker (< 3 s) and rewrites the crop path; the renderer
executes it like any other.

## Provider adapters

`providers/base.py` defines the text-generation interface and error categories;
adapters own HTTP/SDK details and report usage exactly as the provider does.
The OpenAI-compatible adapter covers OpenAI, OpenRouter, Groq, DeepSeek, LM Studio
and — as `NvidiaProvider` — NVIDIA's catalogue. `typesafe_provider.py` speaks Jev's
documented `/v1/systemone` contract with httpx and validates every answer against
the question that was asked.

The Anthropic adapter sends no assistant prefill and no `temperature` to current
Claude models, both of which they reject.

## Exposure

The server has no accounts. Setting `HUSTLCLIP_ACCESS_TOKEN` gates every request
(except `/api/health`) behind a shared token — the mode used when the app is
reached from a phone through a tunnel. Link ingestion refuses loopback, private and
link-local addresses, and static files are served only from inside the built bundle.

## Concurrency

The pipeline is blocking work (ffmpeg, Whisper, MediaPipe) with one async stage.
It runs in a worker thread with its own event loop, so the web server stays
responsive during a job.

That thread boundary is why the SSE broker marshals every publish through
`call_soon_threadsafe` — calling `put_nowait` on the loop's queues from a worker
thread would corrupt them.

SQLite uses WAL so the pipeline can commit progress while the UI reads.
Connections are per-thread, because `sqlite3` objects cannot be shared.

## Testing

- **Unit** — boundary refinement, ASS generation, crop-path expressions,
  provider JSON handling, escaping.
- **Render** (`-m slow`) — real ffmpeg encodes, asserting on probed output and
  frame hashes. These catch what unit tests cannot: a filtergraph that parses but
  produces the wrong thing, a font libass can't resolve, an encoder flag the
  local build rejects.
- **API** — the real app with its lifespan running, so migrations, broker
  binding, and queue startup are covered.
- **Golden** (`-m golden`) — the §6.4 reframe acceptance bar on a fixed
  three-video set. A release gate.
