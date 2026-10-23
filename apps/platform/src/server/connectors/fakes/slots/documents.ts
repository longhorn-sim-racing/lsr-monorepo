import { googleDriveFake } from "../../google-drive/fake/handlers"
import { microsoftGraphFake } from "../../microsoft/fake/handlers"
import type { FakeService } from "../types"

/** HTTP fakes from the documents track (design §12), each from `connectors/<service>/fake/handlers.ts`. The fakes registry joins every track's in a fixed order */
export const FAKES: FakeService[] = [googleDriveFake, microsoftGraphFake]
