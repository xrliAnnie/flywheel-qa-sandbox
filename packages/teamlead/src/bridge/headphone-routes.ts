import express from "express";
import type { SpeakReceipt } from "flywheel-voice-core";
import type {
	HeadphoneInboxItemRecord,
	HeadphoneInboxStore,
} from "./headphone-inbox.js";

export interface HeadphoneRouteSession {
	sessionId: string;
	projectName: string;
	sessionGeneration: number;
	leaseToken: string | null;
	leaseExpiresAt: string | null;
	state: string;
}

export interface HeadphoneRouterDeps {
	inbox: HeadphoneInboxStore;
	founderUserId: string;
	getSession(sessionId: string): HeadphoneRouteSession | undefined;
	now?: () => Date;
}

function exactObject(
	value: unknown,
	keys: readonly string[],
): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return;
	const record = value as Record<string, unknown>;
	if (Object.keys(record).some((key) => !keys.includes(key))) return;
	return record;
}

function completedReceipt(value: unknown): SpeakReceipt | undefined {
	const receipt = exactObject(value, [
		"outcome",
		"pendingKey",
		"requestDigest",
		"transport",
		"contentProof",
	]);
	if (
		!receipt ||
		receipt.outcome !== "completed" ||
		typeof receipt.pendingKey !== "string" ||
		typeof receipt.requestDigest !== "string" ||
		(receipt.transport !== "submitted" &&
			receipt.transport !== "playback_drained") ||
		(receipt.contentProof !== "deterministic_tts" &&
			receipt.contentProof !== "transcript_equivalent")
	)
		return;
	return receipt as SpeakReceipt;
}

function publicHeadphoneItem(item: HeadphoneInboxItemRecord) {
	return {
		id: item.itemId,
		revision: item.revision,
		createdAt: item.sourceCreatedAt,
		needsDecision: item.needsDecision,
		text: item.text,
		...(item.speechBrief ? { speechBrief: item.speechBrief } : {}),
	};
}

export function createHeadphoneRouter(
	deps: HeadphoneRouterDeps,
): express.Router {
	const router = express.Router();
	const now = deps.now ?? (() => new Date());
	const authorize = (
		sessionId: unknown,
		generation: unknown,
		leaseToken: unknown,
	): HeadphoneRouteSession | undefined => {
		if (
			typeof sessionId !== "string" ||
			!Number.isSafeInteger(generation) ||
			typeof leaseToken !== "string"
		)
			return;
		const session = deps.getSession(sessionId);
		if (
			!session ||
			session.sessionGeneration !== generation ||
			session.leaseToken !== leaseToken ||
			!session.leaseExpiresAt ||
			Date.parse(session.leaseExpiresAt) <= now().getTime() ||
			!(session.state === "warming" || session.state === "live")
		)
			return;
		return session;
	};

	router.get("/", (req, res) => {
		const generation = Number(req.query.generation);
		const session = authorize(
			req.query.sessionId,
			generation,
			req.headers["x-voice-lease"],
		);
		if (!session) {
			res.status(403).json({ error: "headphone_session_unauthorized" });
			return;
		}
		const limit = req.query.limit === undefined ? 100 : Number(req.query.limit);
		try {
			const cursor =
				typeof req.query.cursor === "string" ? req.query.cursor : undefined;
			if (cursor && cursor.length > 4096)
				throw new Error("headphone_inbox_cursor_invalid");
			const snapshot = deps.inbox.snapshot({
				projectName: session.projectName,
				founderUserId: deps.founderUserId,
				limit,
				...(cursor ? { cursor } : {}),
			});
			const items = snapshot.items.map(publicHeadphoneItem);
			res.json({
				snapshotId: snapshot.snapshotId,
				highWatermark: snapshot.highWatermark,
				sourceStatus: snapshot.sourceStatus,
				nextCursor: snapshot.nextCursor,
				items,
			});
		} catch (error) {
			res.status(400).json({ error: (error as Error).message });
		}
	});

	router.post("/claim", (req, res) => {
		const body = exactObject(req.body, [
			"sessionId",
			"generation",
			"itemId",
			"revision",
		]);
		if (!body) {
			res.status(400).json({ error: "headphone_claim_invalid" });
			return;
		}
		const leaseToken = req.headers["x-voice-lease"];
		const session = authorize(body.sessionId, body.generation, leaseToken);
		if (!session) {
			res.status(403).json({ error: "headphone_session_unauthorized" });
			return;
		}
		try {
			const claim = deps.inbox.claim({
				itemId: String(body.itemId ?? ""),
				revision: Number(body.revision),
				sessionId: session.sessionId,
				generation: session.sessionGeneration,
				leaseToken: String(leaseToken),
				founderUserId: deps.founderUserId,
				now: now().toISOString(),
			});
			if (!claim) {
				res.status(409).json({ error: "headphone_item_unavailable" });
				return;
			}
			res.json({ ...claim, item: publicHeadphoneItem(claim.item) });
		} catch (error) {
			const message = (error as Error).message;
			res
				.status(message.endsWith("unauthorized") ? 403 : 400)
				.json({ error: message });
		}
	});

	router.post("/ack", (req, res) => {
		const body = exactObject(req.body, [
			"sessionId",
			"generation",
			"itemId",
			"revision",
			"claimToken",
			"receipts",
		]);
		if (!body) {
			res.status(400).json({ error: "headphone_ack_invalid" });
			return;
		}
		const session = authorize(
			body.sessionId,
			body.generation,
			req.headers["x-voice-lease"],
		);
		if (!session) {
			res.status(403).json({ error: "headphone_session_unauthorized" });
			return;
		}
		try {
			const receipts = Array.isArray(body.receipts)
				? body.receipts.map(completedReceipt)
				: [];
			if (receipts.some((receipt) => receipt === undefined)) {
				res.status(400).json({ error: "headphone_ack_invalid" });
				return;
			}
			const ok = deps.inbox.ack({
				itemId: String(body.itemId ?? ""),
				revision: Number(body.revision),
				sessionId: session.sessionId,
				generation: session.sessionGeneration,
				leaseToken: String(req.headers["x-voice-lease"]),
				founderUserId: deps.founderUserId,
				claimToken: String(body.claimToken ?? ""),
				receipts: receipts as SpeakReceipt[],
				ackedAt: now().toISOString(),
			});
			if (!ok) {
				res.status(409).json({ error: "headphone_ack_conflict" });
				return;
			}
			res.json({ acked: true });
		} catch (error) {
			res.status(400).json({ error: (error as Error).message });
		}
	});

	router.get("/source-health", (req, res) => {
		const session = authorize(
			req.query.sessionId,
			Number(req.query.generation),
			req.headers["x-voice-lease"],
		);
		if (!session) {
			res.status(403).json({ error: "headphone_session_unauthorized" });
			return;
		}
		res.json({
			sources: deps.inbox.listSourceState(
				session.projectName,
				deps.founderUserId,
			),
		});
	});

	return router;
}
