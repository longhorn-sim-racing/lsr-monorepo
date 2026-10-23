import { FAKE_SERVICE_ID } from "../base-url"
import { FakeNetworkError, type FakeRoute, type FakeService } from "./types"

/** Answers one request to the fakes: "/<service>/<the real API's path>" goes to that service's routes */
export type FakeRouter = (request: Request) => Promise<Response>

type Mounted = { id: string; routes: { route: FakeRoute; segments: string[] }[] }

const segmentsOf = (path: string) => path.split("/").filter(Boolean)

function decode(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

/** The route's params when its path matches, or null */
function matchPath(pattern: string[], path: string[]): Record<string, string> | null {
  const params: Record<string, string> = {}
  for (let i = 0; i < pattern.length; i++) {
    const part = pattern[i]
    if (part === "*" && i === pattern.length - 1) {
      params["*"] = path.slice(i).map(decode).join("/")
      return params
    }
    if (i >= path.length) return null
    if (part.startsWith(":")) params[part.slice(1)] = decode(path[i])
    else if (part !== decode(path[i])) return null
  }
  return pattern.length === path.length ? params : null
}

const problem = (status: number, error: string, headers?: HeadersInit) => Response.json({ fake: true, error }, { status, headers })

/**
 * Builds each service's fake (fresh state) and routes requests to it. Unknown paths get 404 and a
 * known path with the wrong method 405, both saying they came from the fake; "/" lists what's mounted.
 * A handler that throws gets a 500, except FakeNetworkError, which is passed on so the caller can drop
 * the connection.
 */
export function createFakeRouter(services: readonly FakeService[]): FakeRouter {
  const mounted = new Map<string, Mounted>()
  for (const service of services) {
    if (!FAKE_SERVICE_ID.test(service.id)) throw new Error(`Fake "${service.id}": a fake's id is lowercase letters, digits and dashes`)
    if (mounted.has(service.id)) throw new Error(`Two fakes are called "${service.id}"`)
    mounted.set(service.id, { id: service.id, routes: service.create().map((route) => ({ route, segments: segmentsOf(route.path) })) })
  }

  return async (request) => {
    const url = new URL(request.url)
    const [first, ...rest] = segmentsOf(url.pathname)
    if (!first) {
      return Response.json({
        fake: true,
        services: [...mounted.values()].map((service) => ({ id: service.id, routes: service.routes.map(({ route }) => `${route.method} /${service.id}${route.path}`) })),
      })
    }
    if (first === "_health") return Response.json({ ok: true })

    const service = mounted.get(first)
    if (!service) return problem(404, `No fake is mounted at /${first}. Mounted: ${[...mounted.keys()].join(", ") || "none"}`)

    const path = `/${rest.join("/")}`
    const allowed = new Set<string>()
    for (const { route, segments } of service.routes) {
      const params = matchPath(segments, rest)
      if (!params) continue
      if (route.method !== "*" && route.method !== request.method) {
        allowed.add(route.method)
        continue
      }
      try {
        return await route.handle(request, { params, path, baseUrl: `${url.origin}/${service.id}` })
      } catch (error) {
        if (error instanceof FakeNetworkError) throw error
        console.error(`[fakes] ${request.method} /${service.id}${path} threw:`, error)
        return problem(500, `The ${service.id} fake failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (allowed.size) return problem(405, `The ${service.id} fake doesn't take ${request.method} ${path}`, { Allow: [...allowed].join(", ") })
    return problem(404, `The ${service.id} fake has no route for ${request.method} ${path}`)
  }
}
