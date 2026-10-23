import { instagramInsightsConnector } from "../instagram/connector"
import { twitchConnector } from "../twitch/connector"
import type { AnyConnector } from "../types"

/** Outside services from the sources-b track (design §12). The registry joins every track's connectors in a fixed order */
export const CONNECTORS: AnyConnector[] = [twitchConnector, instagramInsightsConnector]
