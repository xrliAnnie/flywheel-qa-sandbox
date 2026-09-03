import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	getHoldShape,
	HOLD_SHAPE_REGISTRY,
} from "../bridge/hold-shape-registry.js";

const EXPECTED_SHAPES = [
	"rework_activation_stalled_held",
	"rework_pane_loss_handoff",
	"rework_retry_exhausted",
	"unlaunched_admission_rolled_back",
	"unlaunched_admission_held",
	"completion_receipt_missing",
	"retry_limit_escalated",
	"environment_failure_escalated",
	"loop_limit_escalated",
	"rework_suppressed_idle_spin",
	"workflow_gate_origin_preflight_terminal",
	"land_held_with_operation",
	"land_held_without_operation",
	"run_held_by_operator",
	"carrier_run_inactive",
	"carrier_needs_lead",
	"mailbox_inflight_slots_exhausted",
	"three_stage_turn_stuck",
	"delivery_undeliverable_no_recipient",
] as const;

describe("FLY-2248 sanctioned hold-shape registry", () => {
	it("registers every inventoried freeze shape with a positive and negative detector", () => {
		expect(HOLD_SHAPE_REGISTRY.map(({ id }) => id)).toEqual(EXPECTED_SHAPES);
		expect(
			HOLD_SHAPE_REGISTRY.filter(
				({ authoritativeStore }) => authoritativeStore === "state",
			),
		).toHaveLength(17);
		expect(
			HOLD_SHAPE_REGISTRY.filter(
				({ authoritativeStore }) => authoritativeStore === "comm",
			),
		).toHaveLength(2);
		for (const shape of HOLD_SHAPE_REGISTRY) {
			expect(getHoldShape(shape.id)).toBe(shape);
			expect(shape.detect(shape.positiveProbe)).toBe(true);
			expect(
				shape.detect({ eventKind: "not_a_hold", reason: "unrelated" }),
			).toBe(false);
		}
		expect(getHoldShape("not_registered")).toBeUndefined();
	});

	it("keeps the mutation inventory and public manifest in exact bidirectional sync", () => {
		const manifest = JSON.parse(
			readFileSync(
				resolve(process.cwd(), "src/bridge/hold-shape-manifest.json"),
				"utf8",
			),
		) as Array<{ id: string; authoritativeStore: string; scope: string }>;
		const inventory = JSON.parse(
			readFileSync(
				resolve(process.cwd(), "src/bridge/hold-mutation-inventory.json"),
				"utf8",
			),
		) as Array<{ shapeIds: string[] }>;
		const registered = new Set(EXPECTED_SHAPES);
		expect(manifest.map(({ id }) => id)).toEqual(EXPECTED_SHAPES);
		expect(new Set(inventory.flatMap(({ shapeIds }) => shapeIds))).toEqual(
			registered,
		);
		for (const entry of manifest) {
			expect(getHoldShape(entry.id)?.authoritativeStore).toBe(
				entry.authoritativeStore,
			);
			expect(getHoldShape(entry.id)?.scope).toBe(entry.scope);
		}
	});

	it("classifies delivery and run-derived holds without changing the 19-shape inventory", () => {
		expect(getHoldShape("carrier_needs_lead")?.scope).toBe("delivery");
		expect(getHoldShape("delivery_undeliverable_no_recipient")?.scope).toBe(
			"delivery",
		);
		expect(getHoldShape("carrier_run_inactive")?.scope).toBe("run-derived");
		expect(
			HOLD_SHAPE_REGISTRY.filter(({ scope }) => scope === "run"),
		).toHaveLength(16);
	});

	it("keeps operator recovery discovery aligned with terminal registered holds", () => {
		const source = readFileSync(
			resolve(process.cwd(), "src/StateStore.ts"),
			"utf8",
		);
		const operatorRecovery = source.slice(
			source.indexOf("openOperatorRework(input:"),
			source.indexOf("getWorkflowOperatorReworkReceipt("),
		);
		for (const eventKind of [
			"environment_failure_escalated",
			"workflow_gate_origin_preflight_terminal",
		]) {
			expect(operatorRecovery).toContain(`'${eventKind}'`);
		}
	});
});
