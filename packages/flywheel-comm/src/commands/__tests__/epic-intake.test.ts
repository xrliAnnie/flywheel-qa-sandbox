import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { runEpicIntake } from "../epic-intake.js";

it("shows the configured project and Lead and sends resolve evidence only to its exact route", async () => {
	const dir = await mkdtemp(join(tmpdir(), "intake-cli-"));
	try {
		const file = join(dir, "result.json");
		await writeFile(file, JSON.stringify({ outcome: "complete" }));
		const fetchFn = vi.fn(async (_url: string, _init: { body?: string }) => ({
			ok: true,
			status: 200,
			json: async () => ({ ok: true }),
		}));
		const log = vi.fn();
		const deps = {
			env: {
				TEAMLEAD_API_TOKEN: "fixture",
				FLYWHEEL_PROJECT_NAME: "test",
				FLYWHEEL_LEAD_ID: "lead",
				FLYWHEEL_BRIDGE_URL: "http://localhost:1234",
			},
			fetchFn,
			log,
		};
		expect(await runEpicIntake(["show"], deps)).toBe(0);
		expect(fetchFn.mock.calls[0]?.[0]).toBe(
			"http://localhost:1234/api/epic-intake?projectName=test&leadId=lead",
		);
		expect(
			await runEpicIntake(
				["resolve", "--event-uid", "exact:uid", "--evidence-file", file],
				deps,
			),
		).toBe(0);
		expect(JSON.parse(fetchFn.mock.calls[1]?.[1]?.body ?? "{}")).toMatchObject({
			eventUid: "exact:uid",
			leadId: "lead",
			evidence: { outcome: "complete" },
		});
		await writeFile(file, "x".repeat(16385));
		expect(
			await runEpicIntake(
				["resolve", "--event-uid", "exact", "--evidence-file", file],
				deps,
			),
		).toBe(1);
		expect(
			await runEpicIntake(["show", "--project", "a", "--project", "b"], deps),
		).toBe(1);
		expect(fetchFn).toHaveBeenCalledTimes(2);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
it("fails closed without token and reports transport failure without evidence/token leakage", async () => {
	const log = vi.fn();
	const fetchFn = vi.fn(async () => {
		throw new Error("secret");
	});
	expect(await runEpicIntake(["show"], { env: {}, log, fetchFn })).toBe(1);
	expect(fetchFn).not.toHaveBeenCalled();
	expect(
		await runEpicIntake(["show", "--project", "test", "--lead", "lead"], {
			env: { TEAMLEAD_API_TOKEN: "secret" },
			log,
			fetchFn,
		}),
	).toBe(1);
	expect(JSON.stringify(log.mock.calls)).not.toContain("secret");
});
