const TERMINAL_SESSION_STATES = new Set([
	"blocked",
	"cancelled",
	"completed",
	"failed",
	"terminated",
]);

function requiredString(value, field, source = "") {
	if (typeof value !== "string" || value.trim() === "") {
		throw new Error(`${source ? `${source} ` : ""}${field} is required`);
	}
	return value;
}

export function parseIdentityEnvProjection(text) {
	const projection = {};
	for (const line of text.split(/\r?\n/)) {
		if (line === "") continue;
		const separator = line.indexOf("=");
		if (separator < 0) throw new Error(`invalid identity env line: ${line}`);
		const key = line.slice(0, separator);
		if (key === "") throw new Error("identity env line has an empty key");
		if (Object.hasOwn(projection, key)) {
			throw new Error(`duplicate identity env key: ${key}`);
		}
		projection[key] = line.slice(separator + 1);
	}
	return projection;
}

const WAIT_POLL_MS = 500;
export const STUB_FATAL_DIAGNOSIS_EXIT = 21;

function sleep(ms) {
	return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

export async function waitFor(label, probe, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	let last;
	while (Date.now() < deadline) {
		try {
			last = await probe();
			if (last) return last;
		} catch (error) {
			if (error?.qa529Abort === true) throw error;
			last = error instanceof Error ? error.message : String(error);
		}
		await sleep(WAIT_POLL_MS);
	}
	throw new Error(
		`${label} timed out after ${timeoutMs}ms; last=${JSON.stringify(last)}`,
	);
}

const A3_QA_TERMINATION_REASON =
	"FLY-1775 A3 diagnostic exit: retire the QA session before the driver exits";

export function buildA3QaTerminationRequest(input) {
	return {
		path: "/api/actions/terminate",
		body: {
			execution_id: requiredString(
				input?.executionId,
				"executionId",
				"A3 QA termination",
			),
			leadId: requiredString(input?.leadId, "leadId", "A3 QA termination"),
			reason: A3_QA_TERMINATION_REASON,
		},
	};
}

export function a3QaSessionIsIrreversiblyTerminal(session, executionId) {
	return (
		session?.execution_id === executionId &&
		TERMINAL_SESSION_STATES.has(session.status)
	);
}

export async function terminateQaSessionForA3(input) {
	const request = buildA3QaTerminationRequest(input);
	let action = { skipped: "already_terminal" };
	let session = input.readSession();
	if (!a3QaSessionIsIrreversiblyTerminal(session, input.executionId)) {
		let response;
		let body;
		try {
			response = await (input.fetchImpl ?? globalThis.fetch)(
				`${input.bridgeUrl}${request.path}`,
				{
					method: "POST",
					headers: {
						authorization: `Bearer ${input.token}`,
						"content-type": "application/json",
					},
					body: JSON.stringify(request.body),
				},
			);
			const text = await response.text();
			try {
				body = text ? JSON.parse(text) : {};
			} catch {
				body = { raw: text };
			}
		} catch (error) {
			body = {
				requestError: error instanceof Error ? error.message : String(error),
			};
		}
		action = { status: response?.status ?? null, body };
		session = input.readSession();
		if (!a3QaSessionIsIrreversiblyTerminal(session, input.executionId)) {
			throw new Error(
				`A3 QA session termination failed for ${input.executionId}: ${JSON.stringify(action)}`,
			);
		}
	}

	input.requestExecutionExit();
	const actor = await input.waitFor(
		"A3 QA execution exit",
		() => {
			input.requestExecutionExit();
			const observed = input.probeExecution();
			return observed.liveness === "dead" ? observed : false;
		},
		input.timeoutMs,
	);
	const terminalSession = input.readSession();
	if (!a3QaSessionIsIrreversiblyTerminal(terminalSession, input.executionId)) {
		throw new Error(
			`A3 QA session terminal state regressed for ${input.executionId}`,
		);
	}
	return { action, session: terminalSession, actor };
}

export function validateRoomInfo(room, expectedRunnerMode) {
	if (!room || typeof room !== "object" || room.schemaVersion !== 1) {
		throw new Error("room-info schemaVersion=1 is required");
	}
	if (room.generalized !== true || room.mode !== "slot") {
		throw new Error("driver requires a generalized slot room");
	}
	if (room.runnerMode !== expectedRunnerMode) {
		throw new Error(
			`room-info runnerMode=${room.runnerMode ?? "missing"} does not match ${expectedRunnerMode}`,
		);
	}
	if (!Number.isInteger(room.slot) || room.slot < 1) {
		throw new Error("room-info slot must be a positive integer");
	}
	for (const field of [
		"bridgeUrl",
		"dbPath",
		"flywheelProjectsFile",
		"hostRepo",
		"flywheelRepo",
		"buildSha",
		"apiTokenPath",
		"projectName",
		"agentId",
	]) {
		requiredString(room[field], field, "room-info");
	}
	const expectedSummaryConfigHome = `/tmp/flywheel-test-slot-${room.slot}/identity-home`;
	if (room.summaryConfigHome !== expectedSummaryConfigHome) {
		throw new Error(
			`room-info summaryConfigHome must be ${expectedSummaryConfigHome}; teardown and rebuild the room with the current test-deploy.sh`,
		);
	}
	return room;
}

export const REQUIRED_IDENTITY_ENV_KEYS = [
	"FLYWHEEL_LEAD_ID",
	"LEAD_ID",
	"FLYWHEEL_PROJECT_NAME",
	"PROJECT_NAME",
	"FLYWHEEL_LEAD_KEY",
	"FLYWHEEL_LEAD_ROLE",
	"FLYWHEEL_LEAD_BACKEND",
	"FLYWHEEL_LEAD_SUMMARY_ROLE",
	"FLYWHEEL_LEAD_HAS_SUMMARY_DUTY",
	"FLYWHEEL_SUMMARY_GRANULARITY",
	"FLYWHEEL_SUMMARY_ASSIGNMENT_DIGEST",
	"DISCORD_STATE_DIR",
	"DISCORD_EXPECTED_BOT_USER_ID",
	"DISCORD_IDENTITY_MODE",
	"FLYWHEEL_LEAD_IDENTITY_DIGEST",
	"FLYWHEEL_LEAD_PROJECTS_DIGEST",
];

const EMPTY_IDENTITY_ENV_KEYS = new Set([
	"FLYWHEEL_SUMMARY_GRANULARITY",
	"FLYWHEEL_SUMMARY_ASSIGNMENT_DIGEST",
	"DISCORD_EXPECTED_BOT_USER_ID",
]);

export function buildSlotCommEnv(
	baseEnv,
	slotComm,
	identityEnv,
	overrides = {},
) {
	for (const key of REQUIRED_IDENTITY_ENV_KEYS) {
		if (!Object.hasOwn(identityEnv ?? {}, key)) {
			throw new Error(`slot lead identity env is missing ${key}`);
		}
		if (!EMPTY_IDENTITY_ENV_KEYS.has(key)) {
			requiredString(identityEnv[key], key, "slot lead identity env");
		}
	}
	const commString = (field) =>
		requiredString(slotComm?.[field], field, "slot comm environment");
	return {
		...baseEnv,
		...overrides,
		...identityEnv,
		FLYWHEEL_COMM_DB: commString("commDbPath"),
		FLYWHEEL_PROJECTS_FILE: commString("flywheelProjectsFile"),
		FLYWHEEL_SUMMARY_CONFIG_HOME: commString("summaryConfigHome"),
		FLYWHEEL_LEAD_LEASE_DB: commString("leaseDbPath"),
		// The 529 gate-delivery probe exercises CommDB routing, not the resident
		// machine's Lead lease. Avoid reading or writing the production lease
		// control plane after proving the slot-local canonical Lead identity.
		FLYWHEEL_LEAD_LEASE_MODE: "off",
	};
}

export const PR_HEAD_POLL = { attempts: 12, intervalMs: 5_000 };

export function classifyRemotePrObservation({
	rows,
	expectedHead,
	expectedTitle,
}) {
	if (rows.length === 0) return { kind: "retry", reason: "PR not visible" };
	if (rows.length !== 1) {
		return {
			kind: "fatal",
			reason: `expected one PR, observed ${rows.length}`,
		};
	}
	const pr = rows[0];
	if (pr.isDraft === true) return { kind: "fatal", reason: "PR is draft" };
	if (expectedTitle !== undefined && pr.title !== expectedTitle) {
		return { kind: "fatal", reason: "PR title mismatch" };
	}
	if (pr.headRefOid !== expectedHead) {
		return {
			kind: "retry",
			reason: `PR head mismatch: expected ${expectedHead}, observed ${pr.headRefOid ?? "missing"}`,
		};
	}
	return { kind: "converged", pr };
}

export async function pollRemotePrAuthority({
	list,
	sleep,
	expectedHead,
	expectedTitle,
	attempts = PR_HEAD_POLL.attempts,
	intervalMs = PR_HEAD_POLL.intervalMs,
}) {
	let observation;
	let retry;
	for (let attempt = 1; attempt <= attempts; attempt += 1) {
		observation = await list();
		const result = classifyRemotePrObservation({
			rows: observation,
			expectedHead,
			expectedTitle,
		});
		if (result.kind === "converged") {
			return { ...result, attempts: attempt };
		}
		if (result.kind === "fatal") {
			return { ...result, observation, attempts: attempt };
		}
		retry = result;
		if (attempt < attempts) await sleep(intervalMs);
	}
	return {
		kind: "exhausted",
		observation,
		reason: retry?.reason ?? "PR authority poll exhausted",
		attempts,
	};
}

export async function convergeRemotePrAuthority(input) {
	if (!input.knownPr) await input.create();
	return pollRemotePrAuthority(input);
}

const GENERALIZED_FIXTURE_BODY =
	"Deterministic generalized-DAG room drill; do not merge.";
const GENERALIZED_FIXTURE_MARKER =
	/^<!-- flywheel-qa-529-generalized run=([A-Za-z0-9._:-]+) exec=([A-Za-z0-9._:-]+) -->$/;

export function generalizedFixtureBranch(issue, runId) {
	if (!/^[A-Z]+-[0-9]+$/.test(issue ?? "")) {
		throw new Error("fixture issue is invalid");
	}
	if (
		typeof runId !== "string" ||
		!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(runId) ||
		runId.includes("..")
	) {
		throw new Error("fixture runId is invalid");
	}
	return `qa529-${issue}-${runId.replaceAll(":", "-")}`;
}

export function generalizedFixtureMarker(runId, executionId) {
	const safeRunId = requiredString(runId, "fixture.runId", "fixture marker");
	const safeExecutionId = requiredString(
		executionId,
		"fixture.executionId",
		"fixture marker",
	);
	if (
		!/[A-Za-z0-9]/.test(safeRunId) ||
		!/^[A-Za-z0-9._:-]+$/.test(safeRunId) ||
		!/[A-Za-z0-9]/.test(safeExecutionId) ||
		!/^[A-Za-z0-9._:-]+$/.test(safeExecutionId)
	) {
		throw new Error("generalized fixture marker identity is invalid");
	}
	return `<!-- flywheel-qa-529-generalized run=${safeRunId} exec=${safeExecutionId} -->`;
}

export function buildDesignFixtureHtml(issue, runId, executionId) {
	if (!/^[A-Z]+-[0-9]+$/.test(issue ?? "")) {
		throw new Error("fixture issue is invalid");
	}
	return `<!doctype html>
${generalizedFixtureMarker(runId, executionId)}
<html lang="zh-CN"><head><meta charset="utf-8"><title>${issue} generalized QA design</title></head>
<body>
<h1>${issue} generalized QA design</h1>
<h2>一句话</h2><p>用确定性持久 stub 验证 generalized DAG 的真控制面。</p>
<h2>核心流程</h2><p>design → implement → QA FAIL → implement wake → QA PASS → land。</p>
<h2>数据与结构</h2><p>证据来自 slot StateStore、CommDB、tmux 与 sandbox PR。</p>
<h2>取舍</h2><p>保留真 spawn、git、PR 与 CLI；只替换非确定性的模型推理。</p>
<h2>诚实边界</h2><p>F2 的 QA PR 身份若缺失，驱动输出诊断而不伪造通过。</p>
</body></html>
`;
}

const COLLAPSED_BASELINE_REMEDIATION =
	"Choose a fresh --issue or remove the byte-identical fixture from qa-sandbox main; see FLY-2164.";
const STUB_FATAL_REMEDIATION =
	"Inspect the execution stub-state fatal record and bridge.log.";

export function classifyStubFatal(fatal) {
	if (fatal == null) return null;
	const message = fatal?.message;
	const malformed = typeof fatal !== "object" || typeof message !== "string";
	if (
		!malformed &&
		/no committed \.html exists under .+ in ([0-9a-f]{40})\.\.\1(?![0-9a-f])/.test(
			message,
		)
	) {
		return {
			kind: "collapsed_baseline",
			remediation: COLLAPSED_BASELINE_REMEDIATION,
		};
	}
	return {
		kind: "stub_fatal",
		...(malformed ? { malformed: true } : {}),
		remediation: STUB_FATAL_REMEDIATION,
	};
}

export function stubFatalAbortDecision(input) {
	if (!input?.fatal || input.pidAlive || !input.isCurrentExecution) {
		return { abort: false, nextObservation: null };
	}
	if (input.kind === "collapsed_baseline") {
		return { abort: true, nextObservation: null };
	}
	const tuple = {
		executionId: requiredString(
			input.executionId,
			"executionId",
			"stub fatal observation",
		),
		fatalAt: typeof input.fatal?.at === "string" ? input.fatal.at : null,
	};
	const prior = input.priorObservation;
	if (
		prior?.executionId !== tuple.executionId ||
		prior?.fatalAt !== tuple.fatalAt
	) {
		return {
			abort: false,
			nextObservation: {
				...tuple,
				firstObservedAtMs: input.nowMs,
			},
		};
	}
	if (input.nowMs - prior.firstObservedAtMs >= 2_000) {
		return { abort: true, nextObservation: null };
	}
	return { abort: false, nextObservation: prior };
}

export function buildStubFatalAbortError(input) {
	const step = input?.step;
	if (!Number.isInteger(step) || step < 1) {
		throw new Error("stub fatal diagnosis step must be a positive integer");
	}
	const executionId = requiredString(
		input?.executionId,
		"executionId",
		"stub fatal diagnosis",
	);
	const kind = requiredString(
		input?.classification?.kind,
		"classification.kind",
		"stub fatal diagnosis",
	);
	const remediation = requiredString(
		input?.classification?.remediation,
		"classification.remediation",
		"stub fatal diagnosis",
	);
	const error = new Error(
		`step ${step} stub diagnosis ${kind}: ${remediation}`,
	);
	error.qa529Abort = true;
	error.exitCode = STUB_FATAL_DIAGNOSIS_EXIT;
	error.step = step;
	error.executionId = executionId;
	error.classification = input.classification;
	return error;
}

export function reconcileGeneralizedFixturePrBody(body, runId, executionId) {
	const current = generalizedFixtureMarker(runId, executionId);
	const normalized = typeof body === "string" ? body.trim() : "";
	let markers = [];
	if (normalized === GENERALIZED_FIXTURE_BODY) {
		markers = [];
	} else {
		const suffix = `\n\n${GENERALIZED_FIXTURE_BODY}`;
		if (!normalized.endsWith(suffix)) {
			throw new Error("PR body is not a reusable generalized fixture");
		}
		markers = normalized.slice(0, -suffix.length).split("\n").filter(Boolean);
		if (
			markers.length === 0 ||
			markers.some((marker) => !GENERALIZED_FIXTURE_MARKER.test(marker))
		) {
			throw new Error("PR body is not a reusable generalized fixture");
		}
	}
	return `${[...new Set([...markers, current])].join("\n")}\n\n${GENERALIZED_FIXTURE_BODY}`;
}

export function generalizedEntryAuthorityIsReady(run, gate) {
	return (
		run?.engine_owned === 1 &&
		run?.gate_carrier_epoch === 1 &&
		run?.entry_kind === "workflow_v2" &&
		gate?.node === "founder_gate"
	);
}

export function buildGateDeliveryOpenArgs(input) {
	const leadId = requiredString(input.leadId, "gate.leadId", "gate probe");
	const qaExecutionId = requiredString(
		input.qaExecutionId,
		"gate.qaExecutionId",
		"gate probe",
	);
	const implementExecutionId = requiredString(
		input.implementExecutionId,
		"gate.implementExecutionId",
		"gate probe",
	);
	return [
		"gate",
		"question",
		"--lead",
		leadId,
		"--exec-id",
		qaExecutionId,
		"--no-block",
		`FLY-1775 529 gate-delivery probe; parked implement ${implementExecutionId} must not own this question`,
	];
}

export function buildGateDeliveryRespondArgs(input) {
	return [
		"respond",
		requiredString(input.questionId, "gate.questionId", "gate probe"),
		"approve",
		"--lead",
		requiredString(input.leadId, "gate.leadId", "gate probe"),
		"--expect-owner",
		requiredString(input.qaExecutionId, "gate.qaExecutionId", "gate probe"),
		"--expect-checkpoint",
		"question",
	];
}

export function resolveVerifiedPrCleanupTarget(stored, livePr) {
	const live = {
		repo: livePr?.head?.repo?.full_name,
		branch: livePr?.head?.ref,
		expectedHead: livePr?.head?.sha,
	};
	for (const [field, value] of Object.entries(live)) {
		requiredString(value, `cleanup.${field}`, "PR cleanup");
	}
	if (
		stored?.repo !== live.repo ||
		stored?.branch !== live.branch ||
		stored?.expectedHead !== live.expectedHead
	) {
		throw new Error("stored and live PR cleanup identity drift");
	}
	return live;
}

export function shouldTerminatePriorRun(status) {
	if (status === "active" || status === "held") return true;
	if (["completed", "terminated", "cancelled", "failed"].includes(status)) {
		return false;
	}
	throw new Error(`unsupported prior workflow run status: ${status}`);
}

export function parseTmuxTargetIdentity(target) {
	if (typeof target !== "string") return null;
	const match = target.match(/^(?:[^:]+:)?([@%]\d+)$/);
	if (!match) return null;
	return {
		target,
		kind: match[1].startsWith("@") ? "window" : "pane",
		id: match[1],
	};
}

export function tmuxObservationIsAlive(
	target,
	observation,
	expectedExecutionId,
) {
	const identity = parseTmuxTargetIdentity(target);
	if (
		!identity ||
		typeof observation !== "string" ||
		typeof expectedExecutionId !== "string" ||
		expectedExecutionId === ""
	) {
		return false;
	}
	const [windowId, paneId, paneDead, executionId] = observation
		.trim()
		.split("|");
	const exact =
		identity.kind === "window"
			? windowId === identity.id
			: paneId === identity.id;
	return exact && paneDead === "0" && executionId === expectedExecutionId;
}

function prFromStubState(state) {
	const records = [
		...(Array.isArray(state?.completionHistory) ? state.completionHistory : []),
		state?.lastCompletion,
		state?.pending,
	].filter(
		(record) =>
			record?.action === "implement" || record?.action === "complete-implement",
	);
	const record = records
		.filter(
			(entry) =>
				Number.isInteger(entry?.prNumber) &&
				typeof entry?.repo === "string" &&
				typeof entry?.branch === "string" &&
				typeof entry?.head === "string",
		)
		.sort((left, right) => (right.attempt ?? 0) - (left.attempt ?? 0))[0];
	if (!record) return null;
	return {
		executionId: state.executionId,
		attempt: record.attempt ?? 0,
		number: record.prNumber,
		repo: record.repo,
		branch: record.branch,
		expectedHead: record.head,
	};
}

export function resolveOwnedPrEvidence(
	stored,
	stubStates,
	runId,
	executionIds,
) {
	const exactExecutions = new Set(executionIds);
	const candidates = stubStates
		.filter(
			(state) =>
				state?.runId === runId && exactExecutions.has(state.executionId),
		)
		.map(prFromStubState)
		.filter(Boolean)
		.sort((left, right) => right.attempt - left.attempt);
	if (candidates.length === 0) return stored ?? null;
	const candidate = candidates[0];
	for (const other of candidates.slice(1)) {
		if (
			other.number !== candidate.number ||
			other.repo !== candidate.repo ||
			other.branch !== candidate.branch
		) {
			throw new Error("stub PR ownership evidence conflicts across executions");
		}
	}
	if (
		stored &&
		(stored.number !== candidate.number ||
			stored.repo !== candidate.repo ||
			stored.branch !== candidate.branch)
	) {
		throw new Error("stored and stub PR ownership identities conflict");
	}
	const { attempt: _attempt, ...ownedPr } = candidate;
	return ownedPr;
}

export function hasOwnedPrMarker(body, runId, executionIds) {
	if (typeof body !== "string" || typeof runId !== "string") return false;
	const owned = new Set(executionIds);
	const markers = body.matchAll(
		/<!-- flywheel-qa-529-generalized run=([A-Za-z0-9._:-]+) exec=([A-Za-z0-9._:-]+) -->/g,
	);
	for (const marker of markers) {
		if (marker[1] === runId && owned.has(marker[2])) return true;
	}
	return false;
}

export function buildGeneralizedStartRequest(input) {
	return {
		issueId: requiredString(input.issueId, "start.issueId", "workflow start"),
		projectName: requiredString(
			input.projectName,
			"start.projectName",
			"workflow start",
		),
		leadId: requiredString(input.leadId, "start.leadId", "workflow start"),
		taskCategory: "code",
		sessionRole: "main",
		idempotencyKey: requiredString(
			input.idempotencyKey,
			"start.idempotencyKey",
			"workflow start",
		),
		overrides: {
			eng_design: { model: "fable" },
			implement: { model: "codex" },
		},
	};
}

export function validateGeneralizedStartResponse(response) {
	if (!response || response.success !== true || response.generalized !== true) {
		throw new Error(`generalized start refused: ${JSON.stringify(response)}`);
	}
	for (const field of ["executionId", "workflowRunId", "workflowNodeId"]) {
		requiredString(
			response[field],
			`start.${field}`,
			"workflow start response",
		);
	}
	return response;
}

export function nextStubAction(input) {
	if (input.exitRequested) return "exit";
	const completed = new Set(input.completedAttempts ?? []);
	if (input.role === "eng_design") {
		return completed.has(input.attempt) ? "park" : "complete-design";
	}
	if (input.role === "implement") {
		return completed.has(input.attempt) ? "park" : "complete-implement";
	}
	if (input.role === "qa") {
		if (input.attempt === 1) {
			if (completed.has(1)) return "park";
			if (!input.qaFailReady) return "qa-fail-ready";
			return input.qaFailReleased ? "qa-fail" : "park";
		}
		if (input.attempt === 2) {
			if (completed.has(2)) return "park";
			if (!input.qaReady) return "qa-ready";
			if (input.qaPassAttempted) return "park";
			return input.releaseValid ? "qa-pass" : "park";
		}
	}
	throw new Error(
		`unsupported stub role/attempt: ${input.role}/${input.attempt}`,
	);
}

function canonicalTuple(tuple) {
	return {
		runId: requiredString(tuple?.runId, "release.runId", "QA release"),
		executionId: requiredString(
			tuple?.executionId,
			"release.executionId",
			"QA release",
		),
		attempt: tuple?.attempt,
		expectedHead: requiredString(
			tuple?.expectedHead,
			"release.expectedHead",
			"QA release",
		),
	};
}

export function validateQaRelease(release, expected) {
	const actualTuple = canonicalTuple(release);
	const expectedTuple = canonicalTuple(expected);
	if (
		!Number.isInteger(actualTuple.attempt) ||
		!Number.isInteger(expectedTuple.attempt) ||
		JSON.stringify(actualTuple) !== JSON.stringify(expectedTuple)
	) {
		throw new Error(
			`QA release tuple mismatch: expected ${JSON.stringify(expectedTuple)}, got ${JSON.stringify(actualTuple)}`,
		);
	}
	return actualTuple;
}

export function proveOwnedExecutionSet(proven, observed) {
	const left = [...new Set(proven)].sort();
	const right = [...new Set(observed)].sort();
	if (JSON.stringify(left) !== JSON.stringify(right)) {
		throw new Error(
			`execution set drift: proven=${JSON.stringify(left)} observed=${JSON.stringify(right)}`,
		);
	}
}

/**
 * A dead-exec recovery may add a replacement execution to an owned run. The
 * run-scoped binding table is authoritative for that growth, but it may never
 * silently lose an execution already persisted in owner.json.
 */
export function reconcileOwnedExecutionSet(proven, observed) {
	const prior = [...new Set(proven)].sort();
	const current = [...new Set(observed)].sort();
	const currentSet = new Set(current);
	const missing = prior.filter((executionId) => !currentSet.has(executionId));
	if (missing.length > 0) {
		throw new Error(
			`previously owned execution disappeared: ${JSON.stringify(missing)}`,
		);
	}
	return current;
}

function parseTime(value) {
	if (typeof value !== "string" || value.trim() === "") return Number.NaN;
	const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
		? `${value.replace(" ", "T")}Z`
		: value;
	return Date.parse(normalized);
}

function unsettled(reason) {
	return { settled: false, reason };
}

export function classifyDurableLaunchDrain(snapshot, nowMs = Date.now()) {
	for (const claim of snapshot.lifecycleClaims ?? []) {
		if (claim.state === "starting") {
			return unsettled(`lifecycle_starting:${claim.execution_id}`);
		}
	}

	const actors = new Map(
		(snapshot.actors ?? []).map((actor) => [actor.executionId, actor]),
	);
	for (const owner of snapshot.launchOwners ?? []) {
		if (
			owner.committed_generation == null &&
			owner.released_generation == null
		) {
			const leaseExpiresAt = parseTime(owner.lease_expires_at);
			if (!Number.isFinite(leaseExpiresAt)) {
				return unsettled(`launch_owner_invalid_lease:${owner.execution_id}`);
			}
			if (leaseExpiresAt > nowMs) {
				return unsettled(`launch_owner_live:${owner.execution_id}`);
			}
			const acquiredAt = parseTime(owner.acquired_at);
			if (!Number.isFinite(acquiredAt)) {
				return unsettled(
					`launch_owner_invalid_acquired_at:${owner.execution_id}`,
				);
			}
			if (acquiredAt + 10 * 60_000 > nowMs) {
				return unsettled(`launch_owner_absolute_horizon:${owner.execution_id}`);
			}
		}
		if (owner.delivery_state === "repairing") {
			const deliveryLeaseExpiresAt = parseTime(owner.delivery_lease_expires_at);
			if (!Number.isFinite(deliveryLeaseExpiresAt)) {
				return unsettled(
					`delivery_repairing_invalid_lease:${owner.execution_id}`,
				);
			}
			if (deliveryLeaseExpiresAt > nowMs) {
				return unsettled(`delivery_repairing:${owner.execution_id}`);
			}
		}
		if (
			owner.committed_generation != null ||
			owner.delivery_state === "delivered"
		) {
			const actor = actors.get(owner.execution_id);
			if (!actor) return unsettled(`actor_unobserved:${owner.execution_id}`);
			if (actor.liveness !== "dead") {
				return unsettled(`actor_${actor.liveness}:${owner.execution_id}`);
			}
			if (!TERMINAL_SESSION_STATES.has(actor.sessionStatus)) {
				return unsettled(
					`session_unsettled:${owner.execution_id}:${actor.sessionStatus}`,
				);
			}
			if (actor.parkOpen) return unsettled(`park_open:${owner.execution_id}`);
		}
	}

	for (const actor of snapshot.actors ?? []) {
		if (actor.liveness !== "dead") {
			return unsettled(`actor_${actor.liveness}:${actor.executionId}`);
		}
		if (!TERMINAL_SESSION_STATES.has(actor.sessionStatus)) {
			return unsettled(
				`session_unsettled:${actor.executionId}:${actor.sessionStatus}`,
			);
		}
		if (actor.parkOpen) return unsettled(`park_open:${actor.executionId}`);
	}
	return { settled: true, reason: "settled" };
}

export function validateQaShipPreconditions(input) {
	const failures = [];
	if (!input.qaWorktreeBinding) failures.push("qa_worktree_binding_missing");
	if (!Number.isInteger(input.producerPrNumber) || input.producerPrNumber < 1) {
		failures.push("producer_pr_number_missing");
	}
	if (!/^[0-9a-f]{40}$/.test(input.producerPrHead ?? "")) {
		failures.push("producer_pr_head_missing");
	}
	if (!input.gateEntryBinding) {
		failures.push("workflow_node_pr_binding_missing");
	} else {
		if (input.gateEntryBinding.pr_number !== input.producerPrNumber) {
			failures.push("workflow_node_pr_binding_pr_mismatch");
		}
		if (input.gateEntryBinding.head_sha !== input.expectedHead) {
			failures.push("workflow_node_pr_binding_head_mismatch");
		}
	}
	if (!input.remotePr) {
		failures.push("sandbox_pr_missing");
	} else {
		if (input.remotePr.state !== "OPEN") failures.push("sandbox_pr_not_open");
		if (input.remotePr.isDraft !== false) failures.push("sandbox_pr_is_draft");
		if (input.remotePr.headRefOid !== input.expectedHead) {
			failures.push("sandbox_pr_head_mismatch");
		}
	}
	return failures.length === 0
		? { ok: true, failures }
		: {
				ok: false,
				failures,
				predictedServerReason: "land_head_unavailable",
			};
}
