# HustlClip

**Turn your VOD into 10 Shorts, right on your phone.**

HustlClip is a web app you open in your phone's browser. Pick a long video (a stream, a podcast, a talk) and it:

1. **listens** to the whole video with NVIDIA's cloud speech-to-text (word-accurate timing in English; Hindi and other
   languages supported),
2. **chooses** exactly 10 distinct moments with a multi-stage AI funnel (discovery → scoring → final judgment →
   duplicate check), with code, not the model, owning timing, count and selection,
3. **frames** each moment for 9:16: follows the speaker's face, stacks two people, or puts a streamer's facecam above
   the gameplay,
4. **burns in captions** word by word, and
5. **renders** finished 1080×1920 MP4s on the phone itself, using its video chip.

No server, no notebook, no desktop. Hosting is Vercel's free plan; the AI is NVIDIA's free API catalog.

**Set it up on your phone: [docs/PHONE_GUIDE.md](docs/PHONE_GUIDE.md).**

## How it's built

| Where | What |
|---|---|
| Phone browser | Decoding, audio extraction, silence detection, face detection (MediaPipe), layout planning, caption drawing, H.264 encoding (WebCodecs via [Mediabunny](https://mediabunny.dev)), job storage (IndexedDB + OPFS), resume |
| Vercel functions (`api/`) | Password gate, and a thin proxy that holds the API keys: `/api/transcribe` (NVIDIA Riva ASR over gRPC), `/api/chat` (registry models only) |
| NVIDIA cloud | Parakeet TDT / CTC (English, word timings), Whisper large v3 (multilingual), and LLMs (Nemotron 3 Super, DeepSeek V4.1 Flash, GPT-OSS, Kimi K3, GLM) |
| Optional keys | Gemini (`GEMINI_API_KEY`), OpenAI (`OPENAI_API_KEY`) and Claude (`ANTHROPIC_API_KEY`) join the same routing with fallback |

Key design rules, kept from the original app:

- **Models never give seconds.** They cite word indices; code turns them into cuts (sentence snap, length clamp,
  silence alignment).
- **Exactly N distinct clips.** Global selection forbids overlap above 15 % of the shorter clip and penalises
  repeats; if the AI finds fewer strong moments, sentence-bounded filler clips fill the gap and are labelled.
- **One AI manager.** Capabilities route through a shared model registry with health tracking, validation, repair
  retries, fallback, load spreading, and hedging (a second model starts if the first is stuck in the free-tier queue).
- **Resumable.** Every stage saves its result on the phone; Resume never redoes finished work.
- **Keys never reach the browser.** They live in Vercel environment variables. `HUSTLCLIP_PASSWORD` is required;
  without it the API refuses to run.

## Code map

```
api/            Vercel functions (password gate, speech-to-text proxy, AI proxy)
shared/         Model registry shared by browser and server
src/engine/     Pure logic: transcript, boundaries, candidates, AI manager, funnel, selection, reframe, captions
src/media/      Browser media: audio extraction, face analysis, drawing, rendering
src/pipeline/   The job runner and speech-to-text chunking
src/ui/         Screens
tests/          Vitest suites
```

## Develop

```bash
npm install
```

```bash
NVIDIA_API_KEY=nvapi-... HUSTLCLIP_PASSWORD=dev-password npm run dev
```

```bash
npm run typecheck && npm test && npm run build
```

`npm run dev` serves the `api/` functions locally too, exactly as Vercel does. Rendering needs a Chromium-based
browser (WebCodecs, OPFS).

The previous Python / Kaggle version of HustlClip is in the git history (before the 2.0.0 web rewrite).

## Licence

MIT. See [LICENSE](LICENSE). Third-party notices: MediaPipe (Apache-2.0), Mediabunny (MPL-2.0), NVIDIA Riva protos
(MIT), Anton and Inter fonts (OFL).
