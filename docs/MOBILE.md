# Using HustlClip from your phone

HustlClip needs a real GPU-class computer to transcribe, track faces and render
video. You don't need to own one: this guide runs HustlClip on **Kaggle's free GPU**
and controls everything from your phone's browser. No laptop or server is needed.

There are two ways to use it once it's set up:

| | Simple mode | App mode (optional) |
| --- | --- | --- |
| What you use | The Kaggle notebook | The HustlClip app, opened on your phone |
| You provide the video by | Pasting a link, or uploading it to Kaggle | Uploading it from your phone's gallery |
| You get the clips by | Downloading one zip | Previewing and downloading them in the app |

> **Honest note.** The notebook and the app were built and tested on a Windows PC
> against real video, but the Kaggle notebook itself could not be run from the build
> machine (it needs your Kaggle account). If a step below doesn't match what you see,
> Kaggle has probably renamed a button; the step's goal is what matters.

---

## What you need (all free)

1. **A Kaggle account** with a **verified phone number**. Kaggle only gives GPUs and
   internet access to phone-verified accounts.
2. **An NVIDIA API key.** HustlClip uses NVIDIA-hosted AI models to find and judge the
   best moments.
3. *(Optional)* An **Anthropic API key** (Claude makes the final pick of the best
   clips; paid) and/or a **TypeSafe API key** (fast yes/no decisions; see
   typesafe.ai). HustlClip works without them.

Any Android phone with Chrome works (tested layout: 375 px wide). iPhone with Safari
works the same way.

---

## One-time setup (about 10 minutes)

### 1. Get your NVIDIA API key

1. On your phone, open **build.nvidia.com** and sign in (or create a free NVIDIA
   account).
2. Open any model page, e.g. search for **Kimi K3**.
3. Tap **Get API Key** → **Generate Key**.
4. Copy the key. It starts with `nvapi-`. Keep it private, like a password.

### 2. Create your Kaggle account and verify your phone

1. Open **kaggle.com** → **Register**.
2. Tap your profile picture → **Settings** → **Phone verification** → verify with an
   SMS code.

### 3. Get the HustlClip notebook into Kaggle

1. On your phone, open
   `https://github.com/RehanKanjiyani/HustlClip/blob/main/notebooks/HustlClip_Kaggle.ipynb`
   and tap **Download raw file** (the download icon). The file
   `HustlClip_Kaggle.ipynb` is saved to your phone.
2. On kaggle.com tap **Create** → **New Notebook**.
3. In the notebook, open the **File** menu → **Import Notebook** → choose the
   `HustlClip_Kaggle.ipynb` you downloaded → **Import**.

   *Phone tip:* Kaggle's editor is easier to use with Chrome's **Desktop site**
   option (⋮ menu → Desktop site). Turn it back off afterwards.

### 4. Turn on the GPU and the internet

In the notebook, open the **settings panel** (the ⚙ / "Session options" panel, on the
right on desktop view, or under ⋮ on narrow screens):

- **Accelerator:** choose a **GPU** (T4 ×2 or P100).
- **Internet:** switch **On**.

### 5. Add your key as a Secret

1. **Add-ons** → **Secrets** → **Add a new secret**.
2. Label: `NVIDIA_API_KEY` — Value: paste your `nvapi-...` key → **Save**.
3. Make sure the switch next to it is **on** for this notebook.
4. *(Optional)* Add `ANTHROPIC_API_KEY` and/or `TYPESAFE_API_KEY` the same way.

Keys stored as Kaggle Secrets are not saved inside the notebook and are never
printed by it.

---

## Making clips — simple mode

### 1. Give it your video

Choose **one**:

- **A link:** in cell **1 · Settings**, set `VIDEO_URL = "https://..."`. Public links
  that yt-dlp can download work (Twitch VODs, direct `.mp4` links, many others).
  YouTube often blocks downloads from cloud machines like Kaggle's; if a YouTube link
  fails, upload the file instead.
- **A file from your phone:** tap **Add Input** → **Upload** (it creates a private
  dataset), pick the video from your gallery or files, give it a name, and create it.
  Leave `VIDEO_URL = ""`; the notebook uses the largest video it finds in your inputs.

Other settings in cell 1:

| Setting | What it does |
| --- | --- |
| `CLIPS` | How many clips (default 10) |
| `CAPTION_STYLE` | `bold_pop`, `karaoke_fill`, `clean_lower` or `boxed` |
| `TRANSCRIPTION` | `large-v3` (best on GPU), `medium`, or `small` (fastest) |
| `DYNAMIC_LAYOUTS` | `True` lets AI switch between following the speaker and showing the whole frame |

### 2. Run everything

Tap **Run All** (▶▶). What happens:

1. **Install** — the first time, a few minutes. It downloads HustlClip, its Python
   environment, and ffmpeg.
2. **Keys** — prints which keys were found (never the keys themselves).
3. **Video** — prints which video it will use.
4. **Make the clips** — the long part. It prints progress: `Transcribing`,
   `Finding moments`, `Evaluating moments`, `Selecting the best 10`, `Reframing`,
   `Rendering`. As a rough guide, expect it to take a fraction of the video's length
   on a Kaggle GPU; long VODs take longer. Keep the tab open.
5. **Download** — a table of your clips and a link to `hustlclip_clips.zip`.

### 3. Download the clips

- Tap the **`hustlclip_clips.zip`** link under step 6, or
- open the notebook's **Output** panel (under `/kaggle/working`) and download
  `hustlclip_clips.zip` or any single `01-...mp4`.

Files are numbered by rank: `01-...mp4` is the strongest clip. `manifest.json` lists
each clip's title, length and where it came from in the original video. Clips marked
**filler** were added because the video had fewer standout moments than you asked
for.

### If something stops

Read the last message the cell printed; HustlClip explains what went wrong in plain
words (for example a rate-limited AI provider). **Run the same cell again.** Finished
steps are reused, so a retry after an AI hiccup doesn't transcribe the video again.

---

## App mode (optional)

This starts the HustlClip app inside your Kaggle session and gives you a private link
to open on your phone.

1. Do the one-time setup above and run cells 1–3 (settings, install, keys).
2. Run cell **7 · (Optional) Open the app on your phone**.
3. Tap the link it shows. It opens HustlClip in your phone's browser:
   **Upload video** → **Create 10 Clips** → watch the progress → preview and
   download each clip, or **Download all**.
4. To make it feel like an app: in Chrome, ⋮ → **Add to Home screen**.

Security: the link contains a random access token. Anyone without it is refused, so
don't share the link. It stops working when the Kaggle session ends. Start a new
session and run cell 7 again to get a new link.

---

## Limits to know

- **Kaggle's free GPU has a weekly quota** (Kaggle shows your remaining hours) and
  sessions stop after a period of inactivity or a maximum run time. Very long VODs may
  need a session to stay open for a long time; keep the tab active.
- **Storage:** clips are written to `/kaggle/working`, which Kaggle keeps as the
  notebook's output. Download what you want to keep.
- **YouTube downloads** from Kaggle are often blocked by YouTube's bot checks; upload
  the file instead.
- **AI usage** is billed by the providers you add keys for. NVIDIA's API has free
  credits at the time of writing; check your account.
- **Google Colab** also works with the same notebook (upload it via **File → Upload
  notebook**, set **Runtime → Change runtime type → GPU**, and add the same names under
  **🔑 Secrets**). Colab's free tier and rules differ from Kaggle's.
