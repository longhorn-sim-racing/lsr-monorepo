import { teamsWebhookConnector } from "../teams-webhook/connector"
import type { AnyConnector } from "../types"

/** Outside services from the automation track (design §12). The registry joins every track's connectors in a fixed order */
export const CONNECTORS: AnyConnector[] = [teamsWebhookConnector]
