/**
 * FLY-529 — env-override resolution for the Bridge-side alert filesystem dirs.
 *
 * The QA Testing Room needs the test Bridge's `LeadAlertNotifier` to write its
 * alert queue / dead-letter files under a slot-local dir instead of the shared
 * production `~/.flywheel/alert-queue|alert-deadletter` — otherwise the live
 * production Bridge's drainer picks up test alerts and posts them (cross-pickup).
 *
 * `resolveAlertDirsFromEnv` is the pure seam: it maps the two env knobs to a
 * partial `LeadAlertNotifier` config. The byte-compat contract is that an UNSET
 * env yields `undefined` for that field, so the notifier constructor keeps its
 * current `?? join(homedir(), ".flywheel", ...)` default — production behavior
 * is byte-identical when the env is not set.
 */
import { describe, expect, it } from "vitest";
import { resolveAlertDirsFromEnv } from "../lead-alert-helpers.js";

describe("resolveAlertDirsFromEnv", () => {
	it("returns both fields undefined when neither env is set (byte-compat)", () => {
		const out = resolveAlertDirsFromEnv({});
		expect(out.queueDir).toBeUndefined();
		expect(out.deadLetterDir).toBeUndefined();
	});

	it("maps FLYWHEEL_ALERT_QUEUE_DIR → queueDir", () => {
		const out = resolveAlertDirsFromEnv({
			FLYWHEEL_ALERT_QUEUE_DIR: "/tmp/slot-1/alert-queue",
		});
		expect(out.queueDir).toBe("/tmp/slot-1/alert-queue");
		expect(out.deadLetterDir).toBeUndefined();
	});

	it("maps FLYWHEEL_ALERT_DEADLETTER_DIR → deadLetterDir", () => {
		const out = resolveAlertDirsFromEnv({
			FLYWHEEL_ALERT_DEADLETTER_DIR: "/tmp/slot-1/alert-deadletter",
		});
		expect(out.deadLetterDir).toBe("/tmp/slot-1/alert-deadletter");
		expect(out.queueDir).toBeUndefined();
	});

	it("maps both when both are set", () => {
		const out = resolveAlertDirsFromEnv({
			FLYWHEEL_ALERT_QUEUE_DIR: "/q",
			FLYWHEEL_ALERT_DEADLETTER_DIR: "/d",
		});
		expect(out).toEqual({ queueDir: "/q", deadLetterDir: "/d" });
	});

	it("treats empty / whitespace-only values as unset (trim)", () => {
		const out = resolveAlertDirsFromEnv({
			FLYWHEEL_ALERT_QUEUE_DIR: "   ",
			FLYWHEEL_ALERT_DEADLETTER_DIR: "",
		});
		expect(out.queueDir).toBeUndefined();
		expect(out.deadLetterDir).toBeUndefined();
	});

	it("trims surrounding whitespace from a real value", () => {
		const out = resolveAlertDirsFromEnv({
			FLYWHEEL_ALERT_QUEUE_DIR: "  /tmp/q  ",
		});
		expect(out.queueDir).toBe("/tmp/q");
	});
});
