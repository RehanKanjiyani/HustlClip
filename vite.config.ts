import type { IncomingMessage, ServerResponse } from 'node:http'

import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { type Plugin, type ViteDevServer, defineConfig } from 'vite'

/**
 * Serves api/*.ts during `npm run dev`, the same way Vercel does in
 * production, so the whole app runs locally with one command.
 */
function devApi(): Plugin {
  let server: ViteDevServer
  return {
    name: 'hustlclip-dev-api',
    configureServer(s) {
      server = s
      s.middlewares.use(async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        if (url.pathname === '/__dev/save' && req.method === 'POST' && process.env.HUSTLCLIP_DEV_SAVE) {
          try {
            const chunks: Buffer[] = []
            for await (const chunk of req) chunks.push(chunk as Buffer)
            const { writeFileSync } = await import('node:fs')
            const name = (url.searchParams.get('name') ?? 'out.bin').replace(/[^\w.-]/g, '_')
            writeFileSync(`${process.env.HUSTLCLIP_DEV_SAVE}/${name}`, Buffer.concat(chunks))
            res.end('saved')
          } catch {
            res.statusCode = 500
            res.end()
          }
          return
        }
        const match = url.pathname.match(/^\/api\/([a-z-]+)$/)
        if (!match) return next()
        try {
          const mod = (await server.ssrLoadModule(`/api/${match[1]}.ts`)) as Record<string, (r: Request) => Promise<Response>>
          const handler = mod[req.method ?? 'GET']
          if (!handler) {
            res.statusCode = 405
            res.end()
            return
          }
          const chunks: Buffer[] = []
          try {
            for await (const chunk of req) chunks.push(chunk as Buffer)
          } catch {
            return // client went away
          }
          const headers = new Headers()
          for (const [key, value] of Object.entries(req.headers)) {
            if (typeof value === 'string') headers.set(key, value)
            else if (Array.isArray(value)) headers.set(key, value.join(', '))
          }
          const request = new Request(`http://${req.headers.host}${req.url}`, {
            method: req.method,
            headers,
            body: ['GET', 'HEAD'].includes(req.method ?? 'GET') ? undefined : Buffer.concat(chunks),
          })
          const response = await handler(request)
          res.statusCode = response.status
          response.headers.forEach((value, key) => {
            // Local dev runs on http, where Secure cookies are dropped.
            res.setHeader(key, key === 'set-cookie' ? value.replace('; Secure', '') : value)
          })
          res.end(Buffer.from(await response.arrayBuffer()))
        } catch (error) {
          console.error(error)
          res.statusCode = 500
          res.end('dev api error')
        }
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), devApi()],
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
  server: { host: true, watch: { ignored: ['**/public/test-media/**', '**/public/wasm/**'] } },
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
} as Parameters<typeof defineConfig>[0])
