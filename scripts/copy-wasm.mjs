// Copies MediaPipe's WebAssembly runtime into public/wasm so the app serves it
// from its own origin (no third-party CDN at run time). Runs after npm install.
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const from = join('node_modules', '@mediapipe', 'tasks-vision', 'wasm')
const to = join('public', 'wasm')
if (!existsSync(from)) {
  console.warn('copy-wasm: @mediapipe/tasks-vision is not installed; skipping.')
  process.exit(0)
}
mkdirSync(to, { recursive: true })
for (const name of readdirSync(from)) {
  if (name.startsWith('vision_wasm_internal') || name.startsWith('vision_wasm_nosimd_internal')) {
    copyFileSync(join(from, name), join(to, name))
  }
}
console.log('copy-wasm: MediaPipe runtime copied to public/wasm')
