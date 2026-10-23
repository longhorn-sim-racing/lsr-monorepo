import { resendConnector } from "../resend/connector"
import { siteTrafficConnector } from "../site-traffic/connector"
import { stripeConnector } from "../stripe/connector"
import type { AnyConnector } from "../types"

/** Outside services from the sources-a track (design §12): Stripe (read only), Resend delivery events and site traffic. The registry joins every track's connectors in a fixed order */
export const CONNECTORS: AnyConnector[] = [stripeConnector, resendConnector, siteTrafficConnector]
