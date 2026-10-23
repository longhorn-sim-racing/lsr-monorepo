import type { FakeService } from "../types"

/** HTTP fakes from the sources-a track (design §12), each from `connectors/<service>/fake/handlers.ts`. The fakes registry joins every track's in a fixed order */
export const FAKES: FakeService[] = []
