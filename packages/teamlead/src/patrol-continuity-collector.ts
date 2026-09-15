import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import Database from "better-sqlite3";
import {
	canonicalJsonString,
	canonicalSubmissionDigest,
} from "flywheel-config";
import { VALID_STAGES } from "./bridge/stage-utils.js";
import type {
	ContinuityIdentity,
	ContinuityObservation,
	SemanticState,
} from "./patrol-continuity.js";

type Row = Record<string, any>;
export interface PatrolCollectorInput {
	dbPath: string;
	commDbPath: string;
	projectsFile: string;
	project: string;
	lead: string;
	executionIds: string[];
	nowMs: number;
	previous?: Record<
		string,
		{
			sourceCursors: { stageEventId: number; workflowEventSeq: number };
			semanticState: SemanticState;
			identity?: ContinuityIdentity;
		}
	>;
	gh?: (
		args: string[],
		options: { timeout: number; maxBuffer: number },
	) => Promise<string>;
	signal?: AbortSignal;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{40}$/i;
const SLUG = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const TOKEN = /^[A-Za-z0-9_.:-]{1,200}$/;
const MAX_EVENTS = 10000;
const RUN_TRANSITION_EVENTS = new Set([
	"loop_iteration",
	"loop_reentry_request_committed",
	"loop_limit_escalated",
	"run_held",
	"run_reopened",
	"run_completed",
	"run_terminated",
	"run_terminated_by_supersession",
	"run_terminated_sessionless_gate",
]);
function fail(reason: string): never {
	throw new Error(reason);
}
function slug(value: unknown): string {
	if (
		typeof value !== "string" ||
		!SLUG.test(value) ||
		value.split("/").some((x) => x === "." || x === "..")
	)
		return fail("repo_identity_invalid");
	return value.toLowerCase();
}
function branch(value: unknown): string {
	if (
		typeof value !== "string" ||
		value.length > 1024 ||
		!value ||
		value.startsWith("-") ||
		value.startsWith("/") ||
		value.endsWith("/") ||
		value.endsWith(".") ||
		[...value].some((c) => c.charCodeAt(0) <= 32 || c.charCodeAt(0) === 127) ||
		[...value].some((c) => "~^:?*[\\".includes(c)) ||
		value.includes("..") ||
		value.includes("@{") ||
		value.split("/").some((x) => !x || x.startsWith(".") || x.endsWith(".lock"))
	)
		return fail("ref_binding_invalid");
	return value;
}
function registry(input: PatrolCollectorInput): string {
	const rows: unknown = JSON.parse(readFileSync(input.projectsFile, "utf8"));
	if (!Array.isArray(rows)) return fail("project_registry_invalid");
	const matched = rows.filter((x) => x?.projectName === input.project);
	if (matched.length !== 1) return fail("project_registry_ambiguous");
	return slug(matched[0].projectRepo);
}
function all(db: Database.Database, sql: string, ...args: unknown[]): Row[] {
	return db.prepare(sql).all(...args) as Row[];
}
function one(
	db: Database.Database,
	sql: string,
	...args: unknown[]
): Row | undefined {
	return db.prepare(sql).get(...args) as Row | undefined;
}
function safeError(error: unknown): string {
	const message = error instanceof Error ? error.message : "";
	return /^[a-z_]+$/.test(message) ? message : "source_unavailable";
}
function empty(
	input: PatrolCollectorInput,
	executionId: string,
	reason: string,
): ContinuityObservation {
	return {
		identity: {
			project: input.project,
			lead: input.lead,
			executionId,
			activationId: `unavailable:${executionId}`,
			runId: null,
			nodeId: null,
			attempt: null,
			turnEpoch: null,
			bindingGeneration: "unavailable",
			repoSourceIdentity: "unavailable",
		},
		sampledAtMs: input.nowMs,
		semanticState: {
			sessionStatus: "unknown",
			sessionStage: null,
			nodeState: null,
			turnRelation: "unknown",
			effectiveWait: null,
		},
		refs: [],
		sourcesComplete: false,
		ownershipComplete: false,
		reason,
		semanticTransitions: [],
		sourceCursors: { stageEventId: 0, workflowEventSeq: 0 },
		eventsComplete: false,
		canAttributeRemote: false,
	};
}
interface Target {
	path: string;
	repo: string;
	branch?: string;
	pr?: number;
}
interface Local {
	observation: ContinuityObservation;
	targets: Target[];
	fingerprint: string;
}
/** Retention-sensitive observation only: missing cursor anchors break coverage. No
 * absence in retained session_events/workflow_run_event is treated as proof of
 * historical inactivity. These reads never authorize lifecycle mutations. */
function readLocal(
	input: PatrolCollectorInput,
	executionId: string,
	replay = true,
): Local {
	if (
		!UUID.test(executionId) ||
		!TOKEN.test(input.project) ||
		!TOKEN.test(input.lead) ||
		!Number.isSafeInteger(input.nowMs)
	)
		fail("identity_invalid");
	const rootRepo = registry(input);
	const state = new Database(input.dbPath, {
		readonly: true,
		fileMustExist: true,
	});
	let comm: Database.Database | undefined;
	try {
		comm = new Database(input.commDbPath, {
			readonly: true,
			fileMustExist: true,
		});
		const owner = one(
			comm,
			"SELECT execution_id,project_name,lead_id,status,issue_id FROM sessions WHERE execution_id=?",
			executionId,
		);
		if (
			!owner ||
			owner.project_name !== input.project ||
			owner.lead_id !== input.lead
		)
			fail("ownership_mismatch");
		const session = one(
			state,
			"SELECT execution_id,project_name,status,session_stage,worktree_binding_path,worktree_binding_branch,worktree_binding_generation,repo_baseline_set_json,repo_baseline_set_digest FROM sessions WHERE execution_id=?",
			executionId,
		);
		if (
			!session ||
			session.project_name !== input.project ||
			!session.worktree_binding_generation ||
			!TOKEN.test(session.worktree_binding_generation) ||
			!isAbsolute(session.worktree_binding_path ?? "")
		)
			fail("immutable_binding_missing");
		if (
			session.session_stage !== null &&
			!VALID_STAGES.has(session.session_stage)
		)
			fail("stage_invalid");
		const bindings = all(
			state,
			"SELECT activation_id,execution_id,run_id,node_id,attempt FROM workflow_execution_binding WHERE execution_id=?",
			executionId,
		);
		const projections = all(
			comm,
			"SELECT execution_id,epoch,activation_id,run_id,node_id,attempt FROM runner_workflow_activation WHERE execution_id=? ORDER BY epoch DESC",
			executionId,
		);
		let binding: Row | undefined,
			node: Row | undefined,
			turn: Row | undefined,
			grant: Row | undefined;
		if (bindings.length) {
			const current = projections[0];
			if (!current) fail("activation_projection_missing");
			binding = bindings.find((x) => x.activation_id === current.activation_id);
			if (
				!binding ||
				!/^[A-Za-z0-9_.:-]{1,512}$/.test(binding.activation_id) ||
				!UUID.test(binding.run_id) ||
				!TOKEN.test(binding.node_id) ||
				!Number.isSafeInteger(binding.attempt) ||
				binding.attempt < 1 ||
				binding.run_id !== current.run_id ||
				binding.node_id !== current.node_id ||
				binding.attempt !== current.attempt
			)
				fail("activation_binding_mismatch");
			const run = one(
				state,
				"SELECT project_name,issue_id FROM workflow_run WHERE run_id=?",
				binding.run_id,
			);
			if (
				!run ||
				run.project_name !== input.project ||
				run.issue_id !== owner.issue_id
			)
				fail("workflow_project_mismatch");
			node = one(
				state,
				"SELECT run_id,node_id,attempt,state,execution_id FROM workflow_run_node WHERE run_id=? AND node_id=? ORDER BY attempt DESC LIMIT 1",
				binding.run_id,
				binding.node_id,
			);
			if (
				!node ||
				node.attempt !== binding.attempt ||
				node.execution_id !== executionId
			)
				fail("activation_attempt_mismatch");
			grant = one(
				state,
				"SELECT activation_id,execution_id,issue_id,epoch FROM workflow_activation_turn WHERE activation_id=?",
				binding.activation_id,
			);
			turn = one(
				comm,
				"SELECT issue_id,holder_exec_id,epoch,activation_id,target_run_id,target_node_id,target_attempt FROM three_stage_turn WHERE issue_id=?",
				owner.issue_id,
			);
			if (
				!grant ||
				grant.execution_id !== executionId ||
				grant.issue_id !== owner.issue_id ||
				grant.epoch !== current.epoch ||
				!turn ||
				!Number.isSafeInteger(turn.epoch) ||
				turn.epoch < grant.epoch
			)
				fail("turn_binding_mismatch");
			if (
				turn.holder_exec_id === executionId &&
				(turn.activation_id !== binding.activation_id ||
					turn.epoch !== grant.epoch ||
					turn.target_run_id !== binding.run_id ||
					turn.target_node_id !== binding.node_id ||
					turn.target_attempt !== binding.attempt)
			)
				fail("turn_binding_mismatch");
		} else if (projections.length) fail("activation_binding_missing");
		const holder = !binding || turn?.holder_exec_id === executionId;
		const competing = all(
			state,
			"SELECT execution_id FROM sessions WHERE project_name=? AND worktree_binding_branch=? AND execution_id!=? AND status='running'",
			input.project,
			session.worktree_binding_branch,
			executionId,
		).some((candidate) => {
			const other = one(
				comm!,
				"SELECT issue_id FROM sessions WHERE execution_id=? AND project_name=? AND status='running'",
				candidate.execution_id,
				input.project,
			);
			if (!other) return false;
			const otherTurn = one(
				comm!,
				"SELECT holder_exec_id FROM three_stage_turn WHERE issue_id=?",
				other.issue_id,
			);
			return !otherTurn || otherTurn.holder_exec_id === candidate.execution_id;
		});
		const semanticState: SemanticState = {
			sessionStatus: session.status,
			sessionStage: session.session_stage,
			nodeState: node?.state ?? null,
			turnRelation: binding ? (holder ? "yours" : "not-yours") : "legacy",
			effectiveWait: null,
		};
		const gate = one(
			comm,
			`SELECT id FROM mailbox WHERE from_agent=? AND type='question' AND checkpoint IS NOT NULL AND COALESCE(kind,'')!='report' AND resolved_at IS NULL AND superseded_at IS NULL AND (expires_at IS NULL OR julianday(expires_at)>julianday(?)) ORDER BY created_at,id LIMIT 1`,
			executionId,
			new Date(input.nowMs).toISOString(),
		);
		const declaration = one(
			comm,
			`SELECT kind,created_at FROM runner_declared_states WHERE execution_id=? AND kind IN ('parked','long_task') AND ((kind='parked' AND expires_at IS NULL) OR expires_at>?) ORDER BY created_at DESC LIMIT 1`,
			executionId,
			input.nowMs,
		);
		if (gate) {
			if (!TOKEN.test(gate.id)) fail("gate_identity_invalid");
			semanticState.effectiveWait = { kind: "gate", id: gate.id };
		} else if (declaration)
			semanticState.effectiveWait = {
				kind: declaration.kind,
				id: `${executionId}:${declaration.created_at}`,
			};
		else if (binding && !holder)
			semanticState.effectiveWait = {
				kind: "phase",
				id: `${binding.activation_id}:${turn!.epoch}`,
			};
		const targets: Target[] = [
			{
				path: ".",
				repo: rootRepo,
				branch: branch(session.worktree_binding_branch),
			},
		];
		let source = "project_registry_root";
		if (session.repo_baseline_set_json !== null) {
			const baseline = JSON.parse(session.repo_baseline_set_json);
			if (
				canonicalJsonString(baseline) !== session.repo_baseline_set_json ||
				canonicalSubmissionDigest(baseline) !==
					session.repo_baseline_set_digest ||
				baseline.version !== 1 ||
				!Array.isArray(baseline.repositories) ||
				!baseline.repositories.length
			)
				fail("repository_baseline_invalid");
			const seen = new Set<string>();
			for (const entry of baseline.repositories) {
				const path = entry.relative_path;
				if (
					typeof path !== "string" ||
					(!TOKEN.test(path) && !/^[-A-Za-z0-9_./]+$/.test(path)) ||
					isAbsolute(path) ||
					path.split("/").some((x: string) => x === ".." || x === "") ||
					seen.has(path) ||
					!SHA.test(entry.baseline_head) ||
					typeof entry.remote_identity !== "string" ||
					!entry.remote_identity.startsWith("github.com/")
				)
					fail("repository_baseline_invalid");
				seen.add(path);
				const repo = slug(entry.remote_identity.slice(11));
				if (path === "." && repo !== rootRepo)
					fail("repository_baseline_conflict");
				if (path !== ".") targets.push({ path, repo });
			}
			if (!seen.has(".")) fail("repository_baseline_invalid");
			source = "sealed_root";
		}
		const prs = binding
			? all(
					state,
					"SELECT pr_number,target_repo_identity,probe_repo_slug,target_repo_path,worktree_binding_generation FROM workflow_node_pr_binding WHERE run_id=? AND node_id=? AND attempt=?",
					binding.run_id,
					binding.node_id,
					binding.attempt,
				)
			: [];
		for (const pr of prs) {
			if (
				pr.worktree_binding_generation !==
					session.worktree_binding_generation ||
				!Number.isSafeInteger(pr.pr_number) ||
				pr.pr_number < 1 ||
				!isAbsolute(pr.target_repo_path)
			)
				fail("pr_binding_invalid");
			const path =
				relative(session.worktree_binding_path, pr.target_repo_path).replaceAll(
					"\\",
					"/",
				) || ".";
			if (
				path.startsWith("../") ||
				path === ".." ||
				isAbsolute(path) ||
				resolve(session.worktree_binding_path, path) !==
					resolve(pr.target_repo_path)
			)
				fail("pr_target_escape");
			if (
				pr.target_repo_identity !==
				(path === "." ? "__main__" : slug(pr.probe_repo_slug))
			)
				fail("pr_target_identity_mismatch");
			const repo = slug(pr.probe_repo_slug);
			let target = targets.find((x) => x.path === path);
			if (target && target.repo !== repo) fail("pr_repo_identity_mismatch");
			if (!target) {
				target = { path, repo };
				targets.push(target);
			}
			target.pr = pr.pr_number;
			delete target.branch;
		}
		const observation: ContinuityObservation = {
			identity: {
				project: input.project,
				lead: input.lead,
				executionId,
				activationId: binding?.activation_id ?? `legacy:${executionId}`,
				runId: binding?.run_id ?? null,
				nodeId: binding?.node_id ?? null,
				attempt: binding?.attempt ?? null,
				turnEpoch: turn?.epoch ?? null,
				bindingGeneration: session.worktree_binding_generation,
				repoSourceIdentity: canonicalJsonString({ source, targets }),
			},
			sampledAtMs: input.nowMs,
			semanticState,
			refs: [],
			sourcesComplete: targets.every((x) => x.branch || x.pr),
			ownershipComplete: true,
			sourceCursors: { stageEventId: 0, workflowEventSeq: 0 },
			eventsComplete: true,
			canAttributeRemote: holder && !competing,
			semanticTransitions: [],
		};
		if (!observation.sourcesComplete)
			observation.reason = "ref_binding_incomplete";
		if (replay) readEvents(state, input, observation);
		return {
			observation,
			targets,
			fingerprint: canonicalJsonString({
				identity: observation.identity,
				semanticState,
				targets,
				competing,
				owner,
				grant,
				turn,
			}),
		};
	} finally {
		comm?.close();
		state.close();
	}
}
function readEvents(
	db: Database.Database,
	input: PatrolCollectorInput,
	observation: ContinuityObservation,
): void {
	const id = observation.identity.executionId,
		previous = input.previous?.[id],
		cursor = previous?.sourceCursors;
	const stages = all(
		db,
		"SELECT id,payload,ts FROM session_events WHERE execution_id=? AND event_type='stage_changed' AND id>=? ORDER BY id LIMIT ?",
		id,
		cursor?.stageEventId ?? 0,
		MAX_EVENTS + 1,
	);
	const events = observation.identity.runId
		? all(
				db,
				"SELECT seq,node_id,execution_id,kind,payload,at FROM workflow_run_event WHERE run_id=? AND seq>=? ORDER BY seq LIMIT ?",
				observation.identity.runId,
				cursor?.workflowEventSeq ?? 0,
				MAX_EVENTS + 1,
			)
		: [];
	observation.sourceCursors = {
		stageEventId: stages.at(-1)?.id ?? 0,
		workflowEventSeq: events.at(-1)?.seq ?? 0,
	};
	if (
		stages.length > MAX_EVENTS ||
		events.length > MAX_EVENTS ||
		(cursor?.stageEventId && stages[0]?.id !== cursor.stageEventId) ||
		(cursor?.workflowEventSeq && events[0]?.seq !== cursor.workflowEventSeq)
	) {
		observation.eventsComplete = false;
		observation.reason = "event_coverage_gap";
		return;
	}
	// First observation establishes a baseline; retained older events cannot date it.
	if (!previous) return;
	let state = { ...previous.semanticState };
	const transitions: Array<{ atMs: number; state: SemanticState }> = [];
	try {
		for (const event of stages) {
			if (event.id <= (cursor?.stageEventId ?? 0)) continue;
			const payload = JSON.parse(event.payload);
			if (!VALID_STAGES.has(payload.stage)) fail("stage_event_invalid");
			if (payload.stage !== state.sessionStage) {
				state = { ...state, sessionStage: payload.stage };
				transitions.push({ atMs: input.nowMs, state: { ...state } });
			}
		}
		let last = cursor?.workflowEventSeq ?? 0;
		for (const event of events) {
			if (event.seq <= last) continue;
			if (last && event.seq !== last + 1) fail("event_coverage_gap");
			last = event.seq;
			// These producers can release holds, reopen/re-enter nodes, or settle
			// the run without an exact affected node on the event. StateStore's
			// loop_iteration (legacy kickback) is explicitly node-less. Absence
			// of our node id therefore cannot establish a neutral interval.
			if (RUN_TRANSITION_EVENTS.has(event.kind))
				fail("run_event_transition_unavailable");
			if (event.node_id !== observation.identity.nodeId) continue;
			if (event.execution_id !== id) {
				if (event.kind === "node_output_written") continue;
				fail("node_event_identity_unavailable");
			}
			if (event.kind === "node_completed") {
				const payload = JSON.parse(event.payload);
				if (!Number.isSafeInteger(payload.attempt)) fail("node_event_invalid");
				if (payload.attempt !== observation.identity.attempt) continue;
				if (state.nodeState !== "done") {
					state = { ...state, nodeState: "done" };
					transitions.push({ atMs: input.nowMs, state: { ...state } });
				}
			} else if (event.kind === "node_output_written") {
				// submitWorkflowNodeOutput changes only the output/credential
				// ledgers. Verify its actual payload before treating it as neutral.
				const payload = JSON.parse(event.payload);
				if (
					!Number.isSafeInteger(payload.attempt) ||
					payload.attempt < 1 ||
					!Number.isSafeInteger(payload.outputId) ||
					payload.outputId < 1
				)
					fail("node_event_invalid");
			} else {
				// node_dispatched has pending/running producers; unknown events
				// (including future node transitions) have no verified decoder.
				// Never silently infer A -> A from matching sampled endpoints.
				fail("node_event_transition_unavailable");
			}
		}
		if (
			canonicalJsonString(state) !==
			canonicalJsonString(observation.semanticState)
		)
			transitions.push({ atMs: input.nowMs, state: observation.semanticState });
		observation.semanticTransitions = transitions;
	} catch (error) {
		observation.eventsComplete = false;
		observation.reason = safeError(error);
	}
}
const defaultGh: NonNullable<PatrolCollectorInput["gh"]> = (args, options) =>
	new Promise((resolve, reject) =>
		execFile(
			"gh",
			args,
			{
				encoding: "utf8",
				timeout: options.timeout,
				maxBuffer: options.maxBuffer,
				killSignal: "SIGKILL",
			},
			(error, stdout) => (error ? reject(error) : resolve(stdout)),
		),
	);
/** All remote operations are GET, argv-only, fixed github.com host, globally
 * bounded to four calls at once and a 30-second collection deadline. */
export async function collectPatrolObservations(
	input: PatrolCollectorInput,
): Promise<ContinuityObservation[]> {
	const deadline = Date.now() + 30000;
	let active = 0;
	const queue: Array<() => void> = [];
	async function api(path: string): Promise<Row> {
		if (active >= 4) await new Promise<void>((resolve) => queue.push(resolve));
		else active++;
		try {
			const remaining = deadline - Date.now();
			if (remaining <= 0 || input.signal?.aborted) fail("remote_probe_timeout");
			const timeout = Math.min(5000, remaining);
			let timer: ReturnType<typeof setTimeout> | undefined;
			const raw = await Promise.race([
				(input.gh ?? defaultGh)(
					["api", "--hostname", "github.com", "--method", "GET", path],
					{ timeout, maxBuffer: 1048576 },
				),
				new Promise<never>((_, reject) => {
					timer = setTimeout(
						() => reject(new Error("remote_probe_timeout")),
						timeout,
					);
				}),
			]).finally(() => clearTimeout(timer));
			if (Buffer.byteLength(raw) > 1048576) fail("remote_output_limit");
			const value = JSON.parse(raw);
			if (!value || typeof value !== "object" || Array.isArray(value))
				fail("remote_schema_invalid");
			return value;
		} finally {
			const next = queue.shift();
			if (next) next();
			else active--;
		}
	}
	async function probe(
		target: Target,
		resolved: (repo: string, ref: string) => void,
	): Promise<ContinuityObservation["refs"][number]> {
		let repo = target.repo,
			ref = target.branch,
			prHead: string | undefined;
		const endpoint = `/repos/${repo}/pulls/${target.pr}`;
		function parsePr(value: Row) {
			if (
				slug(value.base?.repo?.full_name) !== target.repo ||
				!SHA.test(value.head?.sha)
			)
				fail("pr_response_invalid");
			return {
				repo: slug(value.head?.repo?.full_name),
				ref: branch(value.head?.ref),
				sha: value.head.sha as string,
			};
		}
		if (target.pr) {
			const pr = parsePr(await api(endpoint));
			repo = pr.repo;
			ref = pr.ref;
			prHead = pr.sha;
		}
		if (!ref) fail("ref_binding_incomplete");
		resolved(repo, ref);
		const result = await api(
			`/repos/${repo}/git/ref/heads/${encodeURIComponent(ref)}`,
		);
		if (!SHA.test(result.object?.sha)) fail("remote_sha_invalid");
		if (target.pr) {
			const second = parsePr(await api(endpoint));
			if (
				second.repo !== repo ||
				second.ref !== ref ||
				second.sha !== prHead ||
				result.object.sha !== prHead
			)
				fail("remote_ref_race");
		}
		return {
			repoIdentity: repo,
			fullRef: `refs/heads/${ref}`,
			headSha: result.object.sha.toLowerCase(),
			observedAtMs: input.nowMs,
		};
	}
	const ids = [...new Set(input.executionIds)];
	return Promise.all(
		ids.map(async (id) => {
			let local: Local;
			try {
				local = readLocal(input, id);
			} catch (error) {
				return empty(input, id, safeError(error));
			}
			const observation = local.observation;
			const resolvedRefs: Record<string, { repo: string; ref: string }> = {};
			const source = JSON.parse(observation.identity.repoSourceIdentity);
			const previousIdentity = input.previous?.[id]?.identity;
			if (
				previousIdentity &&
				previousIdentity.activationId === observation.identity.activationId &&
				previousIdentity.bindingGeneration ===
					observation.identity.bindingGeneration &&
				previousIdentity.turnEpoch === observation.identity.turnEpoch
			) {
				try {
					const prior = JSON.parse(previousIdentity.repoSourceIdentity);
					if (
						canonicalJsonString({
							source: prior.source,
							targets: prior.targets,
						}) === canonicalJsonString(source)
					)
						Object.assign(resolvedRefs, prior.resolvedRefs ?? {});
				} catch {
					/* unavailable previous source cannot supply a ref binding */
				}
			}
			const results = await Promise.allSettled(
				local.targets.map((target) =>
					probe(target, (repo, ref) => {
						resolvedRefs[target.path] = { repo, ref };
					}),
				),
			);
			observation.identity.repoSourceIdentity = canonicalJsonString({
				...source,
				resolvedRefs,
			});
			for (const result of results) {
				if (result.status === "fulfilled") observation.refs.push(result.value);
				else {
					observation.sourcesComplete = false;
					observation.reason = safeError(result.reason);
				}
			}
			try {
				if (input.signal?.aborted) fail("collection_cancelled");
				const reread = readLocal(input, id, false);
				if (reread.fingerprint !== local.fingerprint)
					fail("identity_changed_during_probe");
			} catch (error) {
				observation.ownershipComplete = false;
				observation.sourcesComplete = false;
				observation.canAttributeRemote = false;
				observation.refs = [];
				observation.reason = safeError(error);
			}
			return observation;
		}),
	);
}
