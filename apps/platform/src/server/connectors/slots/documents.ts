import { googleDriveConnector } from "../google-drive/connector"
import { sharePointConnector } from "../sharepoint/connector"
import { teamsConnector } from "../teams/connector"
import type { AnyConnector } from "../types"

/** Outside services from the documents track (design §12.7, §12.8). The registry joins every track's connectors in a fixed order */
export const CONNECTORS: AnyConnector[] = [googleDriveConnector, sharePointConnector, teamsConnector]
