# Security

## Reporting a vulnerability

Please don't open a public issue for a security problem. Use GitHub's
[private vulnerability reporting](https://github.com/RehanKanjiyani/HustlClip/security/advisories/new) instead.

## What HustlClip does with your data

- **Your video never leaves your phone.** Decoding, face detection, layout and rendering all run in the browser.
- **What is sent:** compressed speech audio (to NVIDIA speech-to-text, through your own Vercel deployment) and
  transcript text (to the AI models listed in `shared/models.ts`). Nothing else.
- **API keys live only in Vercel environment variables.** They are never sent to the browser, never included in a
  response, and never logged.
- **Everything is password-protected.** Every endpoint that spends a key requires a session from
  `HUSTLCLIP_PASSWORD`. Without that variable set, the API refuses to run rather than running open. Sessions are
  HttpOnly, Secure, SameSite=Strict cookies signed with an HMAC; changing the password signs everyone out.
- **The server only calls models in the registry,** so a leaked session can't turn it into a general AI proxy for
  arbitrary models.
- **Stored on the phone:** job state (IndexedDB) and clips (the browser's private file storage). Deleting a job, or
  clearing the site's data in Chrome, removes them.

## If a key leaks

Delete it at build.nvidia.com (API Keys), generate a new one, put it in Vercel → Settings → Environment Variables,
then redeploy.

## Supported versions

Fixes land on `main`; Vercel deploys `main` automatically.
