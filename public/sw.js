// HustlClip service worker.
//
// Its one job is Android's share sheet: when you share a video to HustlClip
// (for example from Seal), Android POSTs it to /share. The worker keeps the
// file in a private cache and opens the app, which picks it up from there.
// Nothing is uploaded anywhere.

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  if (event.request.method === 'POST' && url.pathname === '/share') {
    event.respondWith(receiveShare(event.request))
  }
})

async function receiveShare(request) {
  try {
    const form = await request.formData()
    const file = form.get('video')
    if (file && typeof file !== 'string') {
      const cache = await caches.open('hustlclip-share')
      await cache.put(
        '/shared-video',
        new Response(file, {
          headers: {
            'content-type': file.type || 'video/mp4',
            'x-file-name': encodeURIComponent(file.name || 'shared-video.mp4'),
            'x-file-modified': String(file.lastModified || Date.now()),
          },
        }),
      )
    }
  } catch (error) {
    // Fall through to the app, which explains how to pick the file manually.
  }
  return Response.redirect('/?shared=1', 303)
}
