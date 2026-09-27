import type { BodyObservation } from "flywheel-claude-runner";
import { describe, expect, it, vi } from "vitest";
import type { BodyDeathObligation } from "../execution-body-convergence.js";
import {
	createExecutionBodyReader,
	readStoredExecutionBodyLiveness,
} from "../execution-body-reader.js";

function harness() {
	let enabled = true;
	let observation: BodyObservation | undefined;
	let duty: BodyDeathObligation | undefined;
	const request = vi.fn();
	const read = vi.fn(() => observation);
	const proof = vi.fn(() => duty);
	const isEnabled = vi.fn(() => enabled);
	const reader = createExecutionBodyReader({
		store: {
			getSession: () => ({ project_name: "fixture" }),
			getCurrentProjectedExecutionBodyDeath: proof,
		} as never,
		sampler: () => ({ read, request }),
		isEnabled,
	});
	return {
		reader,
		request,
		read,
		proof,
		isEnabled,
		setEnabled(value: boolean) {
			enabled = value;
		},
		setObservation(verdict: BodyObservation["verdict"]) {
			observation = { verdict } as BodyObservation;
		},
		settle() {
			duty = { obligationId: "body_death:exec:1" } as BodyDeathObligation;
		},
	};
}
describe("FLY-2919 synchronous body reader", () => {
	it("returns unknown and schedules a cache miss without invoking an OS probe", () => {
		const h = harness();
		for (let i = 0; i < 100; i++)
			expect(h.reader.read("exec", "fixture")).toBe("unknown");
		expect(h.request).toHaveBeenCalledWith("exec");
	});
	it("does not expose an uncommitted or unprojected dead sample as replacement authority", () => {
		const h = harness();
		h.setObservation("dead");
		expect(h.reader.read("exec", "fixture")).toBe("unknown");
		expect(h.request).toHaveBeenCalledWith("exec");
		h.settle();
		expect(h.reader.read("exec", "fixture")).toBe("dead");
	});
	it("returns live process evidence despite a missing window or logical terminal label", () => {
		const h = harness();
		h.setObservation("alive");
		expect(h.reader.read("exec", "fixture")).toBe("alive");
		expect(h.request).not.toHaveBeenCalled();
	});
	it("reads the managed switch every time and fails closed if it is unreadable", () => {
		const h = harness();
		h.settle();
		expect(h.reader.read("exec", "fixture")).toBe("dead");
		h.setEnabled(false);
		expect(h.reader.read("exec", "fixture")).toBe("unknown");
		h.isEnabled.mockImplementationOnce(() => {
			throw new Error("flag unavailable");
		});
		expect(h.reader.read("exec", "fixture")).toBe("unknown");
		h.setEnabled(true);
		expect(h.reader.read("exec", "fixture")).toBe("dead");
	});
	it("does not sample a foreign project or fall back to windows on a read error", () => {
		const h = harness();
		h.settle();
		expect(h.reader.read("exec", "foreign")).toBe("unknown");
		expect(h.proof).not.toHaveBeenCalled();
		expect(h.request).not.toHaveBeenCalled();
		h.proof.mockImplementationOnce(() => {
			throw new Error("store unavailable");
		});
		expect(h.reader.read("exec", "fixture")).toBe("unknown");
	});
});

describe("FLY-2919 non-runtime stored body reader", () => {
	it("accepts only settled current death in its project under the managed switch", () => {
		const proof = vi.fn(() => ({ obligationId: "body_death:exec:1" }));
		const flag = vi.fn(() => ({ hasOverride: true, raw: "1" }));
		const store = {
			getSession: () => ({ project_name: "fixture", status: "failed" }),
			getCurrentProjectedExecutionBodyDeath: proof,
			getFlagValueRow: flag,
		} as never;
		expect(readStoredExecutionBodyLiveness(store, "exec", "fixture")).toBe(
			"dead",
		);
		expect(flag).toHaveBeenCalledWith("execution_body_death_enabled");
		flag.mockReturnValue({ hasOverride: true, raw: "0" });
		expect(readStoredExecutionBodyLiveness(store, "exec", "fixture")).toBe(
			"unknown",
		);
		flag.mockReturnValue({ hasOverride: true, raw: "1" });
		expect(readStoredExecutionBodyLiveness(store, "exec", "foreign")).toBe(
			"unknown",
		);
		proof.mockReturnValue(undefined as never);
		expect(readStoredExecutionBodyLiveness(store, "exec", "fixture")).toBe(
			"unknown",
		);
		flag.mockImplementation(() => {
			throw new Error("unreadable flag");
		});
		expect(readStoredExecutionBodyLiveness(store, "exec", "fixture")).toBe(
			"unknown",
		);
	});
});
