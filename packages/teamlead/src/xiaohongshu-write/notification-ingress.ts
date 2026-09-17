import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { parseStrictJson } from "./canonical.js";
import { createNativePeerReader } from "./native-peer.js";
import {
	notificationInputs,
	notificationResponses,
} from "./notification-contract.js";
import type { XhsWriteStore } from "./store.js";

const id = z.string().min(1).max(256);
const envelope = z
	.object({ projectId: id, leadId: id, activationId: id, input: z.unknown() })
	.strict();
/** Non-authorizing delivery projection. Scope comes from native peer and root
 * registry, independently of provider login, account epoch and write admission.
 * ACK records delivery only; it cannot mint, consume or extend a receipt. */
export function createNotificationIngressHandler(options: {
	modelUid: number;
	peerHelper: { path: string; sha256: string };
	registry: readonly { projectId: string; leadId: string }[];
	store: Pick<
		XhsWriteStore,
		"bridgeNotifications" | "ackBridgeNotification" | "expireProposals"
	>;
	assertCurrent: () => void;
	now?: () => number;
}) {
	const registry = structuredClone(options.registry);
	const readPeer = createNativePeerReader(options.peerHelper);
	return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
		const controller = new AbortController();
		const abort = () => controller.abort();
		req.once("aborted", abort);
		res.once("close", abort);
		const timer = setTimeout(() => {
			abort();
			req.destroy();
			res.destroy();
		}, 30000);
		const current = () => {
			controller.signal.throwIfAborted();
			if (req.socket.destroyed) throw Error();
			options.assertCurrent();
		};
		const reply = (status: number, body: unknown) => {
			if (res.destroyed || res.headersSent) return;
			const json = JSON.stringify(body);
			if (Buffer.byteLength(json) > 65536) throw Error();
			res.writeHead(status, {
				"content-type": "application/json",
				"cache-control": "no-store",
			});
			res.end(json);
		};
		try {
			current();
			const peerUid = await readPeer(req.socket, controller.signal);
			current();
			if (
				peerUid !== options.modelUid ||
				req.method !== "POST" ||
				req.headers["content-type"] !== "application/json" ||
				!["/v1/notification/list", "/v1/notification/ack"].includes(
					req.url ?? "",
				)
			)
				throw Error();
			let size = 0;
			const chunks: Buffer[] = [];
			for await (const chunk of req.iterator({ destroyOnReturn: false })) {
				current();
				const bytes = Buffer.from(chunk);
				size += bytes.length;
				if (size > 4096) throw Error();
				chunks.push(bytes);
			}
			const body = envelope.parse(
				parseStrictJson(
					new TextDecoder("utf-8", { fatal: true }).decode(
						Buffer.concat(chunks),
					),
				),
			);
			current();
			if (
				!registry.some(
					(entry) =>
						entry.projectId === body.projectId && entry.leadId === body.leadId,
				)
			)
				throw Error();
			const scope = {
				requesterUid: peerUid,
				projectId: body.projectId,
				leadId: body.leadId,
			};
			if (req.url === "/v1/notification/ack") {
				const input = notificationInputs.notification_ack.parse(body.input);
				options.store.ackBridgeNotification(input.eventId, scope);
				reply(200, { acknowledged: true });
			} else {
				notificationInputs.notifications.parse(body.input);
				options.store.expireProposals((options.now ?? Date.now)());
				const events = options.store
					.bridgeNotifications(scope)
					.map(
						({
							eventId,
							eventKind,
							receiptId,
							proposalId,
							contentDigest,
							expiry,
						}) => ({
							eventId,
							eventKind,
							receiptId,
							proposalId,
							contentDigest,
							expiry,
						}),
					);
				reply(200, notificationResponses.notifications.parse({ events }));
			}
		} catch {
			reply(403, { code: "notification_ingress_denied" });
		} finally {
			clearTimeout(timer);
			req.off("aborted", abort);
			res.off("close", abort);
		}
	};
}
