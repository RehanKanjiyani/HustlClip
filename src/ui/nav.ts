export type Route = { page: 'home' } | { page: 'job'; id: string }

export function parseRoute(): Route {
  const match = location.hash.match(/^#\/job\/([\w-]+)/)
  return match ? { page: 'job', id: match[1]! } : { page: 'home' }
}

export function navigate(route: Route) {
  location.hash = route.page === 'job' ? `#/job/${route.id}` : '#/'
}
