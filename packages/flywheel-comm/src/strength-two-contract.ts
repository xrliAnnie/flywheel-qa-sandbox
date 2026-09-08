import { canonicalJsonString } from "flywheel-config";

export const LANES = [
	"generalized_e2e_stub",
	"generalized_e2e_real",
	"manual_test_deploy",
] as const;
export type StrengthTwoLane = (typeof LANES)[number];

export const RAN_REASONS = [
	"ok",
	"site_unreachable",
	"site_timeout",
	"site_bad_payload",
	"site_not_ready",
	"site_head_mismatch",
	"lane_unproven",
	"driver_nonzero",
] as const;
export type RanReason = (typeof RAN_REASONS)[number];

export const RECORD_REASONS = [
	"ok",
	"url_not_in_registry",
	"url_expired",
	"url_timeout",
	"url_unreachable",
	"url_http_error",
	"url_body_too_large",
	"digest_mismatch",
	"gh_timeout",
	"gh_unreachable",
	"gh_not_found",
	"gh_forbidden",
	"gh_bad_payload",
	"gh_url_mismatch",
] as const;
export type RecordReason = (typeof RECORD_REASONS)[number];

export const RECORD_ID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const SHA40_LOWER_PATTERN = /^[0-9a-f]{40}$/;
export const SHA256_PATTERN = /^[0-9a-f]{64}$/;

const ISSUE_PATTERN = /^[A-Z]+-\d+$/;
const LABEL_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const MAX_EXTRA_LEADS = 4;
const MIN_DRIVER_TIMEOUT_MS = 10_000;
const MAX_DRIVER_TIMEOUT_MS = 3_600_000;

export interface RerunExtraLeadV1 {
	slot: number;
	deptLabel: string;
}

export interface RerunDeploySharedV1 {
	leadLabel?: string;
	extraLeads?: RerunExtraLeadV1[];
}

export interface GeneralizedRerunSpecV1 {
	schemaVersion: 1;
	lane: "generalized_e2e_stub" | "generalized_e2e_real";
	deploy: RerunDeploySharedV1;
	driver: { issue: string; timeoutMs: number };
}

export interface ManualRerunSpecV1 {
	schemaVersion: 1;
	lane: "manual_test_deploy";
	deploy: RerunDeploySharedV1 & {
		generalized: boolean;
		stubRunner?: boolean;
	};
}

export type RerunSpecV1 = GeneralizedRerunSpecV1 | ManualRerunSpecV1;

export type RerunSpecValidationReason =
	| "not_object"
	| "schema_version"
	| "unknown_key"
	| "lane_invalid"
	| "lane_mismatch"
	| "deploy_invalid"
	| "driver_required"
	| "driver_forbidden"
	| "issue_invalid"
	| "timeout_ms_invalid"
	| "lead_label_invalid"
	| "extra_leads_invalid"
	| "extra_lead_label_invalid"
	| "extra_slot_invalid"
	| "extra_slot_duplicate"
	| "extra_leads_require_lead_label"
	| "stub_runner_requires_generalized"
	| "too_large";

export type RerunSpecValidationResult =
	| { ok: true; value: RerunSpecV1 }
	| { ok: false; reason: RerunSpecValidationReason };

function objectValue(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function hasExactKeys(
	value: Record<string, unknown>,
	required: readonly string[],
	optional: readonly string[] = [],
): boolean {
	const allowed = new Set([...required, ...optional]);
	return (
		required.every((key) => Object.hasOwn(value, key)) &&
		Object.keys(value).every((key) => allowed.has(key))
	);
}

function validateSharedDeploy(
	deploy: Record<string, unknown>,
	required: readonly string[],
	optional: readonly string[],
): RerunSpecValidationReason | undefined {
	if (!hasExactKeys(deploy, required, optional)) return "unknown_key";
	if (
		deploy.leadLabel !== undefined &&
		(typeof deploy.leadLabel !== "string" ||
			!LABEL_PATTERN.test(deploy.leadLabel))
	) {
		return "lead_label_invalid";
	}
	if (deploy.extraLeads === undefined) return undefined;
	if (
		!Array.isArray(deploy.extraLeads) ||
		deploy.extraLeads.length < 1 ||
		deploy.extraLeads.length > MAX_EXTRA_LEADS
	) {
		return "extra_leads_invalid";
	}
	if (!deploy.leadLabel) return "extra_leads_require_lead_label";
	const seenSlots = new Set<number>();
	for (const item of deploy.extraLeads) {
		const extra = objectValue(item);
		if (!extra || !hasExactKeys(extra, ["slot", "deptLabel"])) {
			return "extra_leads_invalid";
		}
		if (!Number.isSafeInteger(extra.slot) || Number(extra.slot) < 1) {
			return "extra_slot_invalid";
		}
		if (seenSlots.has(Number(extra.slot))) return "extra_slot_duplicate";
		seenSlots.add(Number(extra.slot));
		if (
			typeof extra.deptLabel !== "string" ||
			!LABEL_PATTERN.test(extra.deptLabel)
		) {
			return "extra_lead_label_invalid";
		}
	}
	return undefined;
}

export function validateRerunSpecV1(
	value: unknown,
	expectedLane?: StrengthTwoLane,
): RerunSpecValidationResult {
	const input = objectValue(value);
	if (!input) return { ok: false, reason: "not_object" };
	if (input.schemaVersion !== 1) {
		return { ok: false, reason: "schema_version" };
	}
	if (
		typeof input.lane !== "string" ||
		!(LANES as readonly string[]).includes(input.lane)
	) {
		return { ok: false, reason: "lane_invalid" };
	}
	if (expectedLane !== undefined && input.lane !== expectedLane) {
		return { ok: false, reason: "lane_mismatch" };
	}
	const deploy = objectValue(input.deploy);
	if (!deploy) return { ok: false, reason: "deploy_invalid" };

	if (input.lane === "manual_test_deploy") {
		if (Object.hasOwn(input, "driver")) {
			return { ok: false, reason: "driver_forbidden" };
		}
		if (!hasExactKeys(input, ["schemaVersion", "lane", "deploy"])) {
			return { ok: false, reason: "unknown_key" };
		}
		const deployReason = validateSharedDeploy(
			deploy,
			["generalized"],
			["stubRunner", "leadLabel", "extraLeads"],
		);
		if (deployReason) return { ok: false, reason: deployReason };
		if (typeof deploy.generalized !== "boolean") {
			return { ok: false, reason: "deploy_invalid" };
		}
		if (
			deploy.stubRunner !== undefined &&
			typeof deploy.stubRunner !== "boolean"
		) {
			return { ok: false, reason: "deploy_invalid" };
		}
		if (deploy.generalized === false && deploy.stubRunner !== undefined) {
			return { ok: false, reason: "stub_runner_requires_generalized" };
		}
	} else {
		if (!hasExactKeys(input, ["schemaVersion", "lane", "deploy", "driver"])) {
			return { ok: false, reason: "unknown_key" };
		}
		const deployReason = validateSharedDeploy(
			deploy,
			[],
			["leadLabel", "extraLeads"],
		);
		if (deployReason) return { ok: false, reason: deployReason };
		const driver = objectValue(input.driver);
		if (!driver) return { ok: false, reason: "driver_required" };
		if (!hasExactKeys(driver, ["issue", "timeoutMs"])) {
			return { ok: false, reason: "unknown_key" };
		}
		if (typeof driver.issue !== "string" || !ISSUE_PATTERN.test(driver.issue)) {
			return { ok: false, reason: "issue_invalid" };
		}
		if (
			!Number.isSafeInteger(driver.timeoutMs) ||
			Number(driver.timeoutMs) < MIN_DRIVER_TIMEOUT_MS ||
			Number(driver.timeoutMs) > MAX_DRIVER_TIMEOUT_MS
		) {
			return { ok: false, reason: "timeout_ms_invalid" };
		}
	}

	const normalized = input as unknown as RerunSpecV1;
	if (Buffer.byteLength(canonicalJsonString(normalized), "utf8") > 2_048) {
		return { ok: false, reason: "too_large" };
	}
	return { ok: true, value: normalized };
}

export function canonicalizeRerunSpec(value: RerunSpecV1): string {
	return canonicalJsonString(value);
}

function deploySharedArgs(deploy: RerunDeploySharedV1): string[] {
	const args: string[] = [];
	if (deploy.leadLabel) args.push("--lead-label", deploy.leadLabel);
	for (const extra of deploy.extraLeads ?? []) {
		args.push("--extra-lead", `${extra.slot}:${extra.deptLabel}`);
	}
	return args;
}

export function deriveRerunArgv(input: {
	spec: RerunSpecV1;
	siteSlot: number;
	headSha: string;
}): string[][] {
	if (!Number.isSafeInteger(input.siteSlot) || input.siteSlot < 1) {
		throw new Error("site slot must be a positive safe integer");
	}
	if (!SHA40_LOWER_PATTERN.test(input.headSha)) {
		throw new Error("head sha must be lowercase 40-hex");
	}
	const deploy = ["bash", "scripts/test-deploy.sh", String(input.siteSlot)];
	if (input.spec.lane === "manual_test_deploy") {
		if (input.spec.deploy.generalized) {
			deploy.push("--generalized");
			if (input.spec.deploy.stubRunner) deploy.push("--stub-runner");
			deploy.push("--expect-head", input.headSha);
		}
		deploy.push(...deploySharedArgs(input.spec.deploy));
		return [deploy];
	}
	deploy.push("--generalized");
	if (input.spec.lane === "generalized_e2e_stub") {
		deploy.push("--stub-runner");
	}
	deploy.push("--expect-head", input.headSha);
	deploy.push(...deploySharedArgs(input.spec.deploy));
	const driver = [
		"node",
		"scripts/qa-529-generalized-e2e.mjs",
		String(input.siteSlot),
		"--issue",
		input.spec.driver.issue,
	];
	if (input.spec.lane === "generalized_e2e_real") driver.push("--real");
	driver.push("--timeout-ms", String(input.spec.driver.timeoutMs));
	return [deploy, driver];
}

export function shellQuote(token: string): string {
	if (/[\n\r\0]/.test(token)) throw new Error("unsafe shell token");
	return `'${token.replaceAll("'", "'\\''")}'`;
}

export function renderRerunCommand(input: {
	worktreePath: string;
	headSha: string;
	argv: readonly (readonly string[])[];
}): string {
	if (!input.worktreePath.startsWith("/")) {
		throw new Error("worktree path must be absolute");
	}
	if (!SHA40_LOWER_PATTERN.test(input.headSha)) {
		throw new Error("head sha must be lowercase 40-hex");
	}
	if (
		input.argv.length < 1 ||
		input.argv.some((command) => command.length < 1)
	) {
		throw new Error("rerun argv must contain commands");
	}
	const commands = input.argv.map((command) =>
		command.map((token) => shellQuote(token)).join(" "),
	);
	return `cd ${shellQuote(input.worktreePath)} && [ "$(git rev-parse HEAD)" = ${shellQuote(input.headSha)} ] && TMPDIR=/tmp/ TEST_REPLY_BY_ISSUE=1 ${commands.join(" && ")}`;
}
