# HustlClip on your phone — the complete guide

This guide takes you from nothing to ten finished Shorts saved on your phone, using
only your phone. No computer, no server, and nothing to pay for.

- **Part A** explains what you're setting up (read this first, 2 minutes).
- **Part B** is the one-time setup (about 15 minutes).
- **Part C** is how you make clips every time (a few taps).
- **Part D** gets the clips onto your phone.
- **Part E** is the optional "real app" mode, with a home-screen icon.
- **Part F** covers problems and fixes.

> **Honest note.** HustlClip and this notebook were built and tested on a PC with a
> real video, but the notebook could not be run inside Kaggle from there, because
> that needs your own Kaggle account. Your first run is its first real run on
> Kaggle. Kaggle also renames buttons from time to time. If a button in this guide
> isn't exactly where described, look for the same word nearby: the goal of each
> step is what matters.

---

## Part A — What you are setting up

HustlClip needs a strong computer with a graphics card (GPU) to listen to your video,
find the best moments, follow faces, and render the clips. Phones can't do that
quickly, so HustlClip runs on **Kaggle**, a free Google-owned website that lends you a
GPU computer for a few hours at a time. You control it from your phone's browser.

- **There is no Play Store app to install.** Kaggle is used through Chrome. In Part E
  you can add HustlClip to your home screen so it opens like an app.
- **The AI** that picks the best moments comes from **NVIDIA** (free key). Claude
  (Anthropic) and TypeSafe Jev are optional extras.
- **Your clips** come back as normal MP4 video files that you download to your phone
  and post anywhere.

What you need:

| Thing | Cost | Why |
|---|---|---|
| Chrome on your phone | free | everything happens in the browser |
| A Google or email account | free | to sign up for Kaggle and NVIDIA |
| A phone number that gets SMS | free | Kaggle only lends GPUs to verified accounts |
| ~2 GB free space on your phone | — | to download finished clips |

Tip: many Kaggle screens are designed for computers. When a button seems missing, turn
on **Chrome ⋮ menu → Desktop site** (tick box), zoom with two fingers, and untick it
again later.

---

## Part B — One-time setup (about 15 minutes)

### B1. Get your free NVIDIA API key

An API key is like a password that lets HustlClip use NVIDIA's AI models.

1. Open Chrome and go to **build.nvidia.com**.
2. Tap **Login** (top right) and sign in or create a free NVIDIA account. Confirm your
   email if asked.
3. In the search box, type **kimi-k3** and open the model page. Any model page works.
4. Tap **Get API Key** (sometimes shown as "</> Get API Key" or under the code
   example).
5. Tap **Generate Key**, then **Copy Key**.
6. The key starts with `nvapi-`. Paste it somewhere private for the next 10 minutes,
   for example a note that only you can see.

Never post this key anywhere public. If it leaks, go back to the same page, delete it
and make a new one.

### B2. Create your Kaggle account

1. Go to **kaggle.com** and tap **Register**.
2. Sign up with Google or with your email.
3. Pick a username and accept the terms.

### B3. Verify your phone number on Kaggle (required for the free GPU)

1. On kaggle.com tap your **profile picture** (top right) → **Settings**.
2. Scroll to **Phone verification** and tap **Verify**.
3. Enter your number, then type the SMS code Kaggle sends you.

Without this step you can't switch on the GPU or the internet, and HustlClip won't
run.

### B4. Download the HustlClip notebook file to your phone

The notebook is the recipe Kaggle follows. It lives in your GitHub repo.

1. In Chrome, open:
   `https://github.com/RehanKanjiyani/HustlClip/blob/main/notebooks/HustlClip_Kaggle.ipynb`
2. Tap the **download icon** (a down-arrow above the file, labelled **Download raw
   file**). On the phone layout it may be under the **⋯** menu next to the file name.
3. Chrome saves `HustlClip_Kaggle.ipynb` into your **Downloads**.

If GitHub shows the notebook as text instead of downloading it: open the file page, tap
**Raw**, then Chrome **⋮ → Download** (the down-arrow icon at the top of the ⋮ menu).

### B5. Import the notebook into Kaggle

1. On kaggle.com tap **+ Create** (or the **+** button) → **New Notebook**.
   A notebook editor opens.
2. Turn on **Chrome ⋮ → Desktop site** now; the editor is much easier to use that way.
3. In the notebook's top menu tap **File** → **Import Notebook**.
4. Choose **Browse files** / **Upload**, pick `HustlClip_Kaggle.ipynb` from Downloads,
   and tap **Import**.
5. The notebook now shows grey boxes called **cells**, numbered **1 · Settings**,
   **2 · Install**, and so on up to **7**.
6. Tap the notebook title (top left, something like "notebook1a2b3c") and rename it
   **HustlClip**, so it's easy to find later.

### B6. Switch on the GPU and the internet

In the editor, open the **settings panel** on the right side. It may be collapsed
behind a **›** or **Session options**/**Settings** button, or be reachable from the top
menu **Settings**.

1. **Accelerator**: choose **GPU T4 ×2** (or **GPU P100**). Confirm if asked.
2. **Internet**: switch it **On**.
3. Leave **Persistence** and the other options as they are.

### B7. Add your NVIDIA key as a Secret

Secrets keep your key out of the notebook itself, so it's never shown or shared.

1. In the notebook's top menu tap **Add-ons** → **Secrets**.
2. Tap **Add a new secret** (or **+ Add Secret**).
3. **Label**: type exactly `NVIDIA_API_KEY` (capital letters, underscores).
4. **Value**: paste your `nvapi-...` key.
5. Tap **Save**.
6. Make sure the **switch/checkbox next to `NVIDIA_API_KEY` is ON** ("attached" to this
   notebook). If it's off, the notebook can't see the key.

Optional extras, added the same way:

| Label | What it adds |
|---|---|
| `ANTHROPIC_API_KEY` | Claude makes the final pick of the best clips (paid; console.anthropic.com) |
| `TYPESAFE_API_KEY` | TypeSafe Jev makes fast yes/no decisions (typesafe.ai) |

You can now delete the temporary note where you pasted the key.

Setup is done. You never repeat Part B, except B7 if you change keys.

---

## Part C — Making clips (every time)

### C1. Open your HustlClip notebook

kaggle.com → your **profile picture** → **Your Work** (or **Code**) → **HustlClip** →
**Edit**. Turn on **Desktop site** if the editor is cramped.

### C2. Give it your video — choose ONE way

**Way 1: a link** (fastest if your video is online)

1. Tap into cell **1 · Settings**.
2. Change `VIDEO_URL = ""` to your link, keeping the quotes, for example:
   `VIDEO_URL = "https://www.twitch.tv/videos/1234567890"`
3. Links that usually work: Twitch VODs, Vimeo, Kick, direct links ending in `.mp4`, and
   most sites yt-dlp supports. **YouTube often blocks** Kaggle's computers; if a
   YouTube link fails, use Way 2.

**Way 2: upload the video file from your phone**

1. In the right-side panel tap **+ Add Input** (or **Add Data**) → **Upload**
   (sometimes **New Dataset**).
2. Tap **Browse files** and pick your video from the gallery or Files.
3. Give the dataset a title such as `my-vod-1`, leave it **Private**, and tap
   **Create**. Big files take a while on mobile data, so use Wi-Fi.
4. When it finishes, it's attached to the notebook automatically. It appears in the
   right panel under **Input**.
5. Make sure cell 1 still says `VIDEO_URL = ""`. The notebook then uses the biggest
   video it finds in your inputs.

Before a new video: remove the old input (tap **⋮** next to it → **Remove**), or the
notebook may pick the old one if it's bigger.

### C3. Choose your options (optional)

In cell **1 · Settings**:

| Setting | Default | Change it to… |
|---|---|---|
| `CLIPS = 10` | 10 | any number, e.g. `5` or `15` |
| `CAPTION_STYLE` | `"bold_pop"` | `"karaoke_fill"`, `"clean_lower"` or `"boxed"` |
| `TRANSCRIPTION` | `"large-v3"` | `"small"` for speed; `"large-v3"` is the most accurate |
| `DYNAMIC_LAYOUTS` | `False` | `True` to let AI show the whole frame for gameplay or group moments |
| `APP_MODE` | `False` | `True` only for Part E |

Caption styles, in words: **bold_pop** is big white words with the spoken word turning
yellow. **karaoke_fill** fills each word with colour as it's said. **clean_lower** is
small and minimal. **boxed** puts white text on a black box.

### C4. Run it — choose ONE way

**Way A (recommended on a phone): run in the background**

This keeps running even if you lock your phone or close Chrome.

1. Tap **Save Version** (top right).
2. Choose **Save & Run All (Commit)**.
3. Check the **advanced settings** there, if shown: GPU on and internet on.
4. Tap **Save**.
5. You can now close Chrome. Kaggle runs everything for you, usually for well under an
   hour, depending on the video's length (the first run adds a few minutes of
   installing).
6. Kaggle shows the run under your notebook's **Version history**. When it says
   **Successful** (you may also get an email), go to Part D.

**Way B: watch it live**

1. Tap **Run All** (▶▶ in the toolbar, or **Run → Run All**).
2. Keep the tab open and the screen on. Plug in the charger for long videos.
3. Watch cell **5**. It prints progress like:

   ```
   [ 20%] Transcribing
   [ 35%] Finding moments (3/7)
   [ 46%] Scoring 24 moments
   [ 52%] Selecting the best 10
   [ 60%] Reframing clip 4
   [ 85%] Exporting clip 8
   ```

4. When cell **6** shows a table of clips and a `hustlclip_clips.zip` link, go to
   Part D.

What the numbers mean: HustlClip first **transcribes** (turns speech into words with
timings), then **finds** candidate moments, **evaluates** them (hook, context, payoff,
…), **selects** the best distinct ones, **reframes** to vertical following the
speaker, adds **captions**, and **renders** the final videos.

---

## Part D — Getting the clips onto your phone

### If you used Way A (background run)

1. Open the notebook's page (not the editor): **Your Work** → **HustlClip**.
2. Tap the **Output** tab (or scroll to the **Output** section).
3. You'll see `hustlclip_clips.zip`, and inside the `hustlclip_clips` folder each clip
   as `01-title.mp4`, `02-title.mp4`, …
4. Tap a file and then the **download** icon. Download single MP4s if you only want a
   few; they go straight to your gallery/Downloads.

### If you used Way B (live)

- Tap the **`hustlclip_clips.zip`** link under cell 6, **or**
- in the editor's right panel open **Output** (`/kaggle/working`) → `hustlclip_clips`
  and download files with the **⋮ → Download** next to each.

### Unzipping on Android

1. Open the **Files** app (Files by Google, or OnePlus **File Manager**).
2. Go to **Downloads** and tap `hustlclip_clips.zip`.
3. Tap **Extract**. You get a folder with the ten MP4s and `manifest.json`.
4. The clips show up in your Gallery (you may need to open the folder once). You can
   post them to TikTok, Instagram Reels or YouTube Shorts like any video.

Understanding the files:

- **`01-…mp4` is the strongest clip**, `10-…` the weakest of the ten.
- `manifest.json` lists each clip's title, length and where it came from in the
  original video (open it with any text viewer).
- A clip marked **filler** in the notebook's table means the video had fewer standout
  moments than you asked for, so HustlClip filled the set with the best remaining
  material. It never repeats a clip to reach the number.

Your clips stay in Kaggle's Output until you delete the notebook version, but download
what you want to keep.

---

## Part E — Optional: the HustlClip app on your phone

Instead of editing cells, you can use HustlClip's own screens (Upload → Create 10 Clips
→ previews → Download) in your phone's browser, with an icon on your home screen. It
works while a Kaggle session is running.

### E1. Start it

1. Open the notebook in the editor (Part C1). GPU and internet must be on (B6).
2. In cell **1**, set `APP_MODE = True`.
3. Tap **Run All** (Way B, live). Don't use Save Version for app mode.
4. Wait until cell **7** shows **"Open this on your phone (keep it private)"** with a
   link like `https://some-words.trycloudflare.com/?token=…`.
5. Tap the link. HustlClip opens in a new tab.

### E2. Add it to your home screen

1. With HustlClip open, tap **Chrome ⋮ → Add to Home screen** (or **Install app**).
2. Tap **Add**. A HustlClip icon appears on your home screen.

The icon only works while that Kaggle session is running. Each new session gives a new
link, so repeat E1–E2 next time and remove the old icon.

### E3. Using the app

**Start screen ("Turn your VOD into 10 Shorts")**

- **Upload video** opens your gallery or Files. Pick the video. **Or** paste a link into
  **Paste a video link**.
- **Options** (below the button): number of clips, caption style, shortest and longest
  clip, transcription accuracy, several speakers, dynamic layouts.
- Tap **Create 10 Clips**. The button shows upload progress.
- If a yellow note says **"Add an AI key first"**, the key isn't attached (see B7).
  You can also paste a key under **Settings → AI keys**.

**Progress screen**

- A list of steps: *Preparing, Transcribing, Finding moments, Evaluating moments,
  Selecting the best, Reframing, Adding captions, Rendering*. The active step fills up,
  and the big number is the overall percentage.
- **Cancel** stops the job. If something fails, the message says why and **Retry**
  continues from the step that failed.
- When it finishes, it jumps to the clips.

**Clips screen**

- Each clip plays right there. Tap ▶. Under it: title, length and the kind of moment
  (Story, Insight, Funny, …). *filler* marks fill-in clips.
- **Download** under a clip saves that MP4 to your phone.
- **Download all** at the top saves one zip of every clip (unzip as in Part D).
- **Edit** opens the editor: trim a clip's start and end, fix caption words, change
  the caption style or shape, and re-render a single clip.

**Settings**

- **AI keys**: add or remove keys. Saved keys are never shown again.
- **AI routing**: **Automatic** (recommended), **Efficiency first** (cheapest) or
  **Quality first** (strongest models for more steps). **Advanced** lets you switch
  individual models off and **Test connections**.
- Transcription, clip length, clips per video, and export options.

**Privacy**: the link contains a secret token. Anyone without it is refused, so don't
share the link or screenshot it. It dies when the Kaggle session ends.

---

## Part F — Problems and fixes

| What you see | What to do |
|---|---|
| "Add NVIDIA_API_KEY under Add-ons -> Secrets…" | B7: check the label is exactly `NVIDIA_API_KEY` and its switch is **on** for this notebook. |
| "No video found…" | Put a link in `VIDEO_URL`, or attach an upload (C2). |
| The link download fails, especially YouTube ("confirm you're not a bot") | YouTube blocks Kaggle's computers. Download the video to your phone first, then upload it (C2, Way 2). |
| Can't choose a GPU or turn on internet | Verify your phone number (B3). |
| "The AI providers are temporarily rate-limited" | Wait a few minutes and run again. Finished steps are reused, so the video isn't transcribed twice. |
| "An AI provider rejected its API key" | Make a new key (B1) and replace the secret (B7). |
| Cell 5 stopped with a message | Read the message; it says why. Run cell 5 again (or Run All). Work already done is reused. |
| Session stopped / "session expired" | Kaggle stops idle sessions. Use **Save & Run All** (C4, Way A) for long videos. |
| Kaggle says you're out of GPU quota | Kaggle gives a free weekly GPU allowance; it shows how much is left. Wait for the weekly reset. |
| Fewer clips than asked for | The video is too short for that many distinct clips of the chosen length. Lower `CLIPS` or the shortest-clip length. |
| App link doesn't open | Run cell 7 again for a new link, and make sure you opened the **whole** link including `?token=…`. |
| Buttons in Kaggle look different | Turn on **Chrome ⋮ → Desktop site**, and look for the same words (Save Version, Add Input, Add-ons, Secrets, Output). |

Things to know:

- **Costs:** HustlClip and Kaggle are free. AI usage is billed by the providers you add
  keys for. NVIDIA gives free credits (check your NVIDIA account). Claude is paid.
- **Only use videos you own or have permission to clip.**
- **What leaves Kaggle:** pieces of the transcript go to the AI providers you added keys
  for. With visual checks, a few still frames of promising moments go to a vision
  model. The full video and audio are never sent to any AI provider.

Also works on **Google Colab**: upload the same notebook (**File → Upload notebook**),
set **Runtime → Change runtime type → T4 GPU**, and add the same key names under the
**🔑 Secrets** icon on the left. Colab's free limits differ from Kaggle's.
