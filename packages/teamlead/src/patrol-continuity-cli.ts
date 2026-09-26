import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	type ContinuityEntry,
	type ContinuityResult,
	continuityDigest,
	evaluateContinuity,
	sampleContinuity,
	validatePatrolReport,
	validSidecar,
} from "./patrol-continuity.js";
import { collectPatrolObservations } from "./patrol-continuity-collector.js";
import { ROOT_CAUSE_OWNER } from "./patrol-root-causes.js";

/**
 * FLY-2914: a shell Lead edits its own report, so a complete or unavailable
 * root-cause section is re-verified by the Bridge against fresh Linear facts
 * and real founder_ask rows. The token comes from the Lead's environment only.
 */
async function verifyRootCausesViaBridge(
	text: string,
	reportPath: string,
): Promise<string[]> {
	const review = text
		.split(/\r?\n/)
		.find((line) => line.startsWith("ROOT_CAUSE_REVIEW "));
	const status = / status=([a-z_]+)(?: |$)/.exec(review ?? "")?.[1];
	const errors: string[] = [];
	const pathLead = /\/patrol-reports\/([^/]+)\/[^/]+$/.exec(reportPath)?.[1];
	const headerLead = /^lead: (.*)$/m.exec(text)?.[1];
	if (pathLead === ROOT_CAUSE_OWNER.leadId && headerLead !== pathLead)
		errors.push("root_cause_scope_mismatch");
	if (status !== "complete" && status !== "unavailable") return errors;
	const base = (process.env.BRIDGE_URL || "http://127.0.0.1:9876").replace(
		/\/+$/,
		"",
	);
	const token = process.env.TEAMLEAD_API_TOKEN ?? "";
	try {
		if (!token) throw Error("token_missing");
		const response = await fetch(`${base}/api/patrol/root-causes/verify`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({ report: text }),
			signal: AbortSignal.timeout(45_000),
		});
		const verdict = (await response.json()) as {
			valid?: unknown;
			errors?: unknown;
		};
		if (!response.ok || typeof verdict.valid !== "boolean")
			throw Error("verifier_failed");
		if (!verdict.valid)
			errors.push(
				...(Array.isArray(verdict.errors)
					? verdict.errors.filter(
							(e): e is string =>
								typeof e === "string" && /^[a-z0-9_]{1,64}$/.test(e),
						)
					: []),
				"root_cause_verification_failed",
			);
	} catch {
		// Both sources down agree with an unavailable section; a complete one is unproven.
		if (status === "complete") errors.push("root_cause_verifier_unavailable");
	}
	return errors;
}

export function activityEvidence(
	result: ContinuityResult,
	exec: string,
	nowMs: number,
): string[] {
	const e = result.entry;
	const source =
		result.activity === "UNKNOWN"
			? "unavailable"
			: result.last_change_basis === "remote_head"
				? "remote_ref"
				: result.last_change_basis === "state_transition"
					? "state"
					: "baseline";
	const start =
		result.activity === "ACTIVE" && e?.lastVeto
			? Math.floor(e.lastVeto.fromMs / 1000)
			: result.interval_start;
	const end = result.interval_end;
	const queue = e?.queueEvidence;
	const record = {
		id: result.key,
		entry: e ?? null,
		sampledAtMs: nowMs,
		activity: result.activity,
		interval_start: start,
		interval_end: end,
	};
	return [
		`ACTIVITY_EVIDENCE id=${result.key} exec=${exec} activation=${e?.identity.activationId ?? "unavailable"} interval_start=${start} interval_end=${end} source=${source} ref_complete=${e?.sourcesComplete && e.refs.length ? "yes" : "no"} refs_sha256=${continuityDigest(e?.refs ?? [])} semantic_sha256=${e?.semanticDigest ?? "unavailable"} coverage_since=${Math.floor((e?.coverageSinceMs ?? nowMs) / 1000)} reason=${result.reason} branch_activity=${result.branch_activity ? "yes" : "no"} queue_request=${queue?.requestId ?? "unavailable"} queue_position=${queue?.position ?? 0} queue_wait_seconds=${Math.floor((queue?.waitMs ?? 0) / 1000)}`,
		`ACTIVITY_RECORD ${JSON.stringify(record)}`,
	];
}
export async function runPatrolContinuity(argv: string[]): Promise<number> {
	try {
		const [command, ...rest] = argv;
		if (!["sample", "validate-report", "--recheck"].includes(command ?? ""))
			throw Error("invalid_command");
		const opts: Record<string, string> = {};
		const allowed =
			command === "validate-report"
				? ["report"]
				: [
						"report",
						"evidence-id",
						"project",
						"lead",
						"db",
						"comm-db",
						"projects",
						"state-dir",
						"executions-file",
						"inventory-complete",
					];
		for (let i = 0; i < rest.length; i += 2) {
			const key = rest[i]?.replace(/^--/, "");
			const value = rest[i + 1];
			if (
				!key ||
				!rest[i]?.startsWith("--") ||
				!allowed.includes(key) ||
				!value ||
				Object.hasOwn(opts, key)
			)
				throw Error("invalid_option");
			opts[key] = value;
		}
		if (command === "validate-report") {
			if (!opts.report) throw Error("report_required");
			const text = readFileSync(opts.report, "utf8");
			const structural = validatePatrolReport(text);
			const errors = [
				...structural.errors,
				...(await verifyRootCausesViaBridge(text, opts.report)),
			];
			const verdict = { valid: errors.length === 0, errors };
			process.stdout.write(`${JSON.stringify(verdict)}\n`);
			return verdict.valid ? 0 : 1;
		}
		let original: ContinuityEntry | undefined;
		let originalRecord: Record<string, unknown> | undefined;
		if (command === "--recheck") {
			if (!opts.report || !/^[a-f0-9]{64}$/.test(opts["evidence-id"] ?? ""))
				throw Error("recheck_identity_required");
			const lines = readFileSync(opts.report, "utf8").split(/\r?\n/);
			const records = lines
				.filter((l) => l.startsWith("ACTIVITY_RECORD "))
				.map((l) => JSON.parse(l.slice(16)))
				.filter((r) => r.id === opts["evidence-id"]);
			if (records.length !== 1) throw Error("recheck_record_missing");
			const record = records[0];
			originalRecord = record;
			original = record.entry;
			if (
				!original ||
				record.activity !== "STALLED_60M" ||
				continuityDigest(original.identity) !== record.id
			)
				throw Error("recheck_record_invalid");
			const evidence = lines.filter((l) =>
				l.startsWith(`ACTIVITY_EVIDENCE id=${record.id} `),
			);
			if (
				evidence.length !== 1 ||
				!evidence[0]?.includes(
					` refs_sha256=${continuityDigest(original.refs)} `,
				)
			)
				throw Error("recheck_ref_mismatch");
			opts.project ??= original.identity.project;
			opts.lead ??= original.identity.lead;
		}
		const project = opts.project ?? "",
			lead = opts.lead ?? process.env.FLYWHEEL_LEAD_ID ?? "";
		if (
			!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(project) ||
			!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(lead)
		)
			throw Error("identity_invalid");
		const stateDir =
			opts["state-dir"] ??
			process.env.FLYWHEEL_STATE_DIR ??
			join(homedir(), ".flywheel");
		const dbPath =
			opts.db ??
			process.env.FLYWHEEL_STATE_DB_PATH ??
			process.env.TEAMLEAD_DB_PATH ??
			join(homedir(), ".flywheel/teamlead.db");
		const commDbPath =
			opts["comm-db"] ?? join(stateDir, "comm", project, "comm.db");
		const projectsFile =
			opts.projects ??
			process.env.FLYWHEEL_PROJECTS_FILE ??
			join(stateDir, "projects.json");
		const nowMs = process.env.PATROL_NOW_EPOCH
			? Number(process.env.PATROL_NOW_EPOCH) * 1000
			: Date.now();
		if (!Number.isSafeInteger(nowMs) || nowMs <= 0)
			throw Error("clock_invalid");
		const executionIds: unknown = original
			? [original.identity.executionId]
			: JSON.parse(readFileSync(opts["executions-file"] ?? "", "utf8"));
		if (
			!Array.isArray(executionIds) ||
			!executionIds.every(
				(id) => typeof id === "string" && /^[A-Za-z0-9_.:-]{1,200}$/.test(id),
			) ||
			new Set(executionIds).size !== executionIds.length
		)
			throw Error("execution_inventory_invalid");
		if (
			opts["inventory-complete"] !== undefined &&
			!["true", "false"].includes(opts["inventory-complete"])
		)
			throw Error("execution_inventory_invalid");
		const collectorInput = {
			dbPath,
			commDbPath,
			projectsFile,
			project,
			lead,
			executionIds: executionIds as string[],
			nowMs,
		};
		if (original && originalRecord) {
			const valid = validSidecar(
				{
					version: 2,
					project,
					lead,
					sampledAtMs: originalRecord.sampledAtMs,
					entries: { [opts["evidence-id"]!]: original },
				},
				{ project, lead, nowMs },
			);
			if (
				!valid ||
				original.identity.project !== project ||
				original.identity.lead !== lead ||
				typeof originalRecord.interval_start !== "number" ||
				typeof originalRecord.interval_end !== "number" ||
				originalRecord.interval_end - originalRecord.interval_start < 3600
			)
				throw Error("recheck_interval_invalid");
			const [current] = await collectPatrolObservations({
				...collectorInput,
				previous: { [original.identity.executionId]: original },
			});
			if (!current) throw Error("recheck_unavailable");
			const result = evaluateContinuity(original, current);
			const same = result.key === opts["evidence-id"];
			const verdict = !same
				? "unknown"
				: result.activity === "ACTIVE"
					? "stalled-falsified"
					: result.activity === "WAITING"
						? "waiting-confirmed"
						: result.activity === "STALLED_60M"
							? "stalled-confirmed"
							: "unknown";
			process.stdout.write(
				`ACTIVITY_RECHECK id=${opts["evidence-id"]} result=${verdict} original_interval_start=${originalRecord.interval_start} original_interval_end=${originalRecord.interval_end}\n${activityEvidence(result, original.identity.executionId, nowMs).join("\n")}\n`,
			);
			return verdict === "unknown" ? 1 : 0;
		}
		const batch = await sampleContinuity({
			path: join(stateDir, "patrol-continuity", lead, `${project}.v2.json`),
			project,
			lead,
			nowMs,
			executionIds: executionIds as string[],
			collect: (previous, signal) =>
				collectPatrolObservations({ ...collectorInput, previous, signal }),
			inventoryComplete: opts["inventory-complete"] === "true",
		});
		const evidence = Object.entries(batch.facts).flatMap(([id, result]) =>
			activityEvidence(result, id, nowMs),
		);
		process.stdout.write(`${JSON.stringify({ ...batch, evidence })}\n`);
		return 0;
	} catch {
		process.stderr.write(
			"PATROL_CONTINUITY_UNAVAILABLE invalid_input_or_source\n",
		);
		return 70;
	}
}
