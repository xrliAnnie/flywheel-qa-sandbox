import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	closeoutScopeDigest,
	prepareCloseoutRestartTicket,
	type RestartCloseoutContext,
	type RestartRequestV3,
	transitionRestartIntent,
} from "./restart-request.js";

const founderId = "100000000000000001";
const leadBotId = "100000000000000002";
const founderChannel = "100000000000000003";
const engineerChannel = "100000000000000004";
const founderMessageId = "100000000000000005";
const announcementMessageId = "100000000000000006";
const decisionId = "11111111-2222-4333-8444-555555555555";
const executionId = "21111111-2222-4333-8444-555555555555";
const activationId = "activation-1";
const entryDigest = "a".repeat(64);
const manifestDigest = "b".repeat(64);
const packageDigest = "c".repeat(64);
const recoveryDigest = "d".repeat(64);
const instanceId = "e".repeat(64);
const fromSha = "1".repeat(40);
const targetSha = "2".repeat(40);
const headSha = "3".repeat(40);
const createdAt = "2026-09-17T22:00:00.000-07:00";
const digest = (value: string) =>
	createHash("sha256").update(value).digest("hex");

function fixture(intentText = "收尾后重启") {
	const intentTimestamp = "2026-09-17T20:00:00.000-07:00";
	const scope = {
		version: "restart-scope-snapshot/v1" as const,
		capturedAt: "2026-09-17T21:50:00.000-07:00",
		sources: [
			{
				kind: "state-store" as const,
				receiptId: "state-1",
				digest: "4".repeat(64),
			},
			{ kind: "comm-db" as const, receiptId: "comm-1", digest: "5".repeat(64) },
			{
				kind: "turn-wake" as const,
				receiptId: "turn-1",
				digest: "6".repeat(64),
			},
			{
				kind: "process-service" as const,
				receiptId: "process-1",
				digest: "7".repeat(64),
			},
		],
		entries: [
			{
				executionId,
				activationId,
				project: "flywheel",
				phase: "implement" as const,
				repo: "xrliAnnie/flywheel",
				worktree: "/Users/test/Dev/flywheel-FLY-3000",
				headSha,
				pushedHeadSha: headSha,
				clean: true,
				parked: true,
				activeWrite: false,
				pendingWakeIds: [] as string[],
				verdict: {
					kind: "code-review" as const,
					receiptId: "review-1",
					status: "approved" as const,
					headSha,
				},
				recovery: {
					path: "/Users/test/.flywheel/recovery/exec-1.json",
					digest: recoveryDigest,
				},
			},
		],
		snapshotDigest: "",
	};
	scope.snapshotDigest = closeoutScopeDigest(scope);
	const announcementText = [
		`[closeout-restart:${decisionId}:r1]`,
		"wave:closeout-wave-1",
		`intent:${founderChannel}/${founderMessageId}`,
		`scope:${scope.snapshotDigest}`,
		`target:${targetSha}`,
		"purpose:finish the approved closeout restart",
		`interrupts:${executionId}`,
		"recovery:resume every parked execution from its durable context",
	].join("\n");
	const request: RestartRequestV3 = {
		schemaVersion: 3,
		kind: "lead-closeout-restart",
		decisionId,
		waveId: "closeout-wave-1",
		revision: 1,
		authority: {
			kind: "standing-carve-out",
			entryId: "lead-closeout-restart/v1",
			entryDigest,
			manifestRevision: 2,
			manifestDigest,
		},
		intent: {
			kind: "closeout-restart-intent/v1",
			classification: "precondition-not-authorization",
			messageRef: {
				channelId: founderChannel,
				messageId: founderMessageId,
				authorId: founderId,
				timestamp: intentTimestamp,
				contentDigest: digest(intentText),
			},
			timezone: "America/Los_Angeles",
			founderLocalDate: "2026-09-17",
			expiresAt: "2026-09-18T07:00:00.000Z",
		},
		scopeSnapshot: scope,
		readiness: { kind: "all-ready", executionIds: [executionId] },
		requestedBy: {
			projectName: "flywheel",
			leadId: "flywheel-eng-lead",
			instanceId,
			botUserId: leadBotId,
		},
		announcement: {
			channelId: engineerChannel,
			messageId: announcementMessageId,
			authorId: leadBotId,
			timestamp: "2026-09-17T21:59:00.000-07:00",
			contentDigest: digest(announcementText),
			purpose: "finish the approved closeout restart",
			affectedExecutionIds: [executionId],
			recoveryExpectations:
				"resume every parked execution from its durable context",
		},
		fromDeployedSha: fromSha,
		targetSha,
		executionPackage: {
			root: "/Users/test/.flywheel/releases/standing/package-1",
			packageDigest,
			sourceCommit: targetSha,
		},
		createdAt,
	};
	const context: RestartCloseoutContext = {
		now: Date.parse(createdAt) + 1_000,
		founderId,
		founderTimezone: "America/Los_Angeles",
		founderMessage: {
			id: founderMessageId,
			channelId: founderChannel,
			authorId: founderId,
			authorBot: false,
			content: intentText,
			timestamp: intentTimestamp,
		},
		announcementMessage: {
			id: announcementMessageId,
			channelId: engineerChannel,
			authorId: leadBotId,
			authorBot: true,
			content: announcementText,
			timestamp: "2026-09-17T21:59:00.000-07:00",
		},
		laterFounderMessages: [],
		contextComplete: true,
		leadRegistry: [
			{
				projectName: "flywheel",
				leadId: "flywheel-eng-lead",
				botUserId: leadBotId,
			},
		],
		currentInstanceId: instanceId,
		deployedSha: fromSha,
		remoteMainSha: targetSha,
		preMergeHead: fromSha,
		activeAuthority: {
			entryDigest,
			manifestRevision: 2,
			manifestDigest,
			packageDigest,
			packageRoot: request.executionPackage.root,
			sourceCommit: targetSha,
		},
		currentScopeSnapshot: structuredClone(scope),
	};
	return { request, context };
}

describe("lead closeout restart v3", () => {
	it.each([
		"收尾后重启",
		"今天收尾后马上重启",
		"收尾完成后，我们立刻重启电脑。",
		"重启电脑",
	])("prepares a standing-authority ticket for %s", (intent) => {
		const { request, context } = fixture(intent);
		const ticket = prepareCloseoutRestartTicket(request, context);
		expect(ticket).toMatchObject({
			schemaVersion: 3,
			kind: "lead-closeout-restart",
			decisionId,
			waveId: "closeout-wave-1",
			preMergeHead: fromSha,
		});
		expect(ticket.requestDigest).toMatch(/^[a-f0-9]{64}$/);
	});

	it("fails closed on inactive authority, local-day expiry, or scope drift", () => {
		const inactive = fixture();
		inactive.context.activeAuthority = null;
		expect(() =>
			prepareCloseoutRestartTicket(inactive.request, inactive.context),
		).toThrow("standing-authority-inactive");

		const expired = fixture();
		expired.context.now = Date.parse("2026-09-18T00:01:00.000-07:00");
		expect(() =>
			prepareCloseoutRestartTicket(expired.request, expired.context),
		).toThrow("intent-expired");

		const drifted = fixture();
		drifted.context.currentScopeSnapshot.entries[0]!.activeWrite = true;
		drifted.context.currentScopeSnapshot.snapshotDigest = closeoutScopeDigest(
			drifted.context.currentScopeSnapshot,
		);
		expect(() =>
			prepareCloseoutRestartTicket(drifted.request, drifted.context),
		).toThrow("scope-drift");
	});

	it("rejects active writes without an authenticated recast waiver", () => {
		const { request, context } = fixture();
		request.scopeSnapshot.entries[0]!.activeWrite = true;
		request.scopeSnapshot.entries[0]!.parked = false;
		request.scopeSnapshot.snapshotDigest = closeoutScopeDigest(
			request.scopeSnapshot,
		);
		context.currentScopeSnapshot = structuredClone(request.scopeSnapshot);
		expect(() => prepareCloseoutRestartTicket(request, context)).toThrow(
			"scope-not-ready",
		);
	});

	it("rejects a matching intent after withdrawal or an unbound announcement", () => {
		const withdrawn = fixture();
		withdrawn.context.laterFounderMessages.push({
			id: "100000000000000009",
			channelId: founderChannel,
			authorId: founderId,
			authorBot: false,
			content: "先不要重启",
			timestamp: "2026-09-17T21:00:00.000-07:00",
		});
		expect(() =>
			prepareCloseoutRestartTicket(withdrawn.request, withdrawn.context),
		).toThrow("intent-revoked");

		const unbound = fixture();
		unbound.context.announcementMessage.content = "准备重启";
		expect(() =>
			prepareCloseoutRestartTicket(unbound.request, unbound.context),
		).toThrow("announcement-invalid");
	});

	// QA2 rework (FLY-2654 hard-red 3): the matcher is unit-tested elsewhere,
	// but its wiring into the producer must fail closed on its own. Every
	// message here binds by digest and passes every other precondition, so the
	// only guard left standing is `matchesCloseoutRestartIntent`.
	it.each([
		"先交给班车，然后请重启",
		"如果你觉得需要就现在重启",
		"等 CI 绿请重启",
		"不要收尾后重启",
		"收尾后重启吗？",
		"收尾后重启，等我确认",
		"他说收尾后重启",
		"昨天收尾后重启",
		"收尾后重启。先别动",
		"restart now unless Tadashi objects",
	])(
		"refuses a bound but non-matching founder intent through the producer: %s",
		(intent) => {
			const { request, context } = fixture(intent);
			expect(() => prepareCloseoutRestartTicket(request, context)).toThrow(
				"intent-unverified",
			);
		},
	);

	// QA2 rework (hard-red 3): an announcement whose digest binds but whose
	// body drops any one required line is `announcement-unbound`, never
	// accepted. Each required line is removed in turn so no single line can be
	// silently made optional.
	it("refuses a digest-bound announcement that drops any one required line", () => {
		const { context: reference } = fixture();
		const lines = reference.announcementMessage.content.split("\n");
		expect(lines).toHaveLength(8);
		for (const [index, dropped] of lines.entries()) {
			const { request, context } = fixture();
			const content = lines.filter((_, at) => at !== index).join("\n");
			context.announcementMessage.content = content;
			request.announcement.contentDigest = digest(content);
			expect(
				() => prepareCloseoutRestartTicket(request, context),
				`dropped ${dropped}`,
			).toThrow("announcement-unbound");
		}
		const { request, context } = fixture();
		expect(prepareCloseoutRestartTicket(request, context).decisionId).toBe(
			decisionId,
		);
	});

	it("invalidates the decision on later founder context from another known channel", () => {
		const advanced = fixture();
		advanced.context.laterFounderMessages.push({
			id: "100000000000000010",
			channelId: "100000000000000011",
			authorId: founderId,
			authorBot: false,
			content: "先处理另一件事",
			timestamp: "2026-09-17T21:00:00.000-07:00",
		});
		expect(() =>
			prepareCloseoutRestartTicket(advanced.request, advanced.context),
		).toThrow("intent-context-advanced");
	});

	// Review round 5 HIGH: a wave that minted `started` and then failed after
	// stopping services is terminal for its intent. The failed row carries no
	// zeroSideEffects flag, so neither a re-prepare nor a retroactive
	// zero-side-effect stamp may re-arm a second fleet wave.
	it("never re-arms an intent after a started wave failed with side effects", () => {
		const { request, context } = fixture();
		const ticket = prepareCloseoutRestartTicket(request, context);
		let index = transitionRestartIntent(undefined, ticket, {
			state: "prepared",
			at: createdAt,
			zeroSideEffects: true,
		});
		index = transitionRestartIntent(index, ticket, {
			state: "started",
			at: "2026-09-18T05:01:00.000Z",
			waveId: ticket.waveId,
		});
		expect(() =>
			transitionRestartIntent(index, ticket, {
				state: "failed",
				at: "2026-09-18T05:02:00.000Z",
				waveId: ticket.waveId,
				zeroSideEffects: true,
			}),
		).toThrow("side-effects-not-provable");
		index = transitionRestartIntent(index, ticket, {
			state: "failed",
			at: "2026-09-18T05:02:00.000Z",
			waveId: ticket.waveId,
		});
		const before = JSON.stringify(index);
		expect(() =>
			transitionRestartIntent(index, ticket, {
				state: "prepared",
				at: "2026-09-18T05:03:00.000Z",
				zeroSideEffects: true,
			}),
		).toThrow("already-used");
		const revisedFixture = fixture();
		revisedFixture.request.revision = 2;
		revisedFixture.context.announcementMessage.content =
			revisedFixture.context.announcementMessage.content.replace(
				":r1]",
				":r2]",
			);
		revisedFixture.request.announcement.contentDigest = digest(
			revisedFixture.context.announcementMessage.content,
		);
		const revised = prepareCloseoutRestartTicket(
			revisedFixture.request,
			revisedFixture.context,
		);
		expect(() =>
			transitionRestartIntent(index, revised, {
				state: "prepared",
				at: "2026-09-18T05:03:00.000Z",
				zeroSideEffects: true,
			}),
		).toThrow("already-used");
		expect(JSON.stringify(index)).toBe(before);
		expect(index.intents[Object.keys(index.intents)[0]!]!.zeroSideEffects).toBe(
			undefined,
		);
	});

	// Review round 6 HIGH: a producer re-submission (prepared → prepared with
	// the flag) must not plant a zero-side-effect flag that survives the wave
	// start and later re-arms the intent through a post-stop failure.
	it("drops a planted zero-side-effect flag at wave start so a later failure stays terminal", () => {
		const { request, context } = fixture();
		const ticket = prepareCloseoutRestartTicket(request, context);
		let index = transitionRestartIntent(undefined, ticket, {
			state: "prepared",
			at: createdAt,
			zeroSideEffects: true,
		});
		index = transitionRestartIntent(index, ticket, {
			state: "prepared",
			at: "2026-09-18T05:00:30.000Z",
			zeroSideEffects: true,
		});
		const row = () => index.intents[Object.keys(index.intents)[0]!]!;
		expect(row().zeroSideEffects).toBe(true);
		// Review round 7/9 residual seed: a wave start can never be annotated
		// side-effect-free, whatever the caller claims.
		expect(() =>
			transitionRestartIntent(index, ticket, {
				state: "started",
				at: "2026-09-18T05:01:00.000Z",
				waveId: ticket.waveId,
				zeroSideEffects: true,
			}),
		).toThrow("side-effects-not-provable");
		index = transitionRestartIntent(index, ticket, {
			state: "started",
			at: "2026-09-18T05:01:00.000Z",
			waveId: ticket.waveId,
		});
		expect(row().zeroSideEffects).toBeUndefined();
		index = transitionRestartIntent(index, ticket, {
			state: "failed",
			at: "2026-09-18T05:02:00.000Z",
			waveId: ticket.waveId,
		});
		expect(row().zeroSideEffects).toBeUndefined();
		expect(() =>
			transitionRestartIntent(index, ticket, {
				state: "prepared",
				at: "2026-09-18T05:03:00.000Z",
				zeroSideEffects: true,
			}),
		).toThrow("already-used");
		expect(row().state).toBe("failed");
	});

	it("permits only the same decision and wave to revise after consumed-no-deploy", () => {
		const firstFixture = fixture();
		const first = prepareCloseoutRestartTicket(
			firstFixture.request,
			firstFixture.context,
		);
		let index = transitionRestartIntent(undefined, first, {
			state: "prepared",
			at: createdAt,
			zeroSideEffects: true,
		});
		index = transitionRestartIntent(index, first, {
			state: "consumed-no-deploy",
			at: "2026-09-18T05:01:00.000Z",
			waveId: first.waveId,
			zeroSideEffects: true,
		});
		const revisedFixture = fixture();
		revisedFixture.request.revision = 2;
		revisedFixture.context.announcementMessage.content =
			revisedFixture.context.announcementMessage.content.replace(
				":r1]",
				":r2]",
			);
		revisedFixture.request.announcement.contentDigest = digest(
			revisedFixture.context.announcementMessage.content,
		);
		const revised = prepareCloseoutRestartTicket(
			revisedFixture.request,
			revisedFixture.context,
		);
		expect(() =>
			transitionRestartIntent(index, revised, {
				state: "prepared",
				at: "2026-09-18T05:02:00.000Z",
				zeroSideEffects: true,
			}),
		).not.toThrow();
		const changed = structuredClone(revised);
		changed.decisionId = "31111111-2222-4333-8444-555555555555";
		expect(() =>
			transitionRestartIntent(index, changed, {
				state: "prepared",
				at: "2026-09-18T05:02:00.000Z",
				zeroSideEffects: true,
			}),
		).toThrow("already-used");
	});
});
