import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	loadVerifiedPullRequest,
	matchesCloseoutRestartIntent,
	prepareRestartTicket,
	type RestartContextIo,
	type RestartRequestContext,
	type RestartRequestV2,
	transitionRestartIntent,
	verifyRestartTicket,
} from "./restart-request.js";

const closeoutIntentPositives = [
	"收尾后重启",
	"今天收尾后马上重启",
	"收尾完成后，我们立刻重启电脑。",
	"重启电脑",
];
const closeoutIntentNegatives = [
	"先交给班车，然后请重启",
	"如果你觉得需要就现在重启",
	"你觉得合适的时候请重启",
	"等 CI 绿请重启",
	"Raya 那边稳定下来请重启",
	"晚点请重启",
	"等一下请重启",
	"restart now unless Tadashi objects",
	"不要收尾后重启",
	"收尾后重启吗？",
	"收尾后重启，等我确认",
	"他说收尾后重启",
	"昨天收尾后重启",
	"收尾后重启。先别动",
];

describe("closeout restart intent grammar", () => {
	it.each(closeoutIntentPositives)(
		"accepts the pinned expression %s",
		(text) => {
			expect(matchesCloseoutRestartIntent(text)).toBe(true);
		},
	);

	it.each(closeoutIntentNegatives)(
		"rejects the pinned expression %s",
		(text) => {
			expect(matchesCloseoutRestartIntent(text)).toBe(false);
		},
	);

	it.each(closeoutIntentPositives)("rejects prefix-wrapped %s", (text) => {
		expect(matchesCloseoutRestartIntent(`等确认后${text}`)).toBe(false);
	});

	it.each(closeoutIntentPositives)("rejects suffix-wrapped %s", (text) => {
		expect(matchesCloseoutRestartIntent(`${text}，等我同意`)).toBe(false);
	});

	it("rejects newlines, quotations, and caller-cleaned substrings", () => {
		expect(matchesCloseoutRestartIntent("收尾后\n重启")).toBe(false);
		expect(matchesCloseoutRestartIntent("“收尾后重启”")).toBe(false);
		expect(matchesCloseoutRestartIntent("  收尾后重启  ")).toBe(true);
	});
});

const founderId = "100000000000000001";
const leadBotId = "100000000000000002";
const founderChannel = "100000000000000003";
const engineerChannel = "100000000000000004";
const founderMessageId = "100000000000000005";
const announcementMessageId = "100000000000000006";
const targetSha = "1".repeat(40);
const fromSha = "2".repeat(40);
const preMergeHead = "3".repeat(40);
const pullRequestHeadSha = "4".repeat(40);
const pullRequestNumber = 2655;
const requestId = "11111111-2222-4333-8444-555555555555";
const currentInstanceId = "d".repeat(64);
const founderContent = "FLY-2655 已经修好，现在马上重启，今天晚上 12 点前完成";
const conditionalFounderContent =
	"2655 修好了我们可以马上重启，不要等到今天晚上 12 点";
const founderTimestamp = "2026-09-17T20:00:00.000-07:00";
const expiresAt = "2026-09-18T07:00:00.000Z";
const createdAt = "2026-09-18T05:00:00.000Z";
const announcementContent = [
	`[restart-request:${requestId}]`,
	`founder-message:${founderChannel}/${founderMessageId}`,
	"trigger:issue_fix_landed:flywheel:FLY-2655",
	`target:${targetSha}`,
	"purpose:deploy the completed FLY-2655 fix now",
	"affected:Bridge and Lead fleet",
	"recovery:updater rollback and Runner rematerialization",
].join("\n");
const digest = (value: string) =>
	createHash("sha256").update(value).digest("hex");

function request(): RestartRequestV2 {
	return {
		schemaVersion: 2,
		kind: "authorized-urgent-restart",
		requestId,
		authority: {
			kind: "founder-per-instance",
			messageRef: {
				channelId: founderChannel,
				messageId: founderMessageId,
				authorId: founderId,
				timestamp: founderTimestamp,
				contentDigest: digest(founderContent),
			},
			timeFrame: {
				kind: "founder-local-day",
				timezone: "America/Los_Angeles",
				expression: "今天晚上 12 点",
			},
			expiresAt,
		},
		trigger: {
			kind: "issue_fix_landed",
			project: "flywheel",
			repo: "xrliAnnie/flywheel",
			issueId: "FLY-2655",
			originalText: founderContent,
			evidence: {
				eventId: "merge:flywheel:2655",
				mergedCommit: targetSha,
				pullRequest: {
					number: pullRequestNumber,
					headSha: pullRequestHeadSha,
				},
				verdicts: [
					{
						kind: "code-review",
						id: "review-2655",
						status: "approved",
						headSha: pullRequestHeadSha,
					},
					{
						kind: "qa",
						id: "qa-2655",
						status: "pass",
						headSha: pullRequestHeadSha,
					},
				],
			},
		},
		requestedBy: {
			projectName: "flywheel",
			leadId: "flywheel-eng-lead",
			instanceId: currentInstanceId,
			botUserId: leadBotId,
		},
		announcement: {
			channelId: engineerChannel,
			messageId: announcementMessageId,
			authorId: leadBotId,
			timestamp: "2026-09-18T04:59:00.000Z",
			contentDigest: digest(announcementContent),
			purpose: "deploy the completed FLY-2655 fix now",
			affectedScope: ["Bridge", "Lead fleet"],
			recoveryExpectations: "updater rollback and Runner rematerialization",
		},
		fromDeployedSha: fromSha,
		targetSha,
		createdAt,
	};
}

function context(): RestartRequestContext {
	return {
		now: Date.parse(createdAt) + 1_000,
		founderId,
		founderTimezone: "America/Los_Angeles",
		founderMessage: {
			id: founderMessageId,
			channelId: founderChannel,
			authorId: founderId,
			authorBot: false,
			content: founderContent,
			timestamp: founderTimestamp,
		},
		announcementMessage: {
			id: announcementMessageId,
			channelId: engineerChannel,
			authorId: leadBotId,
			authorBot: true,
			content: announcementContent,
			timestamp: "2026-09-18T04:59:00.000Z",
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
		currentInstanceId,
		deployedSha: fromSha,
		remoteMainSha: targetSha,
		preMergeHead,
		targetContainsCommit: true,
		verifiedPullRequest: {
			repo: "xrliAnnie/flywheel",
			number: pullRequestNumber,
			headSha: pullRequestHeadSha,
			mergeCommit: targetSha,
			baseRef: "main",
			issueIds: ["FLY-2655"],
		},
	};
}

function githubIo(
	payload: Record<string, unknown>,
	onFetch?: (url: string, init: RequestInit | undefined) => void,
): RestartContextIo {
	return {
		fetch: (async (input: URL | RequestInfo, init?: RequestInit) => {
			onFetch?.(String(input), init);
			return new Response(JSON.stringify(payload), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as typeof fetch,
		readFile: () => {
			throw new Error("unused");
		},
		lstat: () => {
			throw new Error("unused");
		},
		processAlive: () => false,
		now: () => Date.parse(createdAt),
	};
}

function immediateFixture(content: string): {
	input: RestartRequestV2;
	ctx: RestartRequestContext;
} {
	const input = request();
	input.authority.messageRef.contentDigest = digest(content);
	input.authority.timeFrame = {
		kind: "elapsed-24h",
		timezone: "America/Los_Angeles",
		expression: null,
	};
	input.authority.expiresAt = "2026-09-19T03:00:00.000Z";
	input.trigger = {
		kind: "immediate",
		project: "flywheel",
		repo: "xrliAnnie/flywheel",
		originalText: content,
		evidence: {
			eventId: "founder-immediate:100000000000000005",
			mergedCommit: targetSha,
			verdicts: [],
		},
	};
	const immediateAnnouncement = [
		`[restart-request:${requestId}]`,
		`founder-message:${founderChannel}/${founderMessageId}`,
		`trigger:immediate:flywheel:xrliAnnie/flywheel:${targetSha}`,
		`target:${targetSha}`,
		`purpose:${input.announcement.purpose}`,
		`affected:${input.announcement.affectedScope.join(", ")}`,
		`recovery:${input.announcement.recoveryExpectations}`,
	].join("\n");
	input.announcement.contentDigest = digest(immediateAnnouncement);
	const ctx = context();
	ctx.founderMessage = { ...ctx.founderMessage, content };
	ctx.announcementMessage = {
		...ctx.announcementMessage,
		content: immediateAnnouncement,
	};
	return { input, ctx };
}

function conditionalFixture(
	content: string,
	kind: "issue_fix_landed" | "pr_merged" = "issue_fix_landed",
): { input: RestartRequestV2; ctx: RestartRequestContext } {
	const input = request();
	input.authority.messageRef.contentDigest = digest(content);
	input.authority.timeFrame.expression = content.includes("tonight")
		? "tonight"
		: content.includes("今天晚上 12 点")
			? "今天晚上 12 点"
			: "今晚";
	input.trigger.originalText = content;
	const ctx = context();
	ctx.founderMessage = { ...ctx.founderMessage, content };
	if (kind === "pr_merged") {
		input.trigger.kind = "pr_merged";
		input.trigger.prNumber = pullRequestNumber;
		delete input.trigger.issueId;
		const announcement = announcementContent.replace(
			"trigger:issue_fix_landed:flywheel:FLY-2655",
			`trigger:pr_merged:flywheel:${pullRequestNumber}`,
		);
		input.announcement.contentDigest = digest(announcement);
		ctx.announcementMessage = {
			...ctx.announcementMessage,
			content: announcement,
		};
	}
	return { input, ctx };
}

describe("conditional restart request", () => {
	it("reads the merged PR head and squash commit from the fixed GitHub API endpoint", async () => {
		let fetchedUrl = "";
		const result = await loadVerifiedPullRequest(
			request(),
			undefined,
			githubIo(
				{
					number: pullRequestNumber,
					state: "closed",
					merged: true,
					merged_at: "2026-09-18T04:00:00.000Z",
					merge_commit_sha: targetSha,
					title: "fix(FLY-2655): complete restart prerequisite",
					body: "Closes FLY-2655",
					head: { sha: pullRequestHeadSha, ref: "flywheel-FLY-2655" },
					base: {
						ref: "main",
						repo: { full_name: "xrliAnnie/flywheel" },
					},
				},
				(url) => {
					fetchedUrl = url;
				},
			),
		);

		expect(fetchedUrl).toBe(
			"https://api.github.com/repos/xrliAnnie/flywheel/pulls/2655",
		);
		expect(result).toEqual({
			repo: "xrliAnnie/flywheel",
			number: pullRequestNumber,
			headSha: pullRequestHeadSha,
			mergeCommit: targetSha,
			baseRef: "main",
			issueIds: ["FLY-2655"],
		});
	});

	it("rejects GitHub PR metadata that is not a merged PR into main", async () => {
		await expect(
			loadVerifiedPullRequest(
				request(),
				undefined,
				githubIo({
					number: pullRequestNumber,
					state: "open",
					merged: false,
					merged_at: null,
					merge_commit_sha: targetSha,
					head: { sha: pullRequestHeadSha },
					base: {
						ref: "feature",
						repo: { full_name: "xrliAnnie/flywheel" },
					},
				}),
			),
		).rejects.toThrow(/pull-request-invalid/);
	});

	it("accepts verdicts on the reviewed PR head when GitHub proves its squash merge is the trigger commit", () => {
		const input = request();
		input.trigger.evidence.verdicts = input.trigger.evidence.verdicts.map(
			(verdict) => ({ ...verdict, headSha: pullRequestHeadSha }),
		);
		input.trigger.evidence.pullRequest = {
			number: pullRequestNumber,
			headSha: pullRequestHeadSha,
		};
		const ctx = context();
		ctx.verifiedPullRequest = {
			repo: input.trigger.repo,
			number: pullRequestNumber,
			headSha: pullRequestHeadSha,
			mergeCommit: targetSha,
			baseRef: "main",
			issueIds: ["FLY-2655"],
		};

		expect(prepareRestartTicket(input, ctx).trigger.evidence.verdicts).toEqual(
			input.trigger.evidence.verdicts,
		);
	});

	it("rejects a merged PR that does not name the founder's issue condition", () => {
		const ctx = context();
		ctx.verifiedPullRequest = {
			...ctx.verifiedPullRequest!,
			issueIds: ["FLY-9001"],
		};

		expect(() => prepareRestartTicket(request(), ctx)).toThrow(
			/trigger-issue-unbound/,
		);
	});

	it("rejects relabelling PR-head verdicts as if origin/main itself was reviewed", () => {
		const input = request();
		input.trigger.evidence.verdicts = input.trigger.evidence.verdicts.map(
			(verdict) => ({ ...verdict, headSha: targetSha }),
		);

		expect(() => prepareRestartTicket(input, context())).toThrow(
			/verdicts-invalid/,
		);
	});

	it("rejects a trigger commit that is not the verified PR squash commit", () => {
		const ctx = context();
		ctx.verifiedPullRequest = {
			...ctx.verifiedPullRequest!,
			mergeCommit: fromSha,
		};

		expect(() => prepareRestartTicket(request(), ctx)).toThrow(
			/pull-request-invalid/,
		);
	});

	it.each([
		["issue_fix_landed", "2655 修好了也不要马上重启，等到今天晚上 12 点的班车"],
		["pr_merged", "PR #2655 合入之后别急着重启，等到今天晚上 12 点的班车"],
	] as const)(
		"rejects a conditional %s source message that refuses the restart",
		(kind, content) => {
			const { input, ctx } = conditionalFixture(content, kind);

			expect(() => prepareRestartTicket(input, ctx)).toThrow(
				/trigger-source-revoked/,
			);
		},
	);

	it.each([
		"2655 修好之后，今晚重启前先问我",
		"2655 修好了告诉我，今晚我来决定是否重启",
		"2655 修好之后今晚需要重启吗？",
		"After FLY-2655 merges tonight, should we restart?",
		"Once FLY-2655 merges tonight, check with me before any restart",
	])(
		"rejects a conditional source that withholds restart authorization: %s",
		(content) => {
			const { input, ctx } = conditionalFixture(content);

			expect(() => prepareRestartTicket(input, ctx)).toThrow(
				/trigger-conditional-unproven/,
			);
		},
	);

	it("rejects a PR condition phrased only as a restart question", () => {
		const { input, ctx } = conditionalFixture(
			"After PR #2655 merges tonight, should we restart?",
			"pr_merged",
		);

		expect(() => prepareRestartTicket(input, ctx)).toThrow(
			/trigger-conditional-unproven/,
		);
	});

	it.each([
		"2655 修好就好，重启的事交给今晚班车",
		"2655 修好就等今晚的班车一起重启",
		"Once FLY-2655 merges tonight, restart as soon as the regular shuttle runs",
		"2655 修好之后等我通知再马上重启，今晚",
		"2655 修好了告诉我，我同意了就马上重启，今晚",
		"FLY-2655 已经合入，等 2700 也合入后马上重启，今晚",
		"2655 已经修好了，2700 修好后马上重启，今晚",
		"FLY-2655 已经修好一半了，剩下的修好后马上重启，今晚",
		"FLY-2655 已经合入，QA 过了以后马上重启，今晚",
	])("rejects a future or deferred conditional source: %s", (content) => {
		const { input, ctx } = conditionalFixture(content);

		expect(() => prepareRestartTicket(input, ctx)).toThrow(
			/trigger-conditional-unproven/,
		);
	});

	it.each([
		[
			"issue_fix_landed",
			"FLY-2655 已经修好，现在马上重启，今天晚上 12 点前完成",
		],
		["pr_merged", "PR #2655 已合入，请现在直接重启，今天晚上 12 点前完成"],
		["issue_fix_landed", "FLY-2655 已经修好，请重启，今天晚上 12 点前完成"],
	] as const)(
		"accepts a current unconditional %s restart directive",
		(kind, content) => {
			const { input, ctx } = conditionalFixture(content, kind);

			expect(prepareRestartTicket(input, ctx).trigger.kind).toBe(kind);
		},
	);

	it.each(
		(
			[
				[
					"issue_fix_landed",
					"FLY-2655 已经修好，现在马上重启，今天晚上 12 点前完成",
				],
				["pr_merged", "PR #2655 已合入，请现在直接重启，今天晚上 12 点前完成"],
				["issue_fix_landed", "FLY-2655 已经修好，请重启，今天晚上 12 点前完成"],
			] as const
		).flatMap(([kind, content]) => [
			[kind, `等 FLY-2700 合入后，${content}`] as const,
			[kind, `${content}，QA 通过以后再执行`] as const,
			[kind, `Once FLY-2700 merges, ${content}`] as const,
		]),
	)(
		"rejects a subordinate condition wrapped around a valid %s directive: %s",
		(kind, content) => {
			const { input, ctx } = conditionalFixture(content, kind);

			expect(() => prepareRestartTicket(input, ctx)).toThrow(
				/trigger-conditional-unproven/,
			);
		},
	);

	it("does not treat a caller-selected time expression as allowed directive grammar", () => {
		const content = "FLY-2655 已经修好，请重启，QA 过了以后再执行，今晚";
		const { input, ctx } = conditionalFixture(content);
		input.authority.timeFrame.expression = "QA 过了以后再执行，今晚";

		expect(() => prepareRestartTicket(input, ctx)).toThrow(
			/trigger-conditional-unproven/,
		);
	});

	it("allows a direct founder immediate restart without invented review verdicts", () => {
		const { input, ctx } = immediateFixture("现在马上紧急重启");

		expect(prepareRestartTicket(input, ctx).trigger.kind).toBe("immediate");
	});

	it("rejects an immediate source message that tells the Lead not to restart", () => {
		const { input, ctx } = immediateFixture("现在先不要重启，等我说");

		expect(() => prepareRestartTicket(input, ctx)).toThrow(
			/trigger-source-revoked/,
		);
	});

	it("rejects an ordinary inability statement near the restart verb", () => {
		const { input, ctx } = immediateFixture("现在还不能重启，等我确认完再说");

		expect(() => prepareRestartTicket(input, ctx)).toThrow();
	});

	it("rejects a question asking whether a restart already finished", () => {
		const { input, ctx } = immediateFixture("重启已经做完了吗？");

		expect(() => prepareRestartTicket(input, ctx)).toThrow();
	});

	it("accepts the founder's explicit immediate request phrased as permission", () => {
		const { input, ctx } = immediateFixture("那你现在马上紧急重启可以吗？");

		expect(prepareRestartTicket(input, ctx).trigger.kind).toBe("immediate");
	});

	it("rejects the canonical conditional instruction when relabelled immediate", () => {
		const { input, ctx } = immediateFixture(conditionalFounderContent);
		input.authority.timeFrame = {
			kind: "founder-local-day",
			timezone: "America/Los_Angeles",
			expression: "今天晚上 12 点",
		};
		input.authority.expiresAt = expiresAt;

		expect(() => prepareRestartTicket(input, ctx)).toThrow(
			/trigger-immediate-conditional/,
		);
	});

	it.each([
		"2650 已经修好了，等 2655 修好后马上重启",
		"等 2655 上线就马上重启",
		"2655 一好就马上重启",
		"Restart immediately as soon as FLY-2655 is in",
		"Please restart when PR 1234 is approved",
	])(
		"rejects a named conditional object relabelled immediate: %s",
		(content) => {
			const { input, ctx } = immediateFixture(content);

			expect(() => prepareRestartTicket(input, ctx)).toThrow(
				/trigger-immediate-conditional/,
			);
		},
	);

	it.each([
		"那个登录 bug 修好了马上重启",
		"合入之后马上重启",
		"修好后马上重启",
		"二六五五修好了马上重启",
		"Raya 那边修好了马上重启",
	])(
		"rejects a verbal conditional object relabelled immediate: %s",
		(content) => {
			const { input, ctx } = immediateFixture(content);

			expect(() => prepareRestartTicket(input, ctx)).toThrow(
				/trigger-immediate-conditional/,
			);
		},
	);

	it("accepts an immediate request with an explicit completed-state assertion", () => {
		const { input, ctx } = immediateFixture("已经修好了，现在马上紧急重启");

		expect(prepareRestartTicket(input, ctx).trigger.kind).toBe("immediate");
	});

	it("does not treat an ordinary sequence word as a future condition", () => {
		const { input, ctx } = immediateFixture("现在马上紧急重启，然后告诉我结果");

		expect(prepareRestartTicket(input, ctx).trigger.kind).toBe("immediate");
	});

	it("does not treat an English substring as an immediate assertion", () => {
		const { input, ctx } = immediateFixture(
			"Knowing about snow is not a restart instruction",
		);

		expect(() => prepareRestartTicket(input, ctx)).toThrow(
			/trigger-immediate-unproven/,
		);
	});

	it("rejects self-asserted verdicts on a direct founder immediate restart", () => {
		const input = request();
		const content = "现在马上紧急重启";
		input.authority.messageRef.contentDigest = digest(content);
		input.authority.timeFrame = {
			kind: "elapsed-24h",
			timezone: "America/Los_Angeles",
			expression: null,
		};
		input.authority.expiresAt = "2026-09-19T03:00:00.000Z";
		input.trigger.kind = "immediate";
		delete input.trigger.issueId;
		input.trigger.originalText = content;
		delete input.trigger.evidence.pullRequest;
		const ctx = context();
		ctx.founderMessage = { ...ctx.founderMessage, content };

		expect(() => prepareRestartTicket(input, ctx)).toThrow(/verdicts-invalid/);
	});

	it("prepares a truthful v2 ticket from exact founder, Lead, trigger and version evidence", () => {
		const ticket = prepareRestartTicket(request(), context());
		expect(ticket).toMatchObject({
			schemaVersion: 2,
			kind: "authorized-urgent-restart",
			requestId,
			preMergeHead,
			requestDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
		});
		expect(verifyRestartTicket(ticket, context())).toEqual(ticket);
	});

	it("revalidates a prepared ticket later without rewriting validatedAt", () => {
		const ticket = prepareRestartTicket(request(), context());
		const later = context();
		later.now += 10 * 60_000;
		expect(verifyRestartTicket(ticket, later)).toEqual(ticket);
	});

	it("resolves the current runtime marker to a public instance digest before persisting", () => {
		const input = request();
		input.requestedBy.instanceId = "current";
		const ticket = prepareRestartTicket(input, context());
		expect(ticket.requestedBy.instanceId).toBe(currentInstanceId);
		expect(JSON.stringify(ticket)).not.toContain("carrier-instance-raw-secret");
	});

	it.each([
		[
			"forged founder",
			{ founderMessage: { ...context().founderMessage, authorId: leadBotId } },
		],
		[
			"founder bot",
			{ founderMessage: { ...context().founderMessage, authorBot: true } },
		],
		[
			"wrong Lead bot",
			{
				announcementMessage: {
					...context().announcementMessage,
					authorId: founderId,
				},
			},
		],
		["missing registry", { leadRegistry: [] }],
		["stale Lead instance", { currentInstanceId: "replacement-instance" }],
		["incomplete later context", { contextComplete: false }],
		["wrong deployed SHA", { deployedSha: "4".repeat(40) }],
		["target drift", { remoteMainSha: "5".repeat(40) }],
		["fix absent from target", { targetContainsCommit: false }],
	] as const)("rejects %s", (_name, patch) => {
		expect(() =>
			prepareRestartTicket(request(), { ...context(), ...patch }),
		).toThrow();
	});

	it("rejects unknown nested fields instead of digesting an extensible authority shape", () => {
		const input = request() as RestartRequestV2 & {
			authority: RestartRequestV2["authority"] & { approved?: boolean };
		};
		input.authority.approved = true;
		expect(() => prepareRestartTicket(input, context())).toThrow(
			/shape-invalid/,
		);
	});

	it("rejects a later founder withdrawal bound to the same trigger", () => {
		expect(() =>
			prepareRestartTicket(request(), {
				...context(),
				laterFounderMessages: [
					{
						id: "100000000000000007",
						channelId: founderChannel,
						authorId: founderId,
						authorBot: false,
						content: "FLY-2655 先不要重启，撤回刚才的安排",
						timestamp: "2026-09-18T04:30:00.000Z",
					},
				],
			}),
		).toThrow(/revoked/);
	});

	it("does not silently turn a missed natural time frame into 24 hours", () => {
		const input = request();
		input.authority.timeFrame = {
			kind: "elapsed-24h",
			timezone: "America/Los_Angeles",
			expression: null,
		};
		input.authority.expiresAt = "2026-09-19T03:00:00.000Z";
		expect(() => prepareRestartTicket(input, context())).toThrow(
			/time-frame-omission/,
		);
	});

	it("lexically rejects an unparsed explicit clock phrase before 24h fallback", () => {
		const input = request();
		const content = "FLY-2655 修好后下午 5 点马上重启";
		input.authority.messageRef.contentDigest = digest(content);
		input.authority.timeFrame = {
			kind: "elapsed-24h",
			timezone: "America/Los_Angeles",
			expression: null,
		};
		input.authority.expiresAt = "2026-09-19T03:00:00.000Z";
		input.trigger.originalText = content;
		const ctx = context();
		ctx.founderMessage = { ...ctx.founderMessage, content };
		expect(() => prepareRestartTicket(input, ctx)).toThrow(
			/time-frame-omission/,
		);
	});

	it("derives an explicit local-clock deadline from the founder phrase", () => {
		const input = request();
		const content = "FLY-2655 已经修好，现在马上重启，最晚今天晚上 11 点";
		input.authority.messageRef.contentDigest = digest(content);
		input.authority.timeFrame = {
			kind: "explicit",
			timezone: "America/Los_Angeles",
			expression: "今天晚上 11 点",
		};
		input.authority.expiresAt = "2026-09-18T06:00:00.000Z";
		input.trigger.originalText = content;
		const ctx = context();
		ctx.founderMessage = { ...ctx.founderMessage, content };
		expect(prepareRestartTicket(input, ctx).authority.expiresAt).toBe(
			input.authority.expiresAt,
		);
	});

	it("rejects a caller-chosen explicit deadline that was not derived from the founder phrase", () => {
		const input = request();
		const content = "FLY-2655 修好后今天晚上 11 点前重启";
		input.authority.messageRef.contentDigest = digest(content);
		input.authority.timeFrame = {
			kind: "explicit",
			timezone: "America/Los_Angeles",
			expression: "今天晚上 11 点",
		};
		input.authority.expiresAt = "2026-09-19T00:00:00.000Z";
		input.trigger.originalText = content;
		const ctx = context();
		ctx.founderMessage = { ...ctx.founderMessage, content };
		expect(() => prepareRestartTicket(input, ctx)).toThrow(
			/time-frame-invalid/,
		);
	});

	it("rejects explicit mode when the cited source fragment has no controlled time expression", () => {
		const input = request();
		const content = "FLY-2655 修好后马上重启";
		input.authority.messageRef.contentDigest = digest(content);
		input.authority.timeFrame = {
			kind: "explicit",
			timezone: "America/Los_Angeles",
			expression: "马上重启",
		};
		input.authority.expiresAt = "2026-09-19T03:00:00.000Z";
		input.trigger.originalText = content;
		const ctx = context();
		ctx.founderMessage = { ...ctx.founderMessage, content };
		expect(() => prepareRestartTicket(input, ctx)).toThrow(
			/time-frame-invalid/,
		);
	});

	it("rejects the local-day instruction after founder-local midnight", () => {
		expect(() =>
			prepareRestartTicket(request(), {
				...context(),
				now: Date.parse(expiresAt),
			}),
		).toThrow(/expired/);
	});

	it("allows elapsed 24h only when the source contains no natural time frame", () => {
		const input = request();
		const content = "FLY-2655 已经修好，现在马上重启";
		input.authority.messageRef.contentDigest = digest(content);
		input.authority.timeFrame = {
			kind: "elapsed-24h",
			timezone: "America/Los_Angeles",
			expression: null,
		};
		input.authority.expiresAt = "2026-09-19T03:00:00.000Z";
		input.trigger.originalText = content;
		const ctx = context();
		ctx.founderMessage = { ...ctx.founderMessage, content };
		ctx.now = Date.parse(founderTimestamp) + 23 * 60 * 60_000;
		expect(prepareRestartTicket(input, ctx).authority.expiresAt).toBe(
			input.authority.expiresAt,
		);
	});

	it.each([
		["different issue", { issueId: "FLY-9999" }],
		[
			"missing QA",
			{
				evidence: {
					...request().trigger.evidence,
					verdicts: [request().trigger.evidence.verdicts[0]!],
				},
			},
		],
		[
			"verdict on another head",
			{
				evidence: {
					...request().trigger.evidence,
					verdicts: request().trigger.evidence.verdicts.map((v) => ({
						...v,
						headSha: fromSha,
					})),
				},
			},
		],
	] as const)("rejects trigger evidence for a %s", (_name, patch) => {
		const input = request();
		input.trigger = { ...input.trigger, ...patch };
		expect(() => prepareRestartTicket(input, context())).toThrow();
	});

	it("rejects announcement text that does not bind the request and recovery scope", () => {
		const input = request();
		const content = "Restarting now";
		input.announcement.contentDigest = digest(content);
		const ctx = context();
		ctx.announcementMessage = { ...ctx.announcementMessage, content };
		expect(() => prepareRestartTicket(input, ctx)).toThrow(/announcement/);
	});
});

describe("restart intent one-use ledger", () => {
	it("allows deterministic pre-start revocation, keeps it idempotent, and rejects revocation after start", () => {
		const ticket = prepareRestartTicket(request(), context());
		const prepared = transitionRestartIntent(undefined, ticket, {
			state: "prepared",
			at: createdAt,
		});
		const revoked = transitionRestartIntent(prepared, ticket, {
			state: "revoked",
			at: "2026-09-18T05:00:30.000Z",
		});
		const idempotent = transitionRestartIntent(revoked, ticket, {
			state: "revoked",
			at: "2026-09-18T05:00:31.000Z",
		});
		expect(Object.values(idempotent.intents)[0]?.state).toBe("revoked");

		const started = transitionRestartIntent(prepared, ticket, {
			state: "started",
			at: "2026-09-18T05:01:00.000Z",
			waveId: "wave-1",
		});
		expect(() =>
			transitionRestartIntent(started, ticket, {
				state: "revoked",
				at: "2026-09-18T05:01:01.000Z",
			}),
		).toThrow(/already-used/);
	});

	it("allows one prepared -> started -> succeeded wave and rejects a new UUID for the same intent", () => {
		const ticket = prepareRestartTicket(request(), context());
		const prepared = transitionRestartIntent(undefined, ticket, {
			state: "prepared",
			at: createdAt,
		});
		const started = transitionRestartIntent(prepared, ticket, {
			state: "started",
			at: "2026-09-18T05:01:00.000Z",
			waveId: "wave-1",
		});
		const succeeded = transitionRestartIntent(started, ticket, {
			state: "succeeded",
			at: "2026-09-18T05:10:00.000Z",
			waveId: "wave-1",
		});
		expect(Object.values(succeeded.intents)[0]?.state).toBe("succeeded");
		const replacement = {
			...ticket,
			requestId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
		};
		expect(() =>
			transitionRestartIntent(succeeded, replacement, {
				state: "prepared",
				at: "2026-09-18T05:11:00.000Z",
			}),
		).toThrow(/already-used/);
	});

	it.each([
		[
			"trigger kind",
			{ kind: "pr_merged" as const, issueId: undefined, prNumber: 2655 },
		],
		["issue object", { issueId: "FLY-9999" }],
		["repository", { repo: "xrliAnnie/another-repo" }],
	])(
		"does not mint another wave for the same founder message after changing %s",
		(_name, triggerPatch) => {
			const ticket = prepareRestartTicket(request(), context());
			let index = transitionRestartIntent(undefined, ticket, {
				state: "prepared",
				at: createdAt,
			});
			index = transitionRestartIntent(index, ticket, {
				state: "started",
				at: "2026-09-18T05:01:00.000Z",
				waveId: "wave-1",
			});
			index = transitionRestartIntent(index, ticket, {
				state: "succeeded",
				at: "2026-09-18T05:02:00.000Z",
				waveId: "wave-1",
			});
			const replacement = {
				...ticket,
				requestId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
				requestDigest: "a".repeat(64),
				trigger: { ...ticket.trigger, ...triggerPatch },
			};
			expect(() =>
				transitionRestartIntent(index, replacement, {
					state: "prepared",
					at: "2026-09-18T05:03:00.000Z",
				}),
			).toThrow(/already-used/);
		},
	);

	it("does not permit retry after started when outcome is unknown", () => {
		const ticket = prepareRestartTicket(request(), context());
		let index = transitionRestartIntent(undefined, ticket, {
			state: "prepared",
			at: createdAt,
		});
		index = transitionRestartIntent(index, ticket, {
			state: "started",
			at: "2026-09-18T05:01:00.000Z",
			waveId: "wave-1",
		});
		index = transitionRestartIntent(index, ticket, {
			state: "unknown",
			at: "2026-09-18T05:02:00.000Z",
			waveId: "wave-1",
		});
		expect(() =>
			transitionRestartIntent(index, ticket, {
				state: "prepared",
				at: "2026-09-18T05:03:00.000Z",
			}),
		).toThrow(/already-used/);
	});

	it("allows a revised request only after a zero-side-effect refusal recorded before the wave started", () => {
		const ticket = prepareRestartTicket(request(), context());
		let index = transitionRestartIntent(undefined, ticket, {
			state: "prepared",
			at: createdAt,
		});
		// Review round 5 HIGH: once `started` is minted the first service stop
		// may already have happened, so a later `failed` can never be stamped
		// zero-side-effect after the fact, and it never re-arms the intent.
		const started = transitionRestartIntent(index, ticket, {
			state: "started",
			at: "2026-09-18T05:01:00.000Z",
			waveId: "wave-1",
		});
		expect(() =>
			transitionRestartIntent(started, ticket, {
				state: "failed",
				at: "2026-09-18T05:02:00.000Z",
				waveId: "wave-1",
				zeroSideEffects: true,
			}),
		).toThrow(/side-effects-not-provable/);
		const failed = transitionRestartIntent(started, ticket, {
			state: "failed",
			at: "2026-09-18T05:02:00.000Z",
			waveId: "wave-1",
		});
		expect(() =>
			transitionRestartIntent(failed, ticket, {
				state: "prepared",
				at: "2026-09-18T05:03:00.000Z",
				zeroSideEffects: true,
			}),
		).toThrow(/already-used/);
		// Only a refusal recorded before start (consumed-no-deploy with zero
		// side effects) can be followed by a replacement.
		index = transitionRestartIntent(index, ticket, {
			state: "consumed-no-deploy",
			at: "2026-09-18T05:02:00.000Z",
			waveId: "wave-1",
			zeroSideEffects: true,
		});
		const replacement = {
			...ticket,
			requestId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
			requestDigest: "a".repeat(64),
		};
		const revised = transitionRestartIntent(index, replacement, {
			state: "prepared",
			at: "2026-09-18T05:03:00.000Z",
			zeroSideEffects: true,
		});
		expect(Object.values(revised.intents)[0]).toMatchObject({
			requestId: replacement.requestId,
			state: "prepared",
		});
	});
});
