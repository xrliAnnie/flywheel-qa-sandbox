import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LeadAlertNotifier } from "../LeadAlertNotifier.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import { StateStore } from "../StateStore.js";

describe("FLY-1309 mixed alert queue chronology", () => {
	let queueDir: string;
	let deadLetterDir: string;
	let store: StateStore;

	beforeEach(async () => {
		queueDir = mkdtempSync(join(tmpdir(), "fly1309-queue-order-"));
		deadLetterDir = mkdtempSync(join(tmpdir(), "fly1309-queue-dead-"));
		store = await StateStore.create(":memory:");
	});
	afterEach(() => {
		rmSync(queueDir, { recursive: true, force: true });
		rmSync(deadLetterDir, { recursive: true, force: true });
	});

	it("caps by queuedAt across TS, shell, and lease-audit filenames", async () => {
		const payload = (eventId: string, queuedAt: string) => ({
			leadId: "eng-lead",
			projectName: "flywheel",
			eventId,
			eventType: "lead_lease_would_block",
			title: "lease",
			body: "body",
			severity: "warning",
			queueReason: "lease-audit",
			queuedAt,
		});
		writeFileSync(
			join(queueDir, "2026-12-01T00:00:00.000Z-lease-audit-new.json"),
			JSON.stringify(payload("new", "2026-12-01T00:00:00.000Z")),
		);
		writeFileSync(
			join(queueDir, "20260701T000000Z-shell-old.json"),
			JSON.stringify(payload("old", "2026-07-01T00:00:00.000Z")),
		);
		writeFileSync(
			join(queueDir, "2026-08-01T00:00:00.000Z-lease-audit-middle.json"),
			JSON.stringify(payload("middle", "2026-08-01T00:00:00.000Z")),
		);

		const projects: ProjectEntry[] = [
			{
				projectName: "flywheel",
				projectRoot: "/tmp/flywheel",
				leads: [
					{
						agentId: "eng-lead",
						match: { labels: ["eng"] },
						chatChannel: "channel",
						alertChannel: "channel",
						botToken: "token",
					},
				],
			},
		];
		const notifier = new LeadAlertNotifier({
			store,
			projects,
			queueDir,
			deadLetterDir,
			queueMax: 2,
			queueMaxAgeMs: 365 * 24 * 60 * 60_000,
			fetchFn: vi.fn(async () => ({
				ok: false,
				status: 503,
				statusText: "unavailable",
				text: async () => "",
			})) as unknown as typeof fetch,
		});
		const result = await notifier.drainQueue();
		expect(result.deadLettered).toBe(1);
		expect(readdirSync(deadLetterDir)[0]).toContain(
			"20260701T000000Z-shell-old",
		);
		expect(readdirSync(queueDir).sort()).toEqual([
			"2026-08-01T00:00:00.000Z-lease-audit-middle.json",
			"2026-12-01T00:00:00.000Z-lease-audit-new.json",
		]);
	});
});
