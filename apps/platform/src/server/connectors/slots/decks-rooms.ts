import { instagramPublishConnector } from "../instagram/publish-connector"
import type { AnyConnector } from "../types"

/** Outside services from the decks-rooms track (design §12). The registry joins every track's connectors in a fixed order */
export const CONNECTORS: AnyConnector[] = [instagramPublishConnector]
