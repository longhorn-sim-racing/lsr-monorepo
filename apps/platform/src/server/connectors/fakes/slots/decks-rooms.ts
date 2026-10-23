import { cloudinaryFake } from "../../cloudinary/fake/handlers"
import type { FakeService } from "../types"

/**
 * HTTP fakes from the decks-rooms track (design §12), each from `connectors/<service>/fake/handlers.ts`. The fakes registry joins every track's in a fixed order.
 * Instagram publishing's routes live in the Instagram fake (sources-b's slot); Cloudinary's is here.
 */
export const FAKES: FakeService[] = [cloudinaryFake]
