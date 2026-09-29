/**
 * Drawing one output frame: the layout (crop, stack, split, fit) and the
 * burned-in captions, onto a 1080x1920 canvas.
 */

import type { VideoSample } from 'mediabunny'

import { type CaptionGroup, type CaptionStyle, groupAt } from '../engine/captions'
import { type LayoutSegment, type Rect, SPLIT_CAM_SHARE, cropAt } from '../engine/reframe'

export const OUT_W = 1080
export const OUT_H = 1920

type Ctx = OffscreenCanvasRenderingContext2D

let fontsReady: Promise<void> | null = null

/** Caption fonts are served by the app itself, so rendering never waits on the network. */
export function loadCaptionFonts(): Promise<void> {
  fontsReady ??= (async () => {
    const faces = [
      new FontFace('Anton', 'url(/fonts/Anton-Regular.ttf)'),
      new FontFace('Inter', 'url(/fonts/Inter-Variable.ttf)', { weight: '100 900' }),
    ]
    for (const face of faces) {
      try {
        await face.load()
        document.fonts.add(face)
      } catch {
        // A missing font falls back to the system font; captions still render.
      }
    }
  })()
  return fontsReady
}

function drawRect(ctx: Ctx, sample: VideoSample, src: Rect, dx: number, dy: number, dw: number, dh: number) {
  sample.draw(ctx, src.x, src.y, src.w, src.h, dx, dy, dw, dh)
}

let blurCanvas: OffscreenCanvas | null = null

export function drawLayout(ctx: Ctx, sample: VideoSample, seg: LayoutSegment, t: number, sourceW: number, sourceH: number) {
  switch (seg.layout) {
    case 'crop': {
      const { x, y } = cropAt(seg, t)
      drawRect(ctx, sample, { x, y, w: seg.cropW!, h: seg.cropH! }, 0, 0, OUT_W, OUT_H)
      return
    }
    case 'stack': {
      const half = OUT_H / 2
      drawRect(ctx, sample, seg.top!, 0, 0, OUT_W, half)
      drawRect(ctx, sample, seg.bottom!, 0, half, OUT_W, half)
      ctx.fillStyle = '#000'
      ctx.fillRect(0, half - 3, OUT_W, 6)
      return
    }
    case 'split': {
      const camH = Math.round(OUT_H * SPLIT_CAM_SHARE)
      drawRect(ctx, sample, seg.cam!, 0, 0, OUT_W, camH)
      drawRect(ctx, sample, seg.main!, 0, camH, OUT_W, OUT_H - camH)
      ctx.fillStyle = '#000'
      ctx.fillRect(0, camH - 3, OUT_W, 6)
      return
    }
    case 'fit': {
      // Blurred fill: draw tiny, then scale up with a blur. Cheap on phones.
      blurCanvas ??= new OffscreenCanvas(54, 96)
      const small = blurCanvas.getContext('2d')!
      const coverScale = Math.max(54 / sourceW, 96 / sourceH)
      const cw = 54 / coverScale
      const ch = 96 / coverScale
      sample.draw(small, (sourceW - cw) / 2, (sourceH - ch) / 2, cw, ch, 0, 0, 54, 96)
      ctx.filter = 'blur(12px) brightness(0.6)'
      ctx.drawImage(blurCanvas, -40, -40, OUT_W + 80, OUT_H + 80)
      ctx.filter = 'none'
      const h = (OUT_W / sourceW) * sourceH
      drawRect(ctx, sample, { x: 0, y: 0, w: sourceW, h: sourceH }, 0, (OUT_H - h) / 2, OUT_W, h)
      return
    }
  }
}

// ---------------------------------------------------------------------------
// captions
// ---------------------------------------------------------------------------

interface Line {
  words: { text: string; width: number; index: number }[]
  width: number
}

const layoutCache = new WeakMap<CaptionGroup, Line[]>()

function font(style: CaptionStyle, size: number): string {
  return `${style.weight} ${size}px ${style.font}, "Noto Sans Devanagari", "Noto Sans", sans-serif`
}

function wordText(text: string, style: CaptionStyle): string {
  return style.allCaps ? text.toLocaleUpperCase() : text
}

function layoutGroup(ctx: Ctx, group: CaptionGroup, style: CaptionStyle, size: number): Line[] {
  const cached = layoutCache.get(group)
  if (cached) return cached
  ctx.font = font(style, size)
  const space = ctx.measureText(' ').width
  const maxWidth = OUT_W * 0.86
  const lines: Line[] = []
  let line: Line = { words: [], width: 0 }
  group.words.forEach((w, index) => {
    const text = wordText(w.text, style)
    const width = ctx.measureText(text).width
    const next = line.words.length ? line.width + space + width : width
    if (line.words.length && next > maxWidth) {
      lines.push(line)
      line = { words: [], width: 0 }
    }
    line.width = line.words.length ? line.width + space + width : width
    line.words.push({ text, width, index })
  })
  if (line.words.length) lines.push(line)
  layoutCache.set(group, lines)
  return lines
}

export function drawCaptions(ctx: Ctx, groups: CaptionGroup[], t: number, style: CaptionStyle) {
  if (style.key === 'none') return
  const g = groupAt(groups, t)
  if (g < 0) return
  const group = groups[g]!
  const size = Math.round(OUT_H * style.sizeRatio)
  const lines = layoutGroup(ctx, group, style, size)
  const lineHeight = size * 1.18
  const space = (ctx.font = font(style, size), ctx.measureText(' ').width)
  const bottom = OUT_H * (1 - style.marginRatio)
  const top = bottom - lineHeight * lines.length

  ctx.textBaseline = 'alphabetic'
  ctx.lineJoin = 'round'
  ctx.miterLimit = 2

  lines.forEach((line, li) => {
    const baseline = top + lineHeight * (li + 1) - size * 0.2
    let x = (OUT_W - line.width) / 2
    if (style.boxed) {
      ctx.fillStyle = style.boxColour
      const pad = size * 0.22
      ctx.beginPath()
      ctx.roundRect(x - pad, baseline - size * 0.95, line.width + pad * 2, size * 1.2, size * 0.12)
      ctx.fill()
    }
    for (const w of line.words) {
      const word = group.words[w.index]!
      const active = t >= word.start && t < (group.words[w.index + 1]?.start ?? group.end)
      const cx = x + w.width / 2
      const scale = active && style.animation === 'scale' ? style.scale : 1
      ctx.save()
      ctx.translate(cx, baseline)
      ctx.scale(scale, scale)
      ctx.font = font(style, size)
      ctx.textAlign = 'center'
      if (style.shadow) {
        ctx.shadowColor = 'rgba(0,0,0,0.55)'
        ctx.shadowBlur = size * 0.12
        ctx.shadowOffsetY = size * 0.05
      }
      if (style.outlineRatio > 0) {
        ctx.lineWidth = size * style.outlineRatio
        ctx.strokeStyle = style.outline
        ctx.strokeText(w.text, 0, 0)
        ctx.shadowColor = 'transparent'
      }
      if (style.animation === 'karaoke' && style.accent) {
        // Fill sweeps across the word over its spoken duration.
        const progress = Math.max(0, Math.min(1, (t - word.start) / Math.max(0.05, word.end - word.start)))
        ctx.fillStyle = style.primary
        ctx.fillText(w.text, 0, 0)
        if (progress > 0) {
          ctx.save()
          ctx.beginPath()
          ctx.rect(-w.width / 2, -size * 1.2, w.width * progress, size * 1.6)
          ctx.clip()
          ctx.fillStyle = style.accent
          ctx.fillText(w.text, 0, 0)
          ctx.restore()
        }
      } else {
        ctx.fillStyle = active && style.accent ? style.accent : style.primary
        ctx.fillText(w.text, 0, 0)
      }
      ctx.restore()
      x += w.width + space
    }
  })
}
