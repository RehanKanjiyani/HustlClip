/**
 * Pulling one JSON object out of a model's reply.
 *
 * Models wrap JSON in prose, code fences, or inline reasoning blocks; some
 * append a second object. This finds the first balanced top-level object
 * after removing reasoning, which is the only part the software trusts.
 */

export function stripReasoning(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^[\s\S]*?<\/think>/i, '')
}

export function extractJsonObject(text: string): Record<string, unknown> {
  const cleaned = stripReasoning(text)
  let start = cleaned.indexOf('{')
  while (start >= 0) {
    const end = balancedEnd(cleaned, start)
    if (end > start) {
      const candidate = cleaned.slice(start, end + 1)
      try {
        const parsed = JSON.parse(candidate)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
      } catch {
        // Try repairing trailing commas, a common slip.
        try {
          const parsed = JSON.parse(candidate.replace(/,\s*([}\]])/g, '$1'))
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
        } catch {
          // fall through to the next "{"
        }
      }
    }
    start = cleaned.indexOf('{', start + 1)
  }
  throw new Error('no JSON object found in the response')
}

/**
 * Recovers the complete items of a JSON array from a reply that was cut off
 * mid-way (a model hit its output limit). Finds `"key": [` for the first key
 * present and returns every fully closed `{...}` element before the cut.
 */
export function salvageArray(text: string, keys: string[]): { key: string; items: Record<string, unknown>[] } | null {
  const cleaned = stripReasoning(text)
  for (const key of keys) {
    const match = new RegExp(`"${key}"\\s*:\\s*\\[`).exec(cleaned)
    if (!match) continue
    const items: Record<string, unknown>[] = []
    let pos = match.index + match[0].length
    for (;;) {
      const start = cleaned.indexOf('{', pos)
      if (start < 0) break
      const close = cleaned.indexOf(']', pos)
      if (close >= 0 && close < start) break
      const end = balancedEnd(cleaned, start)
      if (end < 0) break
      try {
        const item = JSON.parse(cleaned.slice(start, end + 1))
        if (item && typeof item === 'object' && !Array.isArray(item)) items.push(item as Record<string, unknown>)
      } catch {
        break
      }
      pos = end + 1
    }
    if (items.length) return { key, items }
  }
  return null
}

function balancedEnd(text: string, start: number): number {
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}
