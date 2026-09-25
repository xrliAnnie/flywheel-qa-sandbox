import {
	createHash,
	randomBytes,
	randomUUID,
	timingSafeEqual,
} from "node:crypto";
import express from "express";
import { chatDeliveryId } from "flywheel-comm/discord-chat-ingest";
import {
	AGENDA_DISPOSITIONS,
	AGENDA_PURPOSES,
	type AgendaBriefPurpose,
	type AgendaClass,
	type AgendaDispositionRecord,
	type AgendaItem,
	type AgendaItemMaterial,
	type AgendaSnapshot,
	type AgendaState,
	type VoiceAgendaResultPayload,
	validateAgendaSay,
} from "flywheel-voice-core";
import type { VoiceAgendaStore } from "./voice-agenda-store.js";
import type {
	VoiceHandoffAgenda,
	VoiceHandoffRecord,
	VoiceHandoffStore,
} from "./voice-handoff-store.js";
import type { VoiceReplyNotifier } from "./voice-reply-notifier.js";

const KEY = /^[A-Za-z0-9_.:@+-]{1,256}$/u;
const CLIENT_ID = /^[A-Za-z0-9_.:-]{1,128}$/u;
const MAX_SAY_TEXT = 2_000;

export interface VoiceAgendaRouteSession {
	sessionId: string;
	mode: "rg" | "meeting";
	projectName: string;
	leadId: string;
	sessionGeneration: number;
	leaseToken: string | null;
	leaseExpiresAt: string | null;
	state: string;
}

export interface VoiceAgendaRouterDeps {
	agenda: VoiceAgendaStore;
	handoffs: VoiceHandoffStore;
	replyNotifier: VoiceReplyNotifier;
	founderUserId: string;
	getSession(sessionId: string): VoiceAgendaRouteSession | undefined;
	buildSnapshot(session: VoiceAgendaRouteSession): AgendaSnapshot;
	/** Deliver an authorized brief to the Lead's mailbox. */
	dispatchBrief(record: VoiceHandoffRecord): Promise<"committed" | "rejected">;
	/** Durable Lead→founder audit row for a result; returns its delivery id. */
	recordLeadResult(
		record: VoiceHandoffRecord,
		input: { resultEventId: string; text: string },
	): string;
	/** Snowflake to deliver briefs as: a voice/Bridge bot, never the founder. */
	briefAuthorId(session: VoiceAgendaRouteSession): string | undefined;
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

const text = (value: unknown, max: number): value is string =>
	typeof value === "string" && value.trim().length > 0 && value.length <= max;

/** The answer key proves the caller read this Lead's own delivery. */
function keyMatches(given: unknown, expected: string): boolean {
	if (typeof given !== "string" || given.length !== expected.length)
		return false;
	return timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

function digest(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

const CLASS_WORD: Record<AgendaClass, string> = {
	blocked: "受阻",
	awaiting_approval: "待批",
	needs_answer: "要你答",
	lead_said: "Lead 主动说的",
};

const PURPOSE_GUIDE: Record<AgendaBriefPurpose, string> = {
	open: "开场：一两句先说有几件要她拍、每件一句点出是什么，然后说「先从 X 说起」并直接进入那一件（--item X，可以是下面任意一件；--order 可选，带就排全）。没有事就自然说一句或不说。不要逐件展开，不要念清单。",
	item: "只说这一件：发生了什么、要她做什么（授权 / 批 / 改 / 看一眼）。待批的用三五句讲 QA、设计、测试，或问她要不要自己看设计卡（链接用文字发到 thread，不念 URL）。受阻的说卡在哪、要她给什么。依据看 material；没有的不编，直说「详情在讨论串里」。",
	urgent:
		"插播急事：先说「插一句急的」，讲清楚要她马上做什么。结束后模式层会让你带回原来那件。",
	resume: "把她带回当前这一件：一句话提醒刚才谈到哪里、还要她做什么。",
	checkin:
		"报平安：一两句闲聊或平安话；有她还没回应的事可以轻轻提一句「X 还在等你，不急」。不要罗列状态。",
};

/** The brief the Lead reads. It is a request to the Lead, not founder speech. */
export function renderAgendaBriefText(input: {
	requestId: string;
	answerKey: string;
	purpose: AgendaBriefPurpose;
	itemKey: string | null;
	brief: Record<string, unknown>;
}): string {
	const itemFlag = input.itemKey ?? "none";
	const lines = [
		`【语音议程·${input.purpose}】request=${input.requestId}（语音模式层发给你的请求，不是 founder 说的话；你想好的话会原样念给她听）`,
		PURPOSE_GUIDE[input.purpose],
		"口语规则：单号按数字念（二七九六）；不念 URL、markdown、代码、路径、状态流水；不编造，没做的事不说做了；不说「已批准」。",
		`写好后运行：flywheel-comm voice agenda say --request ${input.requestId} --key ${input.answerKey} --item ${itemFlag}${input.purpose === "open" ? " [--order k1,k2,…]" : ""} --text "<要说的话>"`,
		...(input.purpose === "checkin" || input.purpose === "open"
			? []
			: [
					`她拍板后：能用现有权限办完的先办，再 flywheel-comm voice agenda close --request <她那句话的 handoff> --key <那条消息里的 key> --item ${itemFlag} --disposition resolved --evidence <依据> --reason "<记给台账的一句>" --say "<她拍完听到的一句>"；ship 批准办不了就用 decision_recorded，--say 如实请她在 thread 点；她说回头再看用 deferred。--say 必填，--reason 不念。`,
				]),
		"完整规则：packages/teamlead/lead-rules-base/runbooks/voice-agenda.md",
		"议程数据（给你读，不要原样念给她）：",
		JSON.stringify(input.brief, null, 1),
	];
	return lines.join("\n");
}

function classCounts(
	keys: readonly string[],
	state: AgendaState | undefined,
): Record<AgendaClass, number> {
	const counts: Record<AgendaClass, number> = {
		blocked: 0,
		awaiting_approval: 0,
		needs_answer: 0,
		lead_said: 0,
	};
	for (const key of keys) {
		const cls = state?.items[key]?.item.class;
		if (cls) counts[cls] += 1;
	}
	return counts;
}

function clip(value: string, max: number): string {
	const chars = Array.from(value);
	return chars.length > max ? chars.slice(0, max).join("") : value;
}

/** QA@1 B4: the opening lists every item in a sentence each, so it gets a
 * compact copy; an item brief gets everything the Bridge knows. */
function briefMaterial(
	material: AgendaItemMaterial,
	detail: "compact" | "full",
): AgendaItemMaterial {
	if (detail === "full") return material;
	return {
		...(material.question ? { question: clip(material.question, 200) } : {}),
		...(material.qa
			? { qa: { ...material.qa, summary: clip(material.qa.summary, 300) } }
			: {}),
		...(material.blocked ? { blocked: material.blocked } : {}),
		...(material.prNumber !== undefined ? { prNumber: material.prNumber } : {}),
	};
}

function briefItem(
	item: AgendaItem,
	detail: "compact" | "full",
): Record<string, unknown> {
	return {
		itemKey: item.itemKey,
		class: CLASS_WORD[item.class],
		project: item.projectName,
		lead: item.leadId,
		issue: item.issueIdentifier,
		title: item.issueTitle,
		thread: item.threadUrl,
		since: item.since,
		...(item.urgent ? { urgent: item.urgent.reason } : {}),
		...(item.sourceText ? { leadMessage: item.sourceText } : {}),
		...(item.material
			? { material: briefMaterial(item.material, detail) }
			: {}),
	};
}

/** The voice client needs keys, classes and spoken facts, never the Lead's
 * material (QA@1 B4). */
function clientSnapshot(snapshot: AgendaSnapshot): AgendaSnapshot {
	return {
		...snapshot,
		items: snapshot.items.map(({ material: _material, ...item }) => item),
	};
}

/**
 * FLY-2863 plan §2-§4 Bridge face: snapshot, brief requests, turn bindings,
 * durable CAS state, and structured Lead results. Every client call is bound
 * to a live lease; scope, target Lead and item bodies are server-derived.
 */
export function createVoiceAgendaRouter(deps: VoiceAgendaRouterDeps): {
	sessionRouter: express.Router;
	leadRouter: express.Router;
} {
	const sessionRouter = express.Router();
	const leadRouter = express.Router();
	const now = deps.now ?? (() => new Date());

	const authorize = (
		sessionId: unknown,
		generation: unknown,
		leaseToken: unknown,
	): VoiceAgendaRouteSession | undefined => {
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

	const snapshotFor = (session: VoiceAgendaRouteSession): AgendaSnapshot => {
		const snapshot = deps.buildSnapshot(session);
		deps.agenda.recordServedItems(
			session.sessionId,
			snapshot.items,
			now().toISOString(),
		);
		return snapshot;
	};

	sessionRouter.get("/", (req, res) => {
		const session = authorize(
			req.query.sessionId,
			Number(req.query.generation),
			req.headers["x-voice-lease"],
		);
		if (!session) {
			res.status(403).json({ error: "voice_agenda_session_unauthorized" });
			return;
		}
		try {
			res.json(clientSnapshot(snapshotFor(session)));
		} catch (error) {
			res.status(503).json({
				error: "voice_agenda_source_unavailable",
				reason: (error as Error).message,
			});
		}
	});

	sessionRouter.get("/state", (req, res) => {
		const session = authorize(
			req.query.sessionId,
			Number(req.query.generation),
			req.headers["x-voice-lease"],
		);
		if (!session) {
			res.status(403).json({ error: "voice_agenda_session_unauthorized" });
			return;
		}
		res.json({ state: deps.agenda.getState(session.sessionId) ?? null });
	});

	sessionRouter.put("/state", (req, res) => {
		const body = exactObject(req.body, [
			"sessionId",
			"generation",
			"expectedVersion",
			"state",
			"dispositions",
		]);
		const session = authorize(
			body?.sessionId,
			body?.generation,
			req.headers["x-voice-lease"],
		);
		if (!session || !body) {
			res.status(403).json({ error: "voice_agenda_session_unauthorized" });
			return;
		}
		const state = body.state as AgendaState | undefined;
		const dispositions = body.dispositions as
			| AgendaDispositionRecord[]
			| undefined;
		const served = (key: unknown) =>
			typeof key === "string" &&
			!!deps.agenda.getServedItem(session.sessionId, key);
		// Review R8: a pending closing line is founder speech, so it is stored
		// only as the exact copy of this session's own authenticated close.
		const closingProven = (value: unknown): boolean => {
			if (value === undefined || value === null) return true;
			const closing = exactObject(value, [
				"itemKey",
				"closedAs",
				"wasUrgent",
				"text",
				"requestId",
				"resultEventId",
				"attempts",
				"failures",
			]);
			const count = (entry: unknown) =>
				Number.isSafeInteger(entry) &&
				(entry as number) >= 0 &&
				(entry as number) <= 1_000;
			if (
				!closing ||
				!served(closing.itemKey) ||
				!AGENDA_DISPOSITIONS.includes(
					closing.closedAs as AgendaDispositionRecord["disposition"],
				) ||
				typeof closing.wasUrgent !== "boolean" ||
				!text(closing.text, MAX_SAY_TEXT) ||
				!text(closing.requestId, 64) ||
				!text(closing.resultEventId, 256) ||
				!count(closing.attempts) ||
				!count(closing.failures)
			)
				return false;
			const record = deps.handoffs.get(closing.requestId);
			const result = deps.handoffs.getResult(
				closing.requestId,
				closing.resultEventId,
			);
			return (
				record?.sessionId === session.sessionId &&
				record.projectName === session.projectName &&
				result?.resultKind === "agenda_close" &&
				result.agenda?.kind === "close" &&
				result.agenda.itemKey === closing.itemKey &&
				result.agenda.disposition === closing.closedAs &&
				result.agenda.say === closing.text &&
				result.text === closing.text
			);
		};
		if (
			!state ||
			typeof state !== "object" ||
			state.version !== 1 ||
			state.sessionId !== session.sessionId ||
			state.generation !== session.sessionGeneration ||
			!Number.isSafeInteger(body.expectedVersion) ||
			(body.expectedVersion as number) < 0 ||
			state.stateVersion !== (body.expectedVersion as number) + 1 ||
			!state.items ||
			typeof state.items !== "object" ||
			!Object.keys(state.items).every(served) ||
			![
				...state.queue,
				...state.urgentQueue,
				state.active,
				state.activeUrgent,
			].every((key) => key === null || served(key)) ||
			!closingProven((state as { closing?: unknown }).closing) ||
			!Array.isArray(dispositions) ||
			dispositions.some(
				(record) =>
					!served(record?.itemKey) ||
					!AGENDA_DISPOSITIONS.includes(record.disposition) ||
					!text(record.reason, 1_000) ||
					!text(record.requestId, 256) ||
					(record.disposition === "resolved" &&
						!text(record.evidence ?? "", 1_000)),
			)
		) {
			res.status(400).json({ error: "voice_agenda_state_invalid" });
			return;
		}
		const outcome = deps.agenda.saveState({
			state,
			expectedVersion: body.expectedVersion as number,
			dispositions,
			now: now().toISOString(),
		});
		res.status(outcome.ok ? 200 : 409).json(outcome);
	});

	sessionRouter.post("/turns", (req, res) => {
		const body = exactObject(req.body, [
			"sessionId",
			"generation",
			"utteranceId",
			"turnId",
			"itemKey",
		]);
		const session = authorize(
			body?.sessionId,
			body?.generation,
			req.headers["x-voice-lease"],
		);
		if (!session || !body) {
			res.status(403).json({ error: "voice_agenda_session_unauthorized" });
			return;
		}
		if (
			!text(body.utteranceId, 256) ||
			!text(body.turnId, 256) ||
			!KEY.test(String(body.turnId)) ||
			typeof body.itemKey !== "string" ||
			!deps.agenda.getServedItem(session.sessionId, body.itemKey)
		) {
			res.status(400).json({ error: "voice_agenda_turn_invalid" });
			return;
		}
		const outcome = deps.agenda.bindTurn({
			sessionId: session.sessionId,
			generation: session.sessionGeneration,
			utteranceId: body.utteranceId as string,
			turnId: body.turnId as string,
			itemKey: body.itemKey,
			now: now().toISOString(),
		});
		if (outcome === "conflict") {
			res.status(409).json({ error: "voice_agenda_turn_conflict" });
			return;
		}
		res.json({ outcome });
	});

	sessionRouter.post("/requests", async (req, res) => {
		const body = exactObject(req.body, [
			"sessionId",
			"generation",
			"purpose",
			"itemKey",
			"clientRequestId",
			"rewriteReason",
			"previous",
		]);
		const session = authorize(
			body?.sessionId,
			body?.generation,
			req.headers["x-voice-lease"],
		);
		if (!session || !body) {
			res.status(403).json({ error: "voice_agenda_session_unauthorized" });
			return;
		}
		const purpose = body.purpose as AgendaBriefPurpose;
		const itemKey = body.itemKey as string | null;
		const needsItem =
			purpose === "item" || purpose === "urgent" || purpose === "resume";
		const previous = body.previous as
			| { itemKey?: unknown; closedAs?: unknown }
			| undefined;
		if (
			!AGENDA_PURPOSES.includes(purpose) ||
			!CLIENT_ID.test(String(body.clientRequestId)) ||
			(needsItem
				? typeof itemKey !== "string" ||
					!deps.agenda.getServedItem(session.sessionId, itemKey)
				: itemKey !== null) ||
			(body.rewriteReason !== undefined &&
				!/^[a-z_]{1,32}$/u.test(String(body.rewriteReason))) ||
			(previous !== undefined &&
				(!exactObject(previous, ["itemKey", "closedAs"]) ||
					!deps.agenda.getServedItem(
						session.sessionId,
						String(previous.itemKey),
					) ||
					![...AGENDA_DISPOSITIONS, "source_gone"].includes(
						String(previous.closedAs),
					)))
		) {
			res.status(400).json({ error: "voice_agenda_request_invalid" });
			return;
		}
		const state = deps.agenda.getState(session.sessionId);
		let brief: Record<string, unknown>;
		try {
			if (purpose === "open") {
				const snapshot = snapshotFor(session);
				brief = {
					purpose,
					mode: session.mode === "rg" ? "headphone" : "meeting",
					items: snapshot.items.map((entry) => briefItem(entry, "compact")),
					olderUnspokenCount: snapshot.olderUnspokenCount,
					sourcesComplete: snapshot.complete,
				};
			} else {
				const queued = (state?.queue ?? []).filter((key) => key !== itemKey);
				const item = itemKey
					? deps.agenda.getServedItem(session.sessionId, itemKey)
					: undefined;
				brief = {
					purpose,
					mode: session.mode === "rg" ? "headphone" : "meeting",
					...(item ? { item: briefItem(item, "full") } : {}),
					currentItemKey: state?.activeUrgent ?? state?.active ?? null,
					queueAfter: {
						count: queued.length + (state?.urgentQueue.length ?? 0),
						classes: classCounts(
							[...queued, ...(state?.urgentQueue ?? [])],
							state,
						),
					},
					...(previous
						? {
								previous: {
									itemKey: previous.itemKey,
									closedAs: previous.closedAs,
								},
							}
						: {}),
					...(body.rewriteReason ? { rewriteBecause: body.rewriteReason } : {}),
				};
			}
		} catch (error) {
			res.status(503).json({
				error: "voice_agenda_source_unavailable",
				reason: (error as Error).message,
			});
			return;
		}
		const authorId = deps.briefAuthorId(session);
		if (
			!authorId ||
			!/^\d{17,20}$/u.test(authorId) ||
			authorId === deps.founderUserId
		) {
			res.status(503).json({ error: "voice_agenda_author_unavailable" });
			return;
		}
		const handoffId = randomUUID();
		const answerKey = randomBytes(18).toString("base64url");
		const idempotencyKey = `agenda:${session.sessionId}:${session.sessionGeneration}:${body.clientRequestId}`;
		const requestDigest = digest({
			idempotencyKey,
			purpose,
			itemKey,
		});
		const agenda: Extract<VoiceHandoffAgenda, { kind: "brief" }> = {
			kind: "brief",
			purpose,
			itemKey,
			clientRequestId: String(body.clientRequestId),
			authorId,
			answerKey,
			brief,
			text: renderAgendaBriefText({
				requestId: handoffId,
				answerKey,
				purpose,
				itemKey,
				brief,
			}),
		};
		const messageId = `voice-handoff:${handoffId}`;
		let record: VoiceHandoffRecord;
		try {
			record = deps.handoffs.authorizeAgendaBrief({
				handoffId,
				idempotencyKey,
				requestDigest,
				projectName: session.projectName,
				founderUserId: deps.founderUserId,
				targetLeadId: session.leadId,
				sessionId: session.sessionId,
				generation: session.sessionGeneration,
				messageId,
				providerOperationId: chatDeliveryId(session.leadId, messageId, {
					origin: "voice",
					voiceSessionId: session.sessionId,
					voiceHandoff: {
						version: 1,
						handoffId,
						intentKind: "query",
						requestDigest,
						targetLeadId: session.leadId,
						transcriptId: `agenda:${handoffId}`,
						utteranceId: `agenda:${handoffId}`,
						sessionGeneration: session.sessionGeneration,
						agenda: { kind: "brief", purpose, itemKey },
					},
				}),
				agenda,
				now: now().toISOString(),
			});
		} catch (error) {
			res.status(409).json({ error: (error as Error).message });
			return;
		}
		if (record.state === "authorized") {
			const dispatching = deps.handoffs.beginDispatch(
				record.handoffId,
				now().toISOString(),
			);
			if (dispatching?.attemptToken) {
				let outcome: "committed" | "rejected" | "ambiguous" = "ambiguous";
				try {
					outcome = await deps.dispatchBrief(dispatching);
				} catch {
					outcome = "ambiguous";
				}
				record =
					deps.handoffs.finishDispatch({
						handoffId: dispatching.handoffId,
						attemptToken: dispatching.attemptToken,
						state: outcome,
						...(outcome === "rejected"
							? { reason: "provider_rejected" }
							: outcome === "ambiguous"
								? { reason: "provider_outcome_unknown" }
								: {}),
						now: now().toISOString(),
					}) ?? dispatching;
			}
		}
		res.status(record.state === "rejected" ? 502 : 200).json({
			requestId: record.handoffId,
			requestDigest: record.requestDigest,
			state: record.state,
			providerOperationId: record.providerOperationId,
		});
	});

	/** `flywheel-comm voice agenda say|close`: bound to the Lead the request was
	 * delivered to, the live session and its generation (plan §3.2). */
	leadRouter.post("/results", (req, res) => {
		const body = exactObject(req.body, [
			"requestId",
			"leadId",
			"answerKey",
			"clientResultId",
			"kind",
			"itemKey",
			"order",
			"text",
			"disposition",
			"evidence",
			"reason",
			"say",
		]);
		if (
			!body ||
			!text(body.requestId, 64) ||
			!text(body.leadId, 256) ||
			!CLIENT_ID.test(String(body.clientResultId)) ||
			(body.kind !== "say" && body.kind !== "close")
		) {
			res.status(400).json({ error: "voice_agenda_result_invalid" });
			return;
		}
		const record = deps.handoffs.get(body.requestId as string);
		const session = record ? deps.getSession(record.sessionId) : undefined;
		const expectedKey =
			record?.agenda?.kind === "brief" || record?.agenda?.kind === "turn"
				? record.agenda.answerKey
				: undefined;
		if (
			!record ||
			!expectedKey ||
			!keyMatches(body.answerKey, expectedKey) ||
			record.state !== "committed" ||
			record.targetLeadId !== body.leadId ||
			record.founderUserId !== deps.founderUserId ||
			!session ||
			session.projectName !== record.projectName ||
			session.sessionGeneration !== record.generation ||
			!(session.state === "warming" || session.state === "live") ||
			!(record.requestKind === "agenda_brief" || record.agenda?.kind === "turn")
		) {
			res.status(403).json({ error: "voice_agenda_result_unauthorized" });
			return;
		}
		let payload: VoiceAgendaResultPayload;
		let spoken: string;
		// QA@1 B2/B3: everything the mode layer would refuse on its own terms is
		// refused here, with a reason, so the Lead learns instead of waiting.
		const refuse = (
			error: "voice_agenda_say_invalid" | "voice_agenda_close_invalid",
			reason: string,
			hint: string,
		) => res.status(400).json({ error, reason, hint });
		const agenda = record.agenda;
		const openKeys =
			agenda?.kind === "brief" && agenda.purpose === "open"
				? ((agenda.brief.items as Array<{ itemKey: string }>) ?? []).map(
						(item) => item.itemKey,
					)
				: null;
		/** The one item this request is about (null: open / check-in). */
		const requestItem =
			agenda?.kind === "turn" ? agenda.itemKey : (agenda?.itemKey ?? null);
		const itemAllowed = (itemKey: string | null): boolean => {
			if (agenda?.kind === "turn")
				return itemKey === null || itemKey === agenda.itemKey;
			if (!agenda || agenda.kind !== "brief") return false;
			if (agenda.purpose === "open")
				return itemKey === null || !!openKeys?.includes(itemKey);
			if (agenda.purpose === "checkin") return itemKey === null;
			return itemKey !== null && itemKey === agenda.itemKey;
		};
		const itemHint = (): string =>
			openKeys
				? `开场的 --item 只能是 none 或这次开场里的一件：${openKeys.join(", ") || "（没有）"}`
				: agenda?.kind === "brief" && agenda.purpose === "checkin"
					? "报平安用 --item none"
					: agenda?.kind === "turn"
						? `她这句话绑定的是 ${requestItem}；无关就用 --item none`
						: `这次请求只说 ${requestItem}，--item 必须是它`;
		if (body.kind === "say") {
			const order = body.order as string[] | undefined;
			if (
				!text(body.text, MAX_SAY_TEXT) ||
				(body.itemKey !== null && !KEY.test(String(body.itemKey))) ||
				body.disposition !== undefined ||
				body.evidence !== undefined ||
				body.reason !== undefined ||
				body.say !== undefined
			) {
				refuse(
					"voice_agenda_say_invalid",
					"malformed",
					"say 只带 --item、--text（开场可带 --order）",
				);
				return;
			}
			if (
				order !== undefined &&
				(!openKeys ||
					!Array.isArray(order) ||
					order.length !== openKeys.length ||
					new Set(order).size !== order.length ||
					!order.every(
						(key) => typeof key === "string" && openKeys.includes(key),
					))
			) {
				refuse(
					"voice_agenda_say_invalid",
					"order_invalid",
					openKeys
						? `--order 必须把这次开场的每一件都排进去、不重复：${openKeys.join(", ")}；不想排就不带 --order`
						: "--order 只在开场可用",
				);
				return;
			}
			const itemKey = (body.itemKey as string | null) ?? null;
			if (!itemAllowed(itemKey)) {
				refuse("voice_agenda_say_invalid", "item_not_in_request", itemHint());
				return;
			}
			const words = validateAgendaSay(body.text as string);
			if (!words.ok) {
				refuse(
					"voice_agenda_say_invalid",
					words.reason,
					"要念给她听的话：口语，不带 URL、markdown、代码、🤖/📻/🗣️ 前缀，400 字以内",
				);
				return;
			}
			payload = {
				kind: "say",
				itemKey,
				...(order ? { order } : {}),
			};
			spoken = body.text as string;
		} else {
			const disposition =
				body.disposition as AgendaDispositionRecord["disposition"];
			if (
				typeof body.itemKey !== "string" ||
				!KEY.test(body.itemKey) ||
				!AGENDA_DISPOSITIONS.includes(disposition) ||
				!text(body.reason, 1_000) ||
				(body.evidence !== undefined && !text(body.evidence, 1_000)) ||
				body.text !== undefined ||
				body.order !== undefined
			) {
				refuse(
					"voice_agenda_close_invalid",
					"malformed",
					"close 需要 --item、--disposition、--reason、--say",
				);
				return;
			}
			if (disposition === "resolved" && !text(body.evidence, 1_000)) {
				refuse(
					"voice_agenda_close_invalid",
					"evidence_required",
					"resolved 要带 --evidence（消息 id、命令回执、状态变更）",
				);
				return;
			}
			if (
				!agenda ||
				(agenda.kind === "brief" &&
					(agenda.purpose === "open" || agenda.purpose === "checkin"))
			) {
				refuse(
					"voice_agenda_close_invalid",
					"close_not_allowed",
					"开场和报平安不能结束一件；她拍板后，用她那句话的 handoff 和 key 来 close",
				);
				return;
			}
			if (body.itemKey !== requestItem) {
				refuse(
					"voice_agenda_close_invalid",
					"item_not_in_request",
					`这次只能结束 ${requestItem}`,
				);
				return;
			}
			if (!text(body.say, MAX_SAY_TEXT)) {
				refuse(
					"voice_agenda_close_invalid",
					"say_required",
					"结束一件要带 --say：她拍完之后听到的那一句（比如「记下你批了，你在讨论串里点一下就行」）",
				);
				return;
			}
			const words = validateAgendaSay(body.say);
			if (!words.ok) {
				refuse(
					"voice_agenda_close_invalid",
					words.reason,
					"--say 是念给她听的话：口语，不带 URL、markdown、代码，400 字以内",
				);
				return;
			}
			payload = {
				kind: "close",
				itemKey: body.itemKey,
				disposition,
				...(body.evidence ? { evidence: body.evidence as string } : {}),
				reason: body.reason as string,
				say: body.say,
			};
			spoken = body.say;
		}
		const resultEventId = `voice-agenda:${record.handoffId}:${digest(body.clientResultId).slice(0, 32)}`;
		const prior = deps.handoffs.getResult(record.handoffId, resultEventId);
		if (prior) {
			// A retried command: same id, same payload, same event.
			if (
				prior.text !== spoken ||
				JSON.stringify(prior.agenda ?? null) !== JSON.stringify(payload)
			) {
				res.status(409).json({ error: "voice_agenda_result_conflict" });
				return;
			}
			res.json(prior);
			return;
		}
		try {
			const sourceDeliveryId = deps.recordLeadResult(record, {
				resultEventId,
				text: spoken,
			});
			const previousHighWatermark = deps.handoffs.listResults(
				record.handoffId,
				0,
				1,
			).highWatermark;
			const event = deps.handoffs.appendResult({
				handoffId: record.handoffId,
				resultEventId,
				requestDigest: record.requestDigest,
				sourceLeadId: record.targetLeadId,
				sourceDeliveryId,
				resultKind: payload.kind === "say" ? "agenda_say" : "agenda_close",
				text: spoken,
				agenda: payload,
				createdAt: now().toISOString(),
			});
			if (event.seq > previousHighWatermark)
				deps.replyNotifier.notify({
					sessionId: record.sessionId,
					generation: record.generation,
					handoffId: record.handoffId,
				});
			res.json(event);
		} catch (error) {
			const message = (error as Error).message;
			res.status(message.endsWith("unauthorized") ? 403 : 409).json({
				error: message,
			});
		}
	});

	return { sessionRouter, leadRouter };
}
