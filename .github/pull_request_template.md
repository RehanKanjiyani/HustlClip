## What this changes

<!-- And why. If it fixes an issue, link it. -->

## How you verified it

<!-- "Tests pass" is not verification on its own. Say what you actually ran, ideally on a real video. -->

- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `npm run build`
- [ ] Ran a real video through `npm run dev` (required for anything touching media, captions or framing)

## If you touched the pipeline

- [ ] **Framing:** no visible jitter, no cut-off faces, the speaker on screen for essentially all of their speaking time.
- [ ] **AI steps:** models still return word indices only; code owns timing, count and selection.
- [ ] **Resume:** a job interrupted at the changed step resumes without redoing earlier steps.
