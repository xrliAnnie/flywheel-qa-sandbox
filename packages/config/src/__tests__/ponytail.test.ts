import { describe, expect, it } from "vitest";
import {
	decodePonytailConditionForRetry,
	PONYTAIL_CONFLICT,
	PONYTAIL_LABEL_OFF,
	PONYTAIL_LABEL_ON,
	PONYTAIL_SELECTOR_UNAVAILABLE,
	type PonytailInput,
	PonytailLabelConflictError,
	resolvePonytailRequested,
	toPonytailCondition,
} from "../ponytail.js";
import type { PonytailConfig } from "../types.js";

const PROJECT_ON: PonytailConfig = { enabled: true };
const PROJECT_OFF: PonytailConfig = { enabled: false };

function startSignal(
	signal: PonytailInput extends { kind: "start_signal"; signal: infer S }
		? S
		: never,
): PonytailInput {
	return { kind: "start_signal", signal };
}

describe("resolvePonytailRequested — ladder precedence", () => {
	it("per-run override beats everything (on)", () => {
		const r = resolvePonytailRequested(
			startSignal({
				runOverride: "on",
				labels: [PONYTAIL_LABEL_OFF],
				labelStatus: "readable",
			}),
			PROJECT_OFF,
		);
		expect(r).toEqual({
			kind: "resolved",
			requested: { want: "on", source: "run" },
		});
	});

	it("per-run override beats everything (off)", () => {
		const r = resolvePonytailRequested(
			startSignal({
				runOverride: "off",
				labels: [PONYTAIL_LABEL_ON],
				labelStatus: "readable",
			}),
			PROJECT_ON,
		);
		expect(r).toEqual({
			kind: "resolved",
			requested: { want: "off", source: "run" },
		});
	});

	it("label beats project (label on, project off)", () => {
		const r = resolvePonytailRequested(
			startSignal({ labels: [PONYTAIL_LABEL_ON], labelStatus: "readable" }),
			PROJECT_OFF,
		);
		expect(r).toEqual({
			kind: "resolved",
			requested: { want: "on", source: "label" },
		});
	});

	it("label-off beats project-on", () => {
		const r = resolvePonytailRequested(
			startSignal({ labels: [PONYTAIL_LABEL_OFF], labelStatus: "readable" }),
			PROJECT_ON,
		);
		expect(r).toEqual({
			kind: "resolved",
			requested: { want: "off", source: "label" },
		});
	});

	it("project-on with no label → on:project", () => {
		const r = resolvePonytailRequested(
			startSignal({ labels: ["unrelated"], labelStatus: "readable" }),
			PROJECT_ON,
		);
		expect(r).toEqual({
			kind: "resolved",
			requested: { want: "on", source: "project" },
		});
	});

	it("all absent → off:default (byte-compatible)", () => {
		const r = resolvePonytailRequested(
			startSignal({ labels: [], labelStatus: "readable" }),
			undefined,
		);
		expect(r).toEqual({
			kind: "resolved",
			requested: { want: "off", source: "default" },
		});
	});
});

describe("resolvePonytailRequested — fail-closed semantics", () => {
	it("conflicting labels throw (refuse to guess)", () => {
		expect(() =>
			resolvePonytailRequested(
				startSignal({
					labels: [PONYTAIL_LABEL_ON, PONYTAIL_LABEL_OFF],
					labelStatus: "readable",
				}),
				PROJECT_OFF,
			),
		).toThrow(PonytailLabelConflictError);
	});

	it("run-param wins even over conflicting labels", () => {
		const r = resolvePonytailRequested(
			startSignal({
				runOverride: "off",
				labels: [PONYTAIL_LABEL_ON, PONYTAIL_LABEL_OFF],
				labelStatus: "readable",
			}),
			PROJECT_OFF,
		);
		expect(r).toEqual({
			kind: "resolved",
			requested: { want: "off", source: "run" },
		});
	});

	it("label unreadable + project ON → selector_unavailable (don't guess)", () => {
		const r = resolvePonytailRequested(
			startSignal({ labelStatus: "unreadable" }),
			PROJECT_ON,
		);
		expect(r).toEqual({ kind: "selector_unavailable" });
	});

	it("label unreadable + project OFF → off:default (byte-compat, never fail)", () => {
		const r = resolvePonytailRequested(
			startSignal({ labelStatus: "unreadable" }),
			PROJECT_OFF,
		);
		expect(r).toEqual({
			kind: "resolved",
			requested: { want: "off", source: "default" },
		});
	});

	it("label unreadable + project absent → off:default", () => {
		const r = resolvePonytailRequested(
			startSignal({ labelStatus: "unreadable" }),
			undefined,
		);
		expect(r).toEqual({
			kind: "resolved",
			requested: { want: "off", source: "default" },
		});
	});

	it("run-param ON wins even when labels unreadable under project-on", () => {
		const r = resolvePonytailRequested(
			startSignal({ runOverride: "on", labelStatus: "unreadable" }),
			PROJECT_ON,
		);
		expect(r).toEqual({
			kind: "resolved",
			requested: { want: "on", source: "run" },
		});
	});
});

describe("resolvePonytailRequested — frozen_requested (retry)", () => {
	it("returns the frozen request verbatim, ignoring labels/config", () => {
		const r = resolvePonytailRequested(
			{ kind: "frozen_requested", requested: { want: "on", source: "label" } },
			PROJECT_OFF,
		);
		expect(r).toEqual({
			kind: "resolved",
			requested: { want: "on", source: "label" },
		});
	});
});

describe("toPonytailCondition — requested + readiness → effective", () => {
	it("off request → off:<source>, ignores readiness", () => {
		expect(
			toPonytailCondition({ want: "off", source: "default" }, false),
		).toEqual({
			effective: "off",
			requested: { want: "off", source: "default" },
			encoded: "off:default",
		});
	});

	it("on request + ready → on:<source>", () => {
		expect(toPonytailCondition({ want: "on", source: "label" }, true)).toEqual({
			effective: "on",
			requested: { want: "on", source: "label" },
			encoded: "on:label",
		});
	});

	it("on request + NOT ready → unavailable:readiness:on:<source>", () => {
		expect(
			toPonytailCondition({ want: "on", source: "project" }, false),
		).toEqual({
			effective: "unavailable",
			requested: { want: "on", source: "project" },
			encoded: "unavailable:readiness:on:project",
		});
	});
});

describe("decodePonytailConditionForRetry", () => {
	it("normal on:label → frozen", () => {
		expect(decodePonytailConditionForRetry("on:label")).toEqual({
			kind: "frozen",
			requested: { want: "on", source: "label" },
		});
	});

	it("off:run → frozen", () => {
		expect(decodePonytailConditionForRetry("off:run")).toEqual({
			kind: "frozen",
			requested: { want: "off", source: "run" },
		});
	});

	it("readiness-unavailable → frozen (preserves bucket, recovers after setup)", () => {
		expect(
			decodePonytailConditionForRetry("unavailable:readiness:on:label"),
		).toEqual({ kind: "frozen", requested: { want: "on", source: "label" } });
	});

	it("selector-unavailable → reresolve (honor recovered ponytail-off)", () => {
		expect(
			decodePonytailConditionForRetry(PONYTAIL_SELECTOR_UNAVAILABLE),
		).toEqual({
			kind: "reresolve",
		});
	});

	it("conflict → reresolve (labels may be de-conflicted on retry)", () => {
		expect(decodePonytailConditionForRetry(PONYTAIL_CONFLICT)).toEqual({
			kind: "reresolve",
		});
	});

	it("null/empty → null", () => {
		expect(decodePonytailConditionForRetry(null)).toBeNull();
		expect(decodePonytailConditionForRetry(undefined)).toBeNull();
		expect(decodePonytailConditionForRetry("")).toBeNull();
	});

	it("malformed → null", () => {
		expect(decodePonytailConditionForRetry("garbage")).toBeNull();
		expect(decodePonytailConditionForRetry("on:bogus")).toBeNull();
	});

	it("round-trips toPonytailCondition output", () => {
		for (const c of [
			toPonytailCondition({ want: "on", source: "label" }, true),
			toPonytailCondition({ want: "off", source: "run" }, true),
			toPonytailCondition({ want: "on", source: "project" }, false),
		]) {
			const plan = decodePonytailConditionForRetry(c.encoded);
			expect(plan).toEqual({ kind: "frozen", requested: c.requested });
		}
	});
});
