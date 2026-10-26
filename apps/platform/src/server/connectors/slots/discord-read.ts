import { discordConnector } from "../discord/connector"
import type { AnyConnector } from "../types"

/** Outside services from the discord-read track (design §12). The registry joins every track's connectors in a fixed order */
export const CONNECTORS: AnyConnector[] = [discordConnector]
