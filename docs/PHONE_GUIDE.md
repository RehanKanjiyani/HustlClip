# HustlClip on your phone: set up once, then just use it

Everything below is done **on your Android phone, in Chrome**. No computer, no server, no Kaggle.

How it works in one line: HustlClip is a website that you host for free on Vercel. Your phone does the video work;
NVIDIA's free AI does the listening and the choosing. Your NVIDIA key stays hidden on Vercel, behind your own password.

| Part | What you do | Time |
|---|---|---|
| A | Get a fresh NVIDIA key | 3 min |
| B | Put HustlClip on Vercel | 7 min |
| C | Add it to your home screen | 1 min |
| D | Make your first 10 clips | 20–40 min (the phone works, you wait) |
| E | Get YouTube / Twitch videos onto your phone with Seal | 5 min, once |

---

## Part A: get a fresh NVIDIA key (3 min)

The key you pasted in chat earlier should be treated as leaked, so make a new one and delete the old one.

1. Open Chrome and go to **build.nvidia.com**. Sign in (same account as before).
2. Tap your profile picture (top right) → **API Keys**.
3. Delete the old key (the ⋮ or 🗑 next to it).
4. Tap **Generate API Key** → give it any name, e.g. `hustlclip` → **Generate**.
5. Tap **Copy**. The key starts with `nvapi-`. Keep this tab open; you paste it in Part B.

## Part B: put HustlClip on Vercel (7 min)

1. In Chrome go to **vercel.com/signup**.
2. Choose **Hobby** (free), type your name, tap **Continue**.
3. Tap **Continue with GitHub** → sign in to GitHub if asked → **Authorize Vercel**.
4. Vercel shows **Let's build something new** (or go to **vercel.com/new**).
5. Under **Import Git Repository**, find **HustlClip** and tap **Import**.
   - Don't see it? Tap **Adjust GitHub App Permissions** → choose **All repositories** (or select HustlClip) → **Save**, then come back.
6. On **Configure Project**:
   - **Framework Preset**: leave it as **Vite**. Leave the other build settings alone.
   - Tap **Environment Variables** to open it. Add these two, one at a time (type the name, paste the value, tap **Add**):

     | Name | Value |
     |---|---|
     | `NVIDIA_API_KEY` | the `nvapi-…` key from Part A |
     | `HUSTLCLIP_PASSWORD` | a password you make up (at least 10 characters). You'll type it once on each phone. |

7. Tap **Deploy**. Wait 1–2 minutes until you see confetti / **Congratulations!**
8. Tap **Continue to Dashboard**. Under **Domains** you'll see your address, like `hustlclip-abc123.vercel.app`.
   Tap it: that's your HustlClip.

> Optional: in **Settings → Domains** you can change it to something easier, like `rehan-hustlclip.vercel.app`.

## Part C: add it to your home screen (1 min)

1. Open your HustlClip address in Chrome.
2. Type your `HUSTLCLIP_PASSWORD` → **Sign in**. (It remembers you for 30 days.)
3. Tap Chrome's **⋮** (top right) → **Add to Home screen** → **Install**.
4. HustlClip now has its own icon and opens full-screen like an app. It also appears in Android's **Share** menu for videos.

## Part D: make your first clips

1. Open HustlClip. Tap **Pick a video** and choose a video from your gallery or Files.
   (Or, in your gallery / Seal, tap **Share → HustlClip**: the video is already picked when HustlClip opens.)
2. Check the two settings:
   - **Language**: English (exact caption timing), Hindi / Hinglish (captions in हिंदी, approximately timed), or Other.
   - **Captions**: Bold Pop, Karaoke Fill, Clean Lower, Boxed, or none.
   - **More options** has the number of clips (default 10) and clip length.
3. Tap **Make 10 clips**.
4. **Keep HustlClip open on the screen** until it finishes. It keeps the screen awake by itself. Plug the phone in for long videos.
   - If you switch apps or the screen turns off, Android may pause it. Come back and tap **Resume**. It continues where it
     stopped; nothing is redone.
   - After a reload, **Resume** asks you to pick the same video again (browsers can't reopen files on their own).
5. What you'll see, in order: **Preparing the sound** → **Listening to the video** → **Choosing the best moments** →
   **Making your clips** (one clip at a time; each clip appears as soon as it's ready).
6. When clips are ready:
   - **Save / share all**: opens Android's share sheet with all clips. Choose **Save to device**/**Files**, YouTube,
     Instagram, WhatsApp, etc.
   - Per clip: **Share**, **Download**, and **.srt** (captions file, if a platform asks for one).
7. Finished jobs stay in **Your jobs** on the home screen. Delete a job to free up the phone's space.

**How long does it take?** A 1-hour video usually takes 15–40 minutes, mostly the phone making the 10 videos.
Longer streams (2–3 hours) take longer in the "listening" and "choosing" steps.

**Filler clips:** if a video has fewer strong moments than you asked for, HustlClip fills the set from the best remaining
parts and marks those clips "Filler". It never repeats a moment.

## Part E: get YouTube / Twitch videos onto your phone (Seal)

YouTube blocks downloads from cloud servers, so the video has to come to your phone first. **Seal** is a free,
open-source downloader that does this on the phone.

1. In Chrome open **github.com/JunkFood02/Seal/releases** → the newest release → **Assets** → tap the APK that ends in
   `arm64-v8a.apk`.
2. Open the download. If Android asks, allow **Install unknown apps** for Chrome, then **Install**.
3. Open Seal once and allow storage/notifications.
4. In Seal's **Settings → Download format**, pick **MP4** (or turn on "prefer MP4") and a quality like **1080p**.
   MP4 is the format HustlClip reads best.
5. To clip a stream: in YouTube tap **Share → Seal** → **Download**. When it finishes, in Seal tap the video →
   **Share → HustlClip**.

## Troubleshooting

| You see | Do this |
|---|---|
| "Almost there" page | `HUSTLCLIP_PASSWORD` or `NVIDIA_API_KEY` is missing. Vercel → your project → **Settings → Environment Variables**, add it, then **Deployments → ⋯ → Redeploy**. |
| "That password is not right" | Use the exact `HUSTLCLIP_PASSWORD` from Vercel (it's case-sensitive). |
| "NVIDIA rejected the API key" | Make a new key (Part A), replace `NVIDIA_API_KEY` in Vercel, **Redeploy**. |
| "The AI models are busy / rate-limited" | NVIDIA's free tier is busy. Wait a few minutes and tap **Resume**. |
| "can't decode this video" | Download it again as **MP4** in Seal (Part E, step 4). |
| It stopped when I left the app | Normal on Android. Come back and tap **Resume**. |
| Phone gets warm | Normal while making clips. Take it out of its case; keep it plugged in for long videos. |
| Not enough space | Each finished clip is ~30–60 MB. Delete old jobs in HustlClip, and delete the downloaded stream in Seal when done. |

## Optional: more AI keys (Gemini, OpenAI, Claude)

NVIDIA alone is enough. Extra keys make HustlClip faster when NVIDIA's free models are busy, and can improve the final
pick. Add any of these in Vercel → your project → **Settings → Environment Variables**, then
**Deployments → ⋯ → Redeploy**:

| Name | Where to get it | What HustlClip uses it for |
|---|---|---|
| `GEMINI_API_KEY` | aistudio.google.com → **Get API key** (has a free tier) | Shares every AI step with NVIDIA, so jobs finish sooner |
| `OPENAI_API_KEY` | platform.openai.com → **API keys** (paid) | Helps score moments; second choice for the final pick |
| `ANTHROPIC_API_KEY` | console.anthropic.com → **API Keys** (paid) | Makes the final pick of the best clips |

If a key fails or runs out of credit, HustlClip quietly uses the others. Only transcript text is sent to these
services, never your video.

Optional model names (only if a provider retires the default): `GEMINI_MODEL` (default `gemini-flash-lite-latest`, the cheapest),
`OPENAI_MODEL` (default `gpt-5.4-nano`, the cheapest), `ANTHROPIC_MODEL` (default `claude-opus-5`).

## Changing things later

- **New key or password:** Vercel → project → **Settings → Environment Variables** → edit → **Save**, then
  **Deployments → ⋯ → Redeploy**.
- **Updates:** every change pushed to GitHub `main` is deployed by Vercel automatically.
- **Cost:** Vercel Hobby and NVIDIA's API catalog are free for personal use. If you start selling HustlClip as a
  service, Vercel requires the Pro plan.
