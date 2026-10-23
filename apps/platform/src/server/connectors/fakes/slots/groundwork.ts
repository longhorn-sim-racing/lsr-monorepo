import { anthropicFake } from "../../anthropic/fake/handlers"
import { exampleFake } from "../../example/fake/handlers"
import type { FakeService } from "../types"

/** HTTP fakes from the groundwork track (design §12), each from `connectors/<service>/fake/handlers.ts`. The fakes registry joins every track's in a fixed order */
export const FAKES: FakeService[] = [exampleFake, anthropicFake]
