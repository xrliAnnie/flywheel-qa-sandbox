import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createReportCriticalSection } from "../bridge/report-critical-section.js";
import { ReportRegistry } from "../bridge/report-registry.js";
import { isReportExpired } from "../bridge/report-retention.js";

const HTML = "<html><head></head><body>report</body></html>";

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve = (): void => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("ReportCriticalSection", () => {
	it("serializes ordinary reports, Epic republishes, and sweeps in FIFO order", async () => {
		const criticalSection = createReportCriticalSection();
		const firstEntered = deferred();
		const releaseFirst = deferred();
		const order: string[] = [];

		const ordinary = criticalSection.run(async () => {
			order.push("ordinary:start");
			firstEntered.resolve();
			await releaseFirst.promise;
			order.push("ordinary:end");
		});
		await firstEntered.promise;
		const epicOne = criticalSection.run(async () => {
			order.push("epic-one");
		});
		const epicTwo = criticalSection.run(async () => {
			order.push("epic-two");
		});
		const sweep = criticalSection.run(async () => {
			order.push("sweep");
		});

		await Promise.resolve();
		expect(order).toEqual(["ordinary:start"]);
		releaseFirst.resolve();
		await Promise.all([ordinary, epicOne, epicTwo, sweep]);

		expect(order).toEqual([
			"ordinary:start",
			"ordinary:end",
			"epic-one",
			"epic-two",
			"sweep",
		]);
	});

	it("releases the next operation when the current operation throws", async () => {
		const criticalSection = createReportCriticalSection();
		const failed = criticalSection.run(async () => {
			throw new Error("upload failed");
		});
		const recovered = criticalSection.run(async () => "next-ran");

		await expect(failed).rejects.toThrow("upload failed");
		await expect(recovered).resolves.toBe("next-ran");
	});

	it("preserves ordinary and two-project Epic entries under controlled concurrency", async () => {
		const dir = mkdtempSync(join(tmpdir(), "fly2143-report-critical-"));
		try {
			const registry = new ReportRegistry(dir);
			const criticalSection = createReportCriticalSection();
			const firstEntered = deferred();
			const releaseFirst = deferred();
			const ordinary = criticalSection.run(async () => {
				const staged = registry.stagePublish("ordinary", HTML);
				firstEntered.resolve();
				await releaseFirst.promise;
				staged.commit();
			});
			await firstEntered.promise;
			const epicOne = criticalSection.run(async () => {
				registry
					.stageEpicPageRepublish(
						"epic-one",
						HTML,
						"11111111111111111111111111111111",
					)
					.commit();
			});
			const epicTwo = criticalSection.run(async () => {
				registry
					.stageEpicPageRepublish(
						"epic-two",
						HTML,
						"22222222222222222222222222222222",
					)
					.commit();
			});

			releaseFirst.resolve();
			await Promise.all([ordinary, epicOne, epicTwo]);
			expect(registry.list().map(({ projectName }) => projectName)).toEqual([
				"ordinary",
				"epic-one",
				"epic-two",
			]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps a just-republished Epic out of a queued exact-boundary sweep", async () => {
		const dir = mkdtempSync(join(tmpdir(), "fly2143-report-sweep-"));
		try {
			let now = Date.parse("2026-06-04T00:00:00.000Z");
			const registry = new ReportRegistry(dir, { now: () => now });
			const criticalSection = createReportCriticalSection();
			const token = "33333333333333333333333333333333";
			registry.stageEpicPageRepublish("epic", HTML, token).commit();
			const blobs = new Set([token]);
			now += 14 * 24 * 60 * 60 * 1000;
			const republishEntered = deferred();
			const releaseRepublish = deferred();
			const republish = criticalSection.run(async () => {
				const staged = registry.stageEpicPageRepublish(
					"epic",
					"<html><head></head><body>fresh</body></html>",
					token,
				);
				republishEntered.resolve();
				await releaseRepublish.promise;
				blobs.add(token);
				staged.commit();
			});
			await republishEntered.promise;
			const sweep = criticalSection.run(async () => {
				for (const entry of registry.list()) {
					if (isReportExpired(now, Date.parse(entry.createdAt))) {
						blobs.delete(entry.token);
					}
				}
			});

			releaseRepublish.resolve();
			await Promise.all([republish, sweep]);
			expect(blobs.has(token)).toBe(true);
			expect(registry.list()).toHaveLength(1);
			expect(registry.readReportHtml(token)).toContain("fresh");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
