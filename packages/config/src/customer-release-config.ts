/** Parsing configuration never grants release authority: runtime verifies the receipt. */
export interface CustomerReleaseSettings {
	timezone: string;
	weekday: number;
	notice_local: string;
	deadline_local: string;
	claim_deadline_local: string;
	minimum_veto_minutes: number;
	policyRevision: string;
	founderEnableReceiptId?: string;
	channelId: string;
	guildId: string;
	applicationId: string;
	botUserId: string;
	bot_token_env: string;
	decision_token_env: string;
	executor_repository_id: number;
	executor_workflow_id: number;
}

export type CustomerReleaseConfig =
	| ({ mode: "off" } & Partial<CustomerReleaseSettings>)
	| ({ mode: "observe" } & CustomerReleaseSettings)
	| ({
			mode: "canary";
			founderEnableReceiptId: string;
	  } & CustomerReleaseSettings);

const fields = [
	"timezone",
	"weekday",
	"notice_local",
	"deadline_local",
	"claim_deadline_local",
	"minimum_veto_minutes",
	"policyRevision",
	"channelId",
	"guildId",
	"applicationId",
	"botUserId",
	"bot_token_env",
	"decision_token_env",
	"executor_repository_id",
	"executor_workflow_id",
] as const;

function invalid(field: string): never {
	// Only developer-owned field names appear in errors, never supplied values.
	throw new Error(`customer_release.${field} is invalid or missing`);
}

function integer(value: unknown, min: number, max: number): boolean {
	return (
		typeof value === "number" &&
		Number.isSafeInteger(value) &&
		value >= min &&
		value <= max
	);
}

function minutes(value: unknown): number | null {
	if (typeof value !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value))
		return null;
	return Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
}

export function parseCustomerReleaseConfig(
	value: unknown,
): CustomerReleaseConfig {
	if (value === undefined) return { mode: "off" };
	if (!value || typeof value !== "object" || Array.isArray(value))
		invalid("config");
	const raw = value as Record<string, unknown>;
	const allowed = new Set<string>([
		"mode",
		"founderEnableReceiptId",
		...fields,
	]);
	if (Object.keys(raw).some((key) => !allowed.has(key))) invalid("fields");
	const mode = Object.hasOwn(raw, "mode") ? raw.mode : "off";
	if (mode !== "off" && mode !== "observe" && mode !== "canary")
		invalid("mode");
	if (mode !== "off") {
		for (const field of fields) if (!Object.hasOwn(raw, field)) invalid(field);
	}
	if (Object.hasOwn(raw, "timezone")) {
		if (
			typeof raw.timezone !== "string" ||
			raw.timezone.length > 128 ||
			!/^[A-Za-z][A-Za-z0-9_+/-]*$/.test(raw.timezone)
		)
			invalid("timezone");
		try {
			new Intl.DateTimeFormat("en-US", { timeZone: raw.timezone });
		} catch {
			invalid("timezone");
		}
	}
	for (const [field, min, max] of [
		["weekday", 1, 7],
		["minimum_veto_minutes", 120, 480],
		["executor_repository_id", 1, Number.MAX_SAFE_INTEGER],
		["executor_workflow_id", 1, Number.MAX_SAFE_INTEGER],
	] as const) {
		if (Object.hasOwn(raw, field) && !integer(raw[field], min, max))
			invalid(field);
	}
	for (const field of [
		"channelId",
		"guildId",
		"applicationId",
		"botUserId",
	] as const) {
		if (
			Object.hasOwn(raw, field) &&
			(typeof raw[field] !== "string" || !/^[1-9]\d{16,19}$/.test(raw[field]))
		)
			invalid(field);
	}
	for (const field of ["bot_token_env", "decision_token_env"] as const) {
		if (
			Object.hasOwn(raw, field) &&
			(typeof raw[field] !== "string" ||
				!/^[A-Z][A-Z0-9_]{0,127}$/.test(raw[field]))
		)
			invalid(field);
	}
	if (
		Object.hasOwn(raw, "policyRevision") &&
		(typeof raw.policyRevision !== "string" ||
			!/^[a-f0-9]{64}$/.test(raw.policyRevision))
	)
		invalid("policyRevision");
	if (mode === "canary" || Object.hasOwn(raw, "founderEnableReceiptId")) {
		if (
			typeof raw.founderEnableReceiptId !== "string" ||
			(!(mode === "canary" && raw.founderEnableReceiptId === "") &&
				!/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(raw.founderEnableReceiptId))
		)
			invalid("founderEnableReceiptId");
	}
	const notice = minutes(raw.notice_local);
	const deadline = minutes(raw.deadline_local);
	const claimDeadline = minutes(raw.claim_deadline_local);
	if (
		Object.hasOwn(raw, "claim_deadline_local") &&
		(claimDeadline === null ||
			claimDeadline < 720 ||
			claimDeadline >= 1080 ||
			(deadline !== null && claimDeadline <= deadline))
	)
		invalid("claim_deadline_local");
	if (Object.hasOwn(raw, "notice_local") && (notice === null || notice >= 720))
		invalid("notice_local");
	if (
		Object.hasOwn(raw, "deadline_local") &&
		(deadline === null || deadline < 720 || deadline >= 1080)
	)
		invalid("deadline_local");
	if (
		notice !== null &&
		deadline !== null &&
		typeof raw.minimum_veto_minutes === "number" &&
		deadline - notice < raw.minimum_veto_minutes
	)
		invalid("minimum_veto_minutes");
	return { ...raw, mode } as CustomerReleaseConfig;
}
