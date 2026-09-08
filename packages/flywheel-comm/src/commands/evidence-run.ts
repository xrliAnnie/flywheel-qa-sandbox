import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import {
	closeSync,
	fsyncSync,
	linkSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { canonicalJsonString, normalizeOptionalBearer } from "flywheel-config";
import { resolveRunnerStateDir } from "../runner-state.js";
import {
	LANES,
	RECORD_ID_PATTERN,
	SHA40_LOWER_PATTERN,
	type StrengthTwoLane,
	validateRerunSpecV1,
} from "../strength-two-contract.js";
import { currentWorkflowCredentialFromEnv } from "./workflow-activation.js";

const ATTEMPTS = 3;
const BACKOFF_MS = [1_000, 2_000] as const;
const ATTEMPT_TIMEOUT_MS = 15_000;

export interface PublishEvidenceRunReceiptOptions {
	stateDir: string;
	recordId: string;
	payload: unknown;
}

export type PublishEvidenceRunReceiptResult =
	| { ok: true; status: "published" | "reused"; path: string }
	| { ok: false; reason: "receipt_conflict" | "receipt_unsafe" };

function safeLstat(path: string): Stats | undefined {
	try {
		return lstatSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

function safeReceiptFile(path: string): boolean {
	const stat = safeLstat(path);
	return Boolean(
		stat &&
			!stat.isSymbolicLink() &&
			stat.isFile() &&
			(stat.mode & 0o777) === 0o600,
	);
}

function fsyncDirectoryBestEffort(path: string): void {
	let fd: number | undefined;
	try {
		fd = openSync(path, "r");
		fsyncSync(fd);
	} catch {
		// The hard-link is already durable enough for filesystems without directory fsync.
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

export function publishEvidenceRunReceipt(
	opts: PublishEvidenceRunReceiptOptions,
): PublishEvidenceRunReceiptResult {
	const evidenceDir = join(opts.stateDir, "evidence-run");
	mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
	const dirStat = lstatSync(evidenceDir);
	if (
		dirStat.isSymbolicLink() ||
		!dirStat.isDirectory() ||
		(dirStat.mode & 0o777) !== 0o700
	) {
		return { ok: false, reason: "receipt_unsafe" };
	}
	const destination = join(evidenceDir, `${opts.recordId}.json`);
	const canonical = `${canonicalJsonString(opts.payload)}\n`;
	const existing = safeLstat(destination);
	if (existing) {
		if (!safeReceiptFile(destination)) {
			return { ok: false, reason: "receipt_unsafe" };
		}
		return readFileSync(destination, "utf8") === canonical
			? { ok: true, status: "reused", path: destination }
			: { ok: false, reason: "receipt_conflict" };
	}

	const temporary = join(
		evidenceDir,
		`.${opts.recordId}.${process.pid}.${randomUUID()}.tmp`,
	);
	let fd: number | undefined;
	try {
		fd = openSync(temporary, "wx", 0o600);
		writeFileSync(fd, canonical, "utf8");
		fsyncSync(fd);
		closeSync(fd);
		fd = undefined;
		try {
			linkSync(temporary, destination);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			if (!safeReceiptFile(destination)) {
				return { ok: false, reason: "receipt_unsafe" };
			}
			return readFileSync(destination, "utf8") === canonical
				? { ok: true, status: "reused", path: destination }
				: { ok: false, reason: "receipt_conflict" };
		}
		fsyncDirectoryBestEffort(evidenceDir);
		return { ok: true, status: "published", path: destination };
	} finally {
		if (fd !== undefined) closeSync(fd);
		try {
			unlinkSync(temporary);
		} catch {
			// Best-effort cleanup; the immutable destination already carries authority.
		}
	}
}

interface EvidenceRunAck {
	ok?: unknown;
	status?: unknown;
	reason?: unknown;
	record?: {
		record_id?: unknown;
		verdict?: unknown;
		ran?: { status?: unknown; reason?: unknown };
		record?: { status?: unknown; reason?: unknown };
	};
}

export interface EvidenceRunRecordOptions {
	execId?: string;
	head?: string;
	site?: string;
	lane?: string;
	driverExitCode?: number;
	recordUrl?: string;
	rerunSpecPath?: string;
	localCopy?: string;
	recordId?: string;
	stateDir?: string;
	env?: NodeJS.ProcessEnv;
	fetchImpl?: typeof fetch;
	credentialResolver?: (
		executionId: string,
		env: NodeJS.ProcessEnv,
	) => string | undefined;
	randomId?: () => string;
	sleepImpl?: (ms: number) => Promise<void>;
	stdout?: (line: string) => void;
	stderr?: (line: string) => void;
	attemptTimeoutMs?: number;
}

function validLocalCopy(path: string | undefined): boolean {
	return (
		path === undefined ||
		(path.length > 0 &&
			Buffer.byteLength(path, "utf8") <= 1_024 &&
			!/[\n\r\0]/.test(path))
	);
}

function safeDiagnostic(value: unknown, secrets: readonly string[]): string {
	let output: string;
	try {
		output = typeof value === "string" ? value : JSON.stringify(value);
	} catch {
		output = "unprintable response";
	}
	for (const secret of secrets) {
		if (secret) output = output.split(secret).join("[REDACTED]");
	}
	return output.replace(/[\r\n]+/g, " ").slice(0, 1_024);
}

function validAck(body: EvidenceRunAck | undefined, recordId: string): boolean {
	return Boolean(
		body?.ok === true &&
			(body.status === "inserted" || body.status === "replayed") &&
			body.record?.record_id === recordId &&
			(body.record.verdict === "satisfied" ||
				body.record.verdict === "unsatisfied") &&
			(body.record.ran?.status === "satisfied" ||
				body.record.ran?.status === "unsatisfied") &&
			typeof body.record.ran?.reason === "string" &&
			(body.record.record?.status === "satisfied" ||
				body.record.record?.status === "unsatisfied") &&
			typeof body.record.record?.reason === "string",
	);
}

function retryableStatus(status: number): boolean {
	return (
		status === 408 ||
		status === 429 ||
		status >= 500 ||
		(status >= 200 && status < 400)
	);
}

export async function evidenceRunRecord(
	opts: EvidenceRunRecordOptions,
): Promise<number> {
	const env = opts.env ?? process.env;
	const stdout = opts.stdout ?? console.log;
	const stderr = opts.stderr ?? console.error;
	const execId = (opts.execId ?? env.FLYWHEEL_EXEC_ID ?? "").trim();
	const head = (opts.head ?? "").trim();
	const site = (opts.site ?? "").trim();
	const lane = (opts.lane ?? "").trim();
	const recordUrl = (opts.recordUrl ?? "").trim();
	const rerunSpecPath = (opts.rerunSpecPath ?? "").trim();
	const recordId =
		(opts.recordId ?? "").trim() || (opts.randomId ?? randomUUID)();
	if (!execId) {
		stderr("evidence-run: --exec-id or FLYWHEEL_EXEC_ID is required");
		return 1;
	}
	if (!SHA40_LOWER_PATTERN.test(head)) {
		stderr("evidence-run: --head must be lowercase 40-hex");
		return 1;
	}
	if (!/^slot_529:[1-9][0-9]*$/.test(site)) {
		stderr("evidence-run: --site must be slot_529:<positive integer>");
		return 1;
	}
	if (!(LANES as readonly string[]).includes(lane)) {
		stderr("evidence-run: --lane is invalid");
		return 1;
	}
	const typedLane = lane as StrengthTwoLane;
	if (typedLane === "manual_test_deploy") {
		if (opts.driverExitCode !== undefined) {
			stderr(
				"evidence-run: --driver-exit-code is forbidden for manual_test_deploy",
			);
			return 1;
		}
	} else if (!Number.isSafeInteger(opts.driverExitCode)) {
		stderr(
			"evidence-run: --driver-exit-code is required for generalized lanes",
		);
		return 1;
	}
	if (!recordUrl.startsWith("https://") || recordUrl.length > 2_048) {
		stderr("evidence-run: --record-url must be a bounded https URL");
		return 1;
	}
	if (!rerunSpecPath) {
		stderr("evidence-run: --rerun-spec is required");
		return 1;
	}
	if (!RECORD_ID_PATTERN.test(recordId)) {
		stderr("evidence-run: --record-id must be a canonical UUID v4");
		return 1;
	}
	if (!validLocalCopy(opts.localCopy)) {
		stderr("evidence-run: --local-copy is unsafe or exceeds 1024 bytes");
		return 1;
	}
	let rawSpec: unknown;
	try {
		rawSpec = JSON.parse(readFileSync(rerunSpecPath, "utf8"));
	} catch (error) {
		stderr(`evidence-run: rerun_spec_invalid:${safeDiagnostic(error, [])}`);
		return 1;
	}
	const validated = validateRerunSpecV1(rawSpec, typedLane);
	if (!validated.ok) {
		stderr(`evidence-run: rerun_spec_invalid:${validated.reason}`);
		return 1;
	}
	const bridgeUrl = (env.FLYWHEEL_BRIDGE_URL ?? "").trim().replace(/\/+$/, "");
	const ingestToken = normalizeOptionalBearer(env.FLYWHEEL_INGEST_TOKEN);
	if (!bridgeUrl || !ingestToken) {
		stderr(
			"evidence-run: FLYWHEEL_BRIDGE_URL and FLYWHEEL_INGEST_TOKEN are required",
		);
		return 1;
	}
	let credential: string | undefined;
	try {
		credential = opts.credentialResolver
			? opts.credentialResolver(execId, env)
			: currentWorkflowCredentialFromEnv({
					executionId: execId,
					kind: "submission",
					envName: "FLYWHEEL_WORKFLOW_SUBMISSION_CREDENTIAL",
					env,
				});
	} catch (error) {
		stderr(`evidence-run: ${safeDiagnostic(error, [ingestToken])}`);
		return 1;
	}
	if (!credential) {
		stderr("evidence-run: FLYWHEEL_WORKFLOW_SUBMISSION_CREDENTIAL is required");
		return 1;
	}
	const wirePayload = {
		record_id: recordId,
		recorder_execution_id: execId,
		head,
		site,
		lane: typedLane,
		...(typedLane === "manual_test_deploy"
			? {}
			: { driver_exit_code: opts.driverExitCode }),
		record_url: recordUrl,
		rerun_spec: validated.value,
		...(opts.localCopy ? { local_copy_path: opts.localCopy } : {}),
	};
	const receiptPayload = { schemaVersion: 1, ...wirePayload };
	let receipt: PublishEvidenceRunReceiptResult;
	try {
		receipt = publishEvidenceRunReceipt({
			stateDir: opts.stateDir ?? resolveRunnerStateDir(execId, env),
			recordId,
			payload: receiptPayload,
		});
	} catch (error) {
		stderr(
			`evidence-run: receipt_unsafe ${safeDiagnostic(error, [credential, ingestToken])}`,
		);
		return 1;
	}
	if (!receipt.ok) {
		stderr(`evidence-run: ${receipt.reason} record_id=${recordId}`);
		return 1;
	}

	const requestBody = { credential, ...wirePayload };
	const fetchImpl = opts.fetchImpl ?? fetch;
	const sleepImpl =
		opts.sleepImpl ??
		((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
	let lastError = "unknown failure";
	for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
		let responseValue: Response | undefined;
		let responseBody: EvidenceRunAck | undefined;
		const controller = new AbortController();
		const timer = setTimeout(
			() => controller.abort(),
			opts.attemptTimeoutMs ?? ATTEMPT_TIMEOUT_MS,
		);
		try {
			responseValue = await fetchImpl(
				`${bridgeUrl}/api/workflow/evidence-run`,
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${ingestToken}`,
					},
					body: JSON.stringify(requestBody),
					signal: controller.signal,
				},
			);
			try {
				responseBody = (await responseValue.json()) as EvidenceRunAck;
			} catch {
				responseBody = undefined;
			}
		} catch (error) {
			lastError = safeDiagnostic(error, [credential, ingestToken]);
		} finally {
			clearTimeout(timer);
		}

		if (responseValue?.status === 200 && validAck(responseBody, recordId)) {
			const record = responseBody!.record!;
			stdout(
				`strength-two: verdict=${record.verdict} ran=${record.ran!.status}/${record.ran!.reason} record=${record.record!.status}/${record.record!.reason} record_id=${recordId}`,
			);
			return 0;
		}
		if (responseValue) {
			lastError = `HTTP ${responseValue.status} ${safeDiagnostic(responseBody ?? "non-json response", [credential, ingestToken])}`;
			if (!retryableStatus(responseValue.status)) {
				stderr(`evidence-run: ${lastError}`);
				return 1;
			}
		}
		stderr(`evidence-run: attempt ${attempt}/${ATTEMPTS} failed: ${lastError}`);
		if (attempt < ATTEMPTS) await sleepImpl(BACKOFF_MS[attempt - 1]!);
	}
	stderr(
		`evidence-run: retryable failure exhausted; rerun with --record-id ${recordId}`,
	);
	return 2;
}

export async function runEvidenceRunCommand(args: string[]): Promise<number> {
	const [subcommand, ...rest] = args;
	if (subcommand !== "record") {
		console.error("evidence-run: expected subcommand record");
		return 1;
	}
	let values: ReturnType<typeof parseArgs>["values"];
	try {
		({ values } = parseArgs({
			args: rest,
			options: {
				"exec-id": { type: "string" },
				head: { type: "string" },
				site: { type: "string" },
				lane: { type: "string" },
				"driver-exit-code": { type: "string" },
				"record-url": { type: "string" },
				"rerun-spec": { type: "string" },
				"local-copy": { type: "string" },
				"record-id": { type: "string" },
			},
			allowPositionals: false,
		}));
	} catch (error) {
		console.error(`evidence-run: ${safeDiagnostic(error, [])}`);
		return 1;
	}
	const driverText = values["driver-exit-code"];
	const driverExitCode =
		typeof driverText === "string" && /^-?\d+$/.test(driverText)
			? Number(driverText)
			: undefined;
	if (
		driverText !== undefined &&
		(!Number.isSafeInteger(driverExitCode) ||
			String(driverExitCode) !== driverText)
	) {
		console.error("evidence-run: --driver-exit-code must be an integer");
		return 1;
	}
	return evidenceRunRecord({
		execId: values["exec-id"] as string | undefined,
		head: values.head as string | undefined,
		site: values.site as string | undefined,
		lane: values.lane as string | undefined,
		driverExitCode,
		recordUrl: values["record-url"] as string | undefined,
		rerunSpecPath: values["rerun-spec"] as string | undefined,
		localCopy: values["local-copy"] as string | undefined,
		recordId: values["record-id"] as string | undefined,
	});
}
