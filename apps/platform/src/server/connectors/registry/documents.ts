import type { AnyConnector } from "../types"

/** Outside services from the documents track (design §12). The registry joins every track's connectors in a fixed order */
export const CONNECTORS: AnyConnector[] = []
