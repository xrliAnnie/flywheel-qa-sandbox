import {
	existsSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCoSCommand } from "./cli.js";

describe("one-shot CoS CLI", () => {
	it("calculates a daily-report business date without starting a runtime", async () => {
		const lines: string[] = [];
		const code = await runCoSCommand(
			[
				"daily-report-date",
				"--now",
				"2026-09-09T01:00:00.000Z",
				"--timezone",
				"America/Los_Angeles",
				"--time",
				"18:00",
			],
			{ write: (line) => lines.push(line) },
		);
		expect(code).toBe(0);
		expect(lines).toEqual(["2026-09-08"]);
	});

	it("returns unavailable for voice intent instead of claiming startup", async () => {
		const lines: string[] = [];
		const code = await runCoSCommand(
			[
				"voice-intent",
				"--meeting-id",
				"f5e14717-049b-4d43-b58d-78f18cc1aebb",
				"--action",
				"start",
			],
			{ write: (line) => lines.push(line) },
		);
		expect(code).toBe(2);
		expect(JSON.parse(lines[0] ?? "null")).toMatchObject({
			status: "unavailable",
			reason: "voice_transport_not_available",
		});
	});
});

describe("durable business CLI", () => {
	it("prepares, resumes, records and lists a real workspace operation", async () => {
		const root = mkdtempSync(join(tmpdir(), "raya-cli-"));
		const lines: string[] = [];
		const io = { write: (line: string) => lines.push(line) };
		try {
			writeFileSync(
				join(root, "prepare.json"),
				JSON.stringify({
					schemaVersion: 2,
					operationId: "report:one",
					kind: "announcement",
					sourceRefs: ["report:2026-09-14"],
					target: "chat",
					text: "Daily report",
					eventId: "report:one",
				}),
			);
			expect(
				await runCoSCommand(["prepare", "--input", "prepare.json"], io, root),
			).toBe(0);
			expect(JSON.parse(lines.pop() ?? "null")).toMatchObject({
				revision: 1,
				next: { tool: "lead_actions.discord_send" },
			});
			writeFileSync(
				join(root, "resume.json"),
				JSON.stringify({ schemaVersion: 2, operationId: "report:one" }),
			);
			await runCoSCommand(["resume", "--input", "resume.json"], io, root);
			expect(JSON.parse(lines.pop() ?? "null")).toMatchObject({ revision: 1 });
			writeFileSync(
				join(root, "record.json"),
				JSON.stringify({
					schemaVersion: 2,
					operationId: "report:one",
					expectedRevision: 1,
					tool: "lead_actions.discord_send",
					callId: "tool-call-1",
					result: {
						project: "raya",
						leadId: "raya",
						target: "chat",
						eventId: "report:one",
						status: "sent",
						channelId: "12345678901234567",
						messageId: "12345678901234568",
					},
				}),
			);
			await runCoSCommand(["record", "--input", "record.json"], io, root);
			expect(JSON.parse(lines.pop() ?? "null")).toMatchObject({
				revision: 2,
				stage: "complete",
				next: null,
			});
			await runCoSCommand(["status"], io, root);
			expect(JSON.parse(lines.pop() ?? "null")).toMatchObject({
				schemaVersion: 2,
				operations: [{ operationId: "report:one", stage: "complete" }],
			});
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
	it("rejects input outside workspace, symlinks, oversized input and unknown flags", async () => {
		const root = mkdtempSync(join(tmpdir(), "raya-cli-"));
		const outside = mkdtempSync(join(tmpdir(), "raya-cli-outside-"));
		const io = {
			write: () => {
				throw new Error("must not produce intent");
			},
		};
		try {
			writeFileSync(join(outside, "input.json"), "{}");
			symlinkSync(join(outside, "input.json"), join(root, "linked.json"));
			writeFileSync(join(root, "large.json"), " ".repeat(1024 * 1024 + 1));
			for (const input of [
				join(outside, "input.json"),
				"linked.json",
				"large.json",
			]) {
				await expect(
					runCoSCommand(["prepare", "--input", input], io, root),
				).rejects.toThrow();
			}
			await expect(
				runCoSCommand(["status", "--ignored", "yes"], io, root),
			).rejects.toThrow();
		} finally {
			rmSync(root, { recursive: true, force: true });
			rmSync(outside, { recursive: true, force: true });
		}
	});
});

it("prints a read-only daily report migration plan without creating state", async () => {
	const root = mkdtempSync(join(tmpdir(), "migration-cli-")),
		lines: string[] = [];
	try {
		expect(
			await runCoSCommand(
				["daily-report-migration-plan"],
				{ write: (line) => lines.push(line) },
				root,
			),
		).toBe(0);
		expect(JSON.parse(lines[0])).toMatchObject({
			kind: "daily_report_migration",
			entries: [],
		});
		expect(existsSync(join(root, "state"))).toBe(false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

it("requires a frozen plan digest and paired SHAs for migration apply", async () => {
	const root = mkdtempSync(join(tmpdir(), "migration-apply-cli-")),
		lines: string[] = [];
	try {
		await runCoSCommand(
			["daily-report-migration-plan"],
			{ write: (line) => lines.push(line) },
			root,
		);
		const digest = JSON.parse(lines[0]).digest;
		await expect(
			runCoSCommand(
				["daily-report-migration-apply"],
				{ write: () => {} },
				root,
			),
		).rejects.toThrow();
		expect(
			await runCoSCommand(
				[
					"daily-report-migration-apply",
					"--digest",
					digest,
					"--flywheel-sha",
					"a".repeat(40),
					"--raya-sha",
					"b".repeat(40),
				],
				{ write: (line) => lines.push(line) },
				root,
			),
		).toBe(0);
		expect(JSON.parse(lines[1])).toEqual({ digest, imported: [] });
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
