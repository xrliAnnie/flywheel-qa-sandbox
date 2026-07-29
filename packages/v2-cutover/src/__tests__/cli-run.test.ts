import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFounderConfirmation, parseCutoverCliArgs } from "../cli.js";
import type { CutoverTargetManifest } from "../manifest.js";
import { runCutover } from "../run.js";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("cutover CLI contract", () => {
	it("accepts the one run path and bounded step selection", () => {
		expect(
			parseCutoverCliArgs([
				"run",
				"--target",
				"/tmp/target.json",
				"--step",
				"7",
				"--yes",
			]),
		).toEqual({
			verb: "run",
			targetPath: "/tmp/target.json",
			step: 7,
			yes: true,
		});
	});

	it("keeps rollback explicit and rejects ambiguous options", () => {
		expect(
			parseCutoverCliArgs(["rollback-t1", "--target", "/tmp/target.json"]),
		).toEqual({
			verb: "rollback-t1",
			targetPath: "/tmp/target.json",
		});
		expect(() =>
			parseCutoverCliArgs([
				"rollback-t1",
				"--target",
				"/tmp/target.json",
				"--yes",
			]),
		).toThrow(/does not accept/);
		expect(() =>
			parseCutoverCliArgs(["run", "--target", "relative.json"]),
		).toThrow(/absolute/);
	});

	it("requires a row-bound disposition and reason for manual adjudication", () => {
		expect(
			parseCutoverCliArgs([
				"adjudicate-manual",
				"--target",
				"/tmp/target.json",
				"--source-kind",
				"legacy-comm",
				"--source-id",
				"project/message-1",
				"--payload-digest",
				"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
				"--disposition",
				"dead",
				"--reason",
				"Founder verified the truncated Runner ID is terminal",
			]),
		).toEqual({
			verb: "adjudicate-manual",
			targetPath: "/tmp/target.json",
			sourceKind: "legacy-comm",
			sourceId: "project/message-1",
			payloadDigest:
				"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			disposition: "dead",
			reason: "Founder verified the truncated Runner ID is terminal",
		});
	});

	it("forbids unattended production runs before any side effect", async () => {
		const target = {
			mode: "production",
		} as CutoverTargetManifest;
		await expect(runCutover(target, { yes: true })).rejects.toThrow(
			/forbidden for production/,
		);
	});

	it("reads held-start and final-go as two independent prompt-time decisions", async () => {
		const prompts: string[] = [];
		const answers = ["held-phrase", "final-phrase"];
		const confirm = createFounderConfirmation({
			async question(prompt) {
				prompts.push(prompt);
				return answers.shift() ?? "";
			},
			close() {},
		});

		expect(await confirm("held-start")).toBe("held-phrase");
		expect(prompts).toHaveLength(1);
		expect(await confirm("final-go")).toBe("final-phrase");
		expect(prompts).toEqual([
			expect.stringContaining("held-start"),
			expect.stringContaining("final-go"),
		]);
	});

	it("requires rehearsal evidence for the exact window/epoch and a clean production snapshot", async () => {
		const root = mkdtempSync(join(tmpdir(), "flywheel-v2-rehearsal-gate-"));
		roots.push(root);
		const evidencePath = join(root, "rehearsal.json");
		const target = {
			mode: "production",
			windowId: "window-prod",
			epoch: 9,
			ledgerDir: join(root, "ledger"),
			evidenceDir: join(root, "evidence"),
			rehearsalEvidencePath: evidencePath,
		} as CutoverTargetManifest;
		writeFileSync(
			evidencePath,
			`${JSON.stringify({
				status: "pass",
				window_id: "window-prod",
				epoch: 9,
				production_unchanged: false,
			})}\n`,
		);
		await expect(runCutover(target, { step: 1 })).rejects.toThrow(
			/production-unchanged rehearsal/,
		);

		writeFileSync(
			evidencePath,
			`${JSON.stringify({
				status: "pass",
				window_id: "window-prod",
				epoch: 9,
				production_unchanged: true,
			})}\n`,
		);
		await expect(runCutover(target, { step: 1 })).resolves.toMatchObject({
			status: "done",
			completedSteps: [1],
		});
	});
});
