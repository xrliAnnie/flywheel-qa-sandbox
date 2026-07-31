/**
 * FLY-1547 mailbox service — library surface. The runnable server lives in
 * server-main.ts (the package bin); importing this module has no side effects.
 */
export { createHostPort } from "./host-port.js";
export { type MailboxIdentity, resolveIdentity } from "./identity.js";
export {
	type DeliveryEnvelopeLike,
	type HostPort,
	MailboxService,
	type MailboxStatusShape,
	type NextResult,
} from "./service.js";
