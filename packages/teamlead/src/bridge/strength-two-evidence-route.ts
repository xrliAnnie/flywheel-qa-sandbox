import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import express from "express";
import {
	canonicalizeRerunSpec,
	deriveRerunArgv,
	LANES,
	RECORD_ID_PATTERN,
	type RerunSpecV1,
	renderRerunCommand,
	SHA40_LOWER_PATTERN,
	type StrengthTwoLane,
	validateRerunSpecV1,
} from "flywheel-comm/strength-two-contract";
import type {
	StateStore,
	StrengthTwoEvidenceRecordRow,
	WorkflowSubmissionCredentialRow,
} from "../StateStore.js";
import type { WorkflowHeadAuthority } from "./head-authority.js";
import { resolveWorkflowHeadAuthority } from "./head-authority.js";
import type { ReportHostOverride } from "./report-host-override.js";
import {
	buildProbeDetail,
	classifyRecordUrl,
	probeRecord as defaultProbeRecord,
	probeSite as defaultProbeSite,
	resolveSiteBridgePort as defaultResolveSiteBridgePort,
	type ProbeRecordOptions,
	type RecordProbeResult,
	type SiteProbeOptions,
	type SiteProbeResult,
	type SiteStructuralFailure,
	type StrengthTwoReportRegistry,
} from "./strength-two-probes.js";
import { rejectNonLoopback } from "./workflow-decision-routes.js";

const MAX_IN_FLIGHT = 4;
const BODY_REQUIRED_KEYS = [
	"credential",
	"record_id",
	"recorder_execution_id",
	"head",
	"site",
	"lane",
	"record_url",
	"rerun_spec",
] as const;
const BODY_OPTIONAL_KEYS = ["driver_exit_code", "local_copy_path"] as const;
const EMPTY_REGISTRY: StrengthTwoReportRegistry = {
	list: () => [],
	readReportHtml: () => {
		throw new Error("strength-two report registry not configured");
	},
};

interface StrengthTwoEvidenceBody {
	credential: string;
	recordId: string;
	recorderExecutionId: string;
	headSha: string;
	siteSlot: number;
	lane: StrengthTwoLane;
	driverExitCode: number | null;
	recordUrl: string;
	rerunSpec: RerunSpecV1;
	rerunSpecCanonical: string;
	localCopyPath: string | null;
}

type ProbeSiteFn = (opts: SiteProbeOptions) => Promise<SiteProbeResult>;
type ProbeRecordFn = (opts: ProbeRecordOptions) => Promise<RecordProbeResult>;

export interface StrengthTwoEvidenceRouterDeps {
	store: StateStore;
	registry?: StrengthTwoReportRegistry;
	hostOverride?: Pick<ReportHostOverride, "publicBaseUrl">;
	vercelProjectName?: string | (() => string | undefined);
	slotsFilePath?: string;
	resolveSiteBridgePort?: (
		slotsFilePath: string,
		slot: number,
	) => number | undefined;
	probeSite?: ProbeSiteFn;
	probeRecord?: ProbeRecordFn;
	resolveHeadAuthority?: (
		store: Pick<StateStore, "getSession">,
		executionId: string,
	) => Promise<WorkflowHeadAuthority>;
	now?: () => string;
	maxInFlight?: number;
}

function rejection(res: express.Response, reason: string, status = 422): void {
	res.status(status).json({
		ok: false,
		reason: `evidence_run_rejected:${reason}`,
	});
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseBody(
	value: unknown,
	urlOptions: {
		vercelProjectName?: string;
		hostOverride?: Pick<ReportHostOverride, "publicBaseUrl">;
	},
): { ok: true; body: StrengthTwoEvidenceBody } | { ok: false; reason: string } {
	const input = objectValue(value);
	if (!input) return { ok: false, reason: "body_shape" };
	const allowed = new Set([...BODY_REQUIRED_KEYS, ...BODY_OPTIONAL_KEYS]);
	if (
		!BODY_REQUIRED_KEYS.every((key) => Object.hasOwn(input, key)) ||
		Object.keys(input).some((key) => !allowed.has(key as never))
	) {
		return { ok: false, reason: "body_shape" };
	}
	const credential = stringValue(input.credential);
	const recordId = stringValue(input.record_id);
	const recorderExecutionId = stringValue(input.recorder_execution_id);
	const headSha = stringValue(input.head);
	const site = stringValue(input.site);
	const lane = stringValue(input.lane);
	const recordUrl = stringValue(input.record_url);
	if (!credential || !recorderExecutionId || !recordUrl) {
		return { ok: false, reason: "body_shape" };
	}
	if (!recordId || !RECORD_ID_PATTERN.test(recordId)) {
		return { ok: false, reason: "record_id_invalid" };
	}
	if (!headSha || !SHA40_LOWER_PATTERN.test(headSha)) {
		return { ok: false, reason: "head_invalid" };
	}
	if (!site) return { ok: false, reason: "site_invalid" };
	if (!site.startsWith("slot_529:")) {
		return { ok: false, reason: "site_kind_unsupported" };
	}
	const slotText = site.slice("slot_529:".length);
	const siteSlot = Number(slotText);
	if (
		!/^\d+$/.test(slotText) ||
		!Number.isSafeInteger(siteSlot) ||
		siteSlot < 1
	) {
		return { ok: false, reason: "site_invalid" };
	}
	if (!lane || !(LANES as readonly string[]).includes(lane)) {
		return { ok: false, reason: "lane_invalid" };
	}
	const typedLane = lane as StrengthTwoLane;
	let driverExitCode: number | null;
	if (typedLane === "manual_test_deploy") {
		if (Object.hasOwn(input, "driver_exit_code")) {
			return { ok: false, reason: "driver_exit_code_forbidden" };
		}
		driverExitCode = null;
	} else {
		if (!Number.isSafeInteger(input.driver_exit_code)) {
			return { ok: false, reason: "driver_exit_code_required" };
		}
		driverExitCode = Number(input.driver_exit_code);
	}
	const rerun = validateRerunSpecV1(input.rerun_spec, typedLane);
	if (!rerun.ok) {
		return { ok: false, reason: `rerun_spec_invalid:${rerun.reason}` };
	}
	if (classifyRecordUrl(recordUrl, urlOptions).kind === "unsupported") {
		return { ok: false, reason: "record_url_kind_unsupported" };
	}
	let localCopyPath: string | null = null;
	if (Object.hasOwn(input, "local_copy_path")) {
		if (
			typeof input.local_copy_path !== "string" ||
			input.local_copy_path.length < 1 ||
			Buffer.byteLength(input.local_copy_path, "utf8") > 1_024 ||
			/[\n\r\0]/.test(input.local_copy_path)
		) {
			return { ok: false, reason: "body_shape" };
		}
		localCopyPath = input.local_copy_path;
	}
	return {
		ok: true,
		body: {
			credential,
			recordId,
			recorderExecutionId,
			headSha,
			siteSlot,
			lane: typedLane,
			driverExitCode,
			recordUrl,
			rerunSpec: rerun.value,
			rerunSpecCanonical: canonicalizeRerunSpec(rerun.value),
			localCopyPath,
		},
	};
}

function exactReplay(
	row: StrengthTwoEvidenceRecordRow,
	credential: WorkflowSubmissionCredentialRow,
	body: StrengthTwoEvidenceBody,
): boolean {
	return (
		row.recorder_credential_id === credential.id &&
		row.recorder_activation_id === credential.activation_id &&
		row.recorder_execution_id === credential.execution_id &&
		row.run_id === credential.run_id &&
		row.recorder_node_id === credential.node_id &&
		row.recorder_attempt === credential.attempt &&
		row.head_sha === body.headSha &&
		row.site_slot === body.siteSlot &&
		row.lane === body.lane &&
		row.driver_exit_code === body.driverExitCode &&
		row.record_url === body.recordUrl &&
		row.rerun_spec === body.rerunSpecCanonical &&
		row.local_copy_path === body.localCopyPath
	);
}

function responseRecord(row: StrengthTwoEvidenceRecordRow) {
	return {
		record_id: row.record_id,
		run_id: row.run_id,
		target_repo_identity: row.target_repo_identity,
		head_sha: row.head_sha,
		verdict: row.verdict,
		ran: { status: row.ran_status, reason: row.ran_reason },
		record: {
			status: row.record_status,
			reason: row.record_reason,
			http_status: row.record_http_status,
			digest: row.record_digest,
			bytes: row.record_bytes,
		},
		rerun_command: row.rerun_command,
	};
}

function credentialPreflight(
	deps: StrengthTwoEvidenceRouterDeps,
	credential: WorkflowSubmissionCredentialRow,
	now: string,
): string | undefined {
	const result = deps.store.preflightStrengthTwoEvidenceCredential(
		credential.id,
		now,
	);
	return result.ok ? undefined : `recorder_${result.reason}`;
}

function safeWorktreePath(path: string): boolean {
	return (
		isAbsolute(path) &&
		Buffer.byteLength(path, "utf8") <= 1_024 &&
		!/[\n\r\0]/.test(path)
	);
}

function isStructuralSiteFailure(
	probe: SiteProbeResult,
): probe is SiteStructuralFailure {
	return (
		!probe.ok &&
		(probe.reason === "port_unresolved" || probe.reason === "port_is_self")
	);
}

function projectName(deps: StrengthTwoEvidenceRouterDeps): string | undefined {
	return typeof deps.vercelProjectName === "function"
		? deps.vercelProjectName()
		: deps.vercelProjectName;
}

function validateExtraSlots(
	deps: StrengthTwoEvidenceRouterDeps,
	body: StrengthTwoEvidenceBody,
	slotsFilePath: string,
): string | undefined {
	for (const extra of body.rerunSpec.deploy.extraLeads ?? []) {
		if (extra.slot === body.siteSlot) return "extra_slot_is_main";
		if (
			(deps.resolveSiteBridgePort ?? defaultResolveSiteBridgePort)(
				slotsFilePath,
				extra.slot,
			) === undefined
		) {
			return "extra_slot_missing";
		}
	}
	return undefined;
}

/** Credential-bound, append-only recording of both strength-two evidence halves. */
export function createStrengthTwoEvidenceRouter(
	deps: StrengthTwoEvidenceRouterDeps,
): express.Router {
	const router = express.Router();
	let inFlight = 0;
	router.post("/evidence-run", async (req, res) => {
		if (rejectNonLoopback(req, res)) return;
		if (inFlight >= (deps.maxInFlight ?? MAX_IN_FLIGHT)) {
			res.status(429).json({ ok: false, reason: "busy" });
			return;
		}
		inFlight += 1;
		try {
			let urlOptions: {
				vercelProjectName?: string;
				hostOverride?: Pick<ReportHostOverride, "publicBaseUrl">;
			};
			try {
				urlOptions = {
					vercelProjectName: projectName(deps),
					hostOverride: deps.hostOverride,
				};
			} catch {
				res.status(500).json({
					ok: false,
					reason: "probe_infrastructure_failure:record",
				});
				return;
			}
			const parsed = parseBody(req.body, urlOptions);
			if (!parsed.ok) {
				rejection(res, parsed.reason);
				return;
			}
			const body = parsed.body;
			const credential = deps.store.getWorkflowSubmissionCredentialByToken(
				body.credential,
			);
			if (!credential) {
				rejection(res, "recorder_credential_unknown");
				return;
			}
			if (credential.family !== "qa_verdict") {
				rejection(res, "recorder_credential_family");
				return;
			}
			if (credential.execution_id !== body.recorderExecutionId) {
				rejection(res, "recorder_credential_mismatch");
				return;
			}

			const existing = deps.store.getStrengthTwoEvidenceRecord(body.recordId);
			if (existing) {
				if (!exactReplay(existing, credential, body)) {
					res.status(409).json({ ok: false, reason: "record_conflict" });
					return;
				}
				res.json({
					ok: true,
					status: "replayed",
					record: responseRecord(existing),
				});
				return;
			}

			const session = deps.store.getSession(credential.execution_id);
			if (
				!session ||
				session.session_role !== "qa" ||
				session.chat_thread_role !== "qa"
			) {
				rejection(res, "recorder_not_durable_qa");
				return;
			}
			const now = deps.now?.() ?? new Date().toISOString();
			const preflight = credentialPreflight(deps, credential, now);
			if (preflight) {
				rejection(res, preflight);
				return;
			}

			let authority: WorkflowHeadAuthority;
			try {
				authority = await (
					deps.resolveHeadAuthority ?? resolveWorkflowHeadAuthority
				)(deps.store, credential.execution_id);
			} catch (error) {
				const reason =
					error instanceof Error ? error.message : "git_head_unavailable";
				rejection(res, `head_authority_unavailable:${reason}`);
				return;
			}
			if (authority.prHeadSha !== body.headSha) {
				res.status(422).json({
					ok: false,
					reason: "evidence_run_rejected:head_authority_mismatch",
					expectedHeadSha: authority.prHeadSha,
				});
				return;
			}
			if (!safeWorktreePath(authority.worktreePath)) {
				rejection(res, "recorder_worktree_unsafe");
				return;
			}

			const slotsFilePath =
				deps.slotsFilePath ?? join(homedir(), ".flywheel", "test-slots.json");
			const siteBridgePort = (
				deps.resolveSiteBridgePort ?? defaultResolveSiteBridgePort
			)(slotsFilePath, body.siteSlot);
			if (siteBridgePort === undefined) {
				rejection(res, "slot_port_unresolved");
				return;
			}
			if (siteBridgePort === req.socket.localPort) {
				rejection(res, "slot_port_is_self");
				return;
			}
			const extraSlotFailure = validateExtraSlots(deps, body, slotsFilePath);
			if (extraSlotFailure) {
				rejection(res, `rerun_spec_invalid:${extraSlotFailure}`);
				return;
			}

			const startedAt = Date.now();
			const [siteSettled, recordSettled] = await Promise.allSettled([
				(deps.probeSite ?? defaultProbeSite)({
					slot: body.siteSlot,
					selfPort: req.socket.localPort,
					slotsFilePath,
					resolvedPort: siteBridgePort,
				}),
				(deps.probeRecord ?? defaultProbeRecord)({
					url: body.recordUrl,
					registry: deps.registry ?? EMPTY_REGISTRY,
					vercelProjectName: urlOptions.vercelProjectName,
					hostOverride: deps.hostOverride,
					now: () => Date.parse(now),
				}),
			]);
			if (siteSettled.status === "rejected") {
				res.status(500).json({
					ok: false,
					reason: "probe_infrastructure_failure:site",
				});
				return;
			}
			if (recordSettled.status === "rejected") {
				res.status(500).json({
					ok: false,
					reason: "probe_infrastructure_failure:record",
				});
				return;
			}
			const siteProbe = siteSettled.value;
			if (isStructuralSiteFailure(siteProbe)) {
				rejection(
					res,
					siteProbe.reason === "port_unresolved"
						? "slot_port_unresolved"
						: "slot_port_is_self",
				);
				return;
			}
			const recordProbe = recordSettled.value;
			if (recordProbe.kind === "unsupported") {
				rejection(res, "record_url_kind_unsupported");
				return;
			}
			const rerunArgv = deriveRerunArgv({
				spec: body.rerunSpec,
				siteSlot: body.siteSlot,
				headSha: body.headSha,
			});
			const rerunCommand = renderRerunCommand({
				worktreePath: authority.worktreePath,
				headSha: body.headSha,
				argv: rerunArgv,
			});
			const result = deps.store.recordStrengthTwoEvidenceByCredential({
				credential: body.credential,
				recordId: body.recordId,
				callerFacts: {
					recorderExecutionId: body.recorderExecutionId,
					headSha: body.headSha,
					siteSlot: body.siteSlot,
					lane: body.lane,
					driverExitCode: body.driverExitCode,
					recordUrl: body.recordUrl,
					rerunSpec: body.rerunSpecCanonical,
					localCopyPath: body.localCopyPath,
				},
				authority: {
					headSha: authority.prHeadSha,
					worktreePath: authority.worktreePath,
				},
				siteBridgePort,
				siteProbe,
				recordProbe,
				rerun: { argv: rerunArgv, command: rerunCommand },
				probeDetail: buildProbeDetail({
					durationMs: Date.now() - startedAt,
					site: siteProbe,
					record: recordProbe,
				}),
				now,
			});
			if (!result.ok) {
				if (result.reason === "record_conflict") {
					res.status(409).json({ ok: false, reason: "record_conflict" });
					return;
				}
				const reason =
					result.reason === "credential_not_found"
						? "recorder_credential_unknown"
						: result.reason === "credential_family_mismatch"
							? "recorder_credential_family"
							: result.reason === "credential_execution_mismatch"
								? "recorder_credential_mismatch"
								: result.reason === "credential_not_durable_qa"
									? "recorder_not_durable_qa"
									: result.reason === "authority_head_mismatch"
										? "head_authority_mismatch"
										: result.reason.startsWith("not_current_writer:")
											? `recorder_${result.reason}`
											: `recorder_${result.reason}`;
				rejection(res, reason);
				return;
			}
			res.json({
				ok: true,
				status: result.status,
				record: responseRecord(result.row),
			});
		} catch {
			res
				.status(500)
				.json({ ok: false, reason: "evidence_run_internal_error" });
		} finally {
			inFlight -= 1;
		}
	});
	return router;
}
