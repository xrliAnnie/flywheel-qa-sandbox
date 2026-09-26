import { createHash } from "node:crypto";
import { validateRerunSpecV1 } from "flywheel-comm/strength-two-contract";
import { canonicalJsonString } from "flywheel-config";
import { z } from "zod";

export class QaRoomError extends Error {
	constructor(
		readonly reason: string,
		readonly code = 400,
		readonly fields?: string[],
	) {
		super(reason);
	}
}
const identity = {
	execution_id: z.string().uuid().optional(),
	request_id: z.string().uuid(),
	credential: z.string().min(1).max(4096).optional(),
};
const label = z.string().regex(/^[A-Za-z0-9._-]{1,40}$/);
const deploySchema = z
	.object({
		...identity,
		head: z.string().regex(/^[a-f0-9]{40}$/),
		slot: z
			.union([z.literal("auto"), z.number().int().positive()])
			.default("auto"),
		mode: z.enum(["slot", "mirror", "roundtable"]).default("slot"),
		from_branch: z
			.string()
			.regex(/^[A-Za-z0-9._/][A-Za-z0-9._/-]{0,199}$/)
			.refine((s) => !s.includes(".."))
			.default("main"),
		generalized: z.boolean().default(false),
		test_discipline: z.boolean().default(false),
		codex_runner: z.boolean().default(false),
		stub_runner: z.boolean().default(false),
		no_lead: z.boolean().default(false),
		alerts: z.boolean().default(false),
		alert_duty: z.boolean().default(false),
		codex_home_reconcile: z.boolean().default(false),
		extra_leads: z
			.array(z.object({ slot: z.number().int().positive(), label }).strict())
			.max(4)
			.default([]),
		lead_label: label.optional(),
		lead_ready_timeout_sec: z.number().int().min(1).max(3600).optional(),
		lead_channel_timeout_sec: z.number().int().min(1).max(3600).optional(),
		digest_channel: z
			.string()
			.regex(/^\d{17,20}$/)
			.optional(),
		env: z
			.object({
				TEST_REPLY_BY_ISSUE: z.enum(["0", "1"]).optional(),
				TEST_BRIDGE_DEPT_SCOPE_REJECT: z.enum(["on", "off"]).optional(),
				TEST_CODEX_LEAD_OUTBOUND_MODE: z.enum(["direct", "bridge"]).optional(),
			})
			.strict()
			.default({}),
	})
	.strict();
const teardownSchema = z
	.object({
		...identity,
		skip_snapshot: z.boolean().default(false),
		reason: z.string().trim().min(1).max(200).optional(),
	})
	.strict();
export type RoomDeployRequest = z.infer<typeof deploySchema>;
export type RoomTeardownRequest = z.infer<typeof teardownSchema>;

function hasProductionTarget(value: unknown): boolean {
	if (typeof value === "string")
		return [...value.matchAll(/com\.flywheel\.[A-Za-z0-9._-]+/g)].some(
			([name]) => !name.startsWith("com.flywheel.qa."),
		);
	if (Array.isArray(value)) return value.some(hasProductionTarget);
	return (
		value !== null &&
		typeof value === "object" &&
		Object.values(value).some(hasProductionTarget)
	);
}
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
	if (hasProductionTarget(input))
		throw new QaRoomError("production_target_refused");
	const result = schema.safeParse(input);
	if (!result.success) {
		throw new QaRoomError(
			result.error.issues.some((i) => i.code === "unrecognized_keys")
				? "field_not_supported"
				: "invalid_request",
		);
	}
	return result.data;
}
export function parseRoomDeploy(
	input: unknown,
	slotCount: number,
): RoomDeployRequest {
	const body = parse(deploySchema, input);
	if (
		(body.slot !== "auto" && body.slot > slotCount) ||
		body.extra_leads.some((s) => s.slot > slotCount)
	)
		throw new QaRoomError("slot_out_of_range");
	if (
		(body.mode === "mirror" && body.slot !== "auto" && body.slot > 3) ||
		((body.generalized || body.test_discipline) && body.mode !== "slot")
	)
		throw new QaRoomError("mode_incompatible");
	if (
		(body.stub_runner && !body.generalized) ||
		(body.codex_runner && !body.generalized && !body.test_discipline) ||
		(body.stub_runner && (body.codex_runner || body.test_discipline))
	)
		throw new QaRoomError("runner_flags_incompatible");
	if ((body.alert_duty || body.codex_home_reconcile) && !body.alerts)
		throw new QaRoomError("alerts_required");
	if (body.no_lead && (body.extra_leads.length > 0 || body.alert_duty))
		throw new QaRoomError("lead_required");
	const slots = body.extra_leads.map((s) => s.slot);
	if (
		new Set(slots).size !== slots.length ||
		(body.slot !== "auto" && slots.includes(body.slot))
	)
		throw new QaRoomError("duplicate_slot");
	return body;
}
export function parseRoomTeardown(input: unknown): RoomTeardownRequest {
	const body = parse(teardownSchema, input);
	if (body.skip_snapshot !== (body.reason !== undefined))
		throw new QaRoomError("snapshot_reason_required");
	return body;
}
export function withoutRoomCredential<T extends { credential?: string }>(
	body: T,
): Omit<T, "credential"> {
	const { credential: _credential, ...rest } = body;
	return rest;
}
export function roomRequestDigest(action: string, body: unknown): string {
	const payload =
		body && typeof body === "object" && !Array.isArray(body)
			? withoutRoomCredential(body as Record<string, unknown>)
			: body;
	return createHash("sha256")
		.update(canonicalJsonString({ action, payload }))
		.digest("hex");
}
export function deployArguments(
	body: RoomDeployRequest,
	slot: number,
): string[] {
	const args = [
		String(slot),
		"--mode",
		body.mode,
		"--from-branch",
		body.from_branch,
	];
	for (const [key, flag] of [
		["generalized", "--generalized"],
		["test_discipline", "--test-discipline"],
		["codex_runner", "--codex-runner"],
		["stub_runner", "--stub-runner"],
		["no_lead", "--no-lead"],
		["alerts", "--alerts"],
		["alert_duty", "--alert-duty"],
		["codex_home_reconcile", "--codex-home-reconcile"],
	] as const)
		if (body[key]) args.push(flag);
	if (body.generalized || body.test_discipline)
		args.push("--expect-head", body.head);
	for (const extra of body.extra_leads)
		args.push("--extra-lead", `${extra.slot}:${extra.label}`);
	for (const [key, flag] of [
		["lead_label", "--lead-label"],
		["lead_ready_timeout_sec", "--lead-ready-timeout"],
		["lead_channel_timeout_sec", "--lead-channel-timeout"],
		["digest_channel", "--digest"],
	] as const) {
		if (body[key] !== undefined) args.push(flag, String(body[key]));
	}
	return args;
}

const drillSchema = z
	.object({
		...identity,
		driver: z.literal("qa529_generalized_e2e"),
		issue: z.string().regex(/^[A-Z]+-\d+$/),
		real: z.boolean().default(false),
		timeout_ms: z.number().int().min(10_000).max(3_600_000).default(900_000),
	})
	.strict();
export type RoomDrillRequest = z.infer<typeof drillSchema>;
export function parseRoomDrill(input: unknown): RoomDrillRequest {
	return parse(drillSchema, input);
}
export function roomDrillRerunSpec(
	deploy: RoomDeployRequest,
	drill: RoomDrillRequest,
) {
	if (!deploy.generalized) throw new QaRoomError("room_not_drillable", 409);
	const fields: string[] = [];
	if (deploy.from_branch !== "main") fields.push("from_branch");
	if (deploy.mode !== "slot") fields.push("mode");
	if (
		Object.keys(deploy.env).length !== 1 ||
		deploy.env.TEST_REPLY_BY_ISSUE !== "1"
	)
		fields.push("env");
	for (const key of [
		"codex_runner",
		"alerts",
		"alert_duty",
		"no_lead",
		"test_discipline",
		"codex_home_reconcile",
	] as const) {
		if (deploy[key]) fields.push(key);
	}
	if (fields.length)
		throw new QaRoomError("drill_config_not_reproducible", 409, fields);
	if (drill.real === deploy.stub_runner)
		throw new QaRoomError("drill_mode_mismatch", 409);
	const result = validateRerunSpecV1({
		schemaVersion: 1,
		lane: drill.real ? "generalized_e2e_real" : "generalized_e2e_stub",
		deploy: {
			...(deploy.lead_label ? { leadLabel: deploy.lead_label } : {}),
			...(deploy.extra_leads.length
				? {
						extraLeads: deploy.extra_leads.map((e) => ({
							slot: e.slot,
							deptLabel: e.label,
						})),
					}
				: {}),
		},
		driver: { issue: drill.issue, timeoutMs: drill.timeout_ms },
	});
	if (!result.ok)
		throw new QaRoomError("drill_config_not_reproducible", 409, [
			result.reason,
		]);
	return result.value;
}
export function drillArguments(body: RoomDrillRequest, slot: number): string[] {
	return [
		String(slot),
		"--issue",
		body.issue,
		...(body.real ? ["--real"] : []),
		"--timeout-ms",
		String(body.timeout_ms),
	];
}
export function drillOutcome(code: number): string {
	return code === 0
		? "passed"
		: code === 20
			? "a3_diagnosis"
			: code === 21
				? "stub_fatal_diagnosis"
				: "driver_failed";
}
