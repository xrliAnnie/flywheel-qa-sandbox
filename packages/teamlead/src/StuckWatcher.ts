/** @deprecated Use HeartbeatService instead (GEO-157). */

export type { HeartbeatNotifier as StuckNotifier } from "./HeartbeatService.js";
export {
	HeartbeatService as StuckWatcher,
	RegistryHeartbeatNotifier as WebhookStuckNotifier,
} from "./HeartbeatService.js";
