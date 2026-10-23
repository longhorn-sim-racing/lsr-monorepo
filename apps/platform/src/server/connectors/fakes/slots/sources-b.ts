import { instagramFake } from "../../instagram/fake/handlers"
import { twitchFake } from "../../twitch/fake/handlers"
import type { FakeService } from "../types"

/** HTTP fakes from the sources-b track (design §12), each from `connectors/<service>/fake/handlers.ts`. The fakes registry joins every track's in a fixed order */
export const FAKES: FakeService[] = [twitchFake, instagramFake]
