import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkCodexQuotaReadiness } from "../../codex-quota/readiness.js";

const roots: string[] = [];
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "codex-quota-readiness-"));
	roots.push(root);
	const truth = join(root, "auth.json");
	writeFileSync(truth, "fixture-auth", { mode: 0o600 });
	const home = join(root, "runner");
	mkdirSync(home);
	return { root, truth, home };
}
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

describe("Codex quota shared credential readiness", () => {
	it("rejects a redirected managed home even when auth resolves to canonical", async () => {
		const { truth, home, root } = fixture();
		symlinkSync(truth, join(home, "auth.json"));
		const redirected = join(root, "redirected");
		symlinkSync(home, redirected);
		expect(
			(
				await checkCodexQuotaReadiness({
					canonicalAuthPath: truth,
					collectHomes: async () => ({
						complete: true,
						homes: [
							{ home: redirected, ownership: "managed", activity: "active" },
						],
					}),
				})
			).ready,
		).toBe(false);
	});
	it("rejects unsafe canonical credentials even when there are no active homes", async () => {
		const { truth } = fixture();
		chmodSync(truth, 0o644);
		const opts = {
			canonicalAuthPath: truth,
			collectHomes: async () => ({ complete: true, homes: [] }),
		};
		expect((await checkCodexQuotaReadiness(opts)).ready).toBe(false);
		rmSync(truth);
		expect((await checkCodexQuotaReadiness(opts)).ready).toBe(false);
	});

	it("excludes proven drained history and independent logins without modifying them", async () => {
		const { truth, home, root } = fixture();
		writeFileSync(join(home, "auth.json"), "historical");
		const independent = join(root, "independent");
		mkdirSync(independent);
		writeFileSync(join(independent, "auth.json"), "independent");
		expect(
			(
				await checkCodexQuotaReadiness({
					canonicalAuthPath: truth,
					collectHomes: async () => ({
						complete: true,
						homes: [
							{ home, ownership: "managed", activity: "drained" },
							{
								home: independent,
								ownership: "independent",
								activity: "active",
							},
						],
					}),
				})
			).ready,
		).toBe(true);
	});

	it("rechecks disk every time and rejects pending migration even with a correct link", async () => {
		const { truth, home } = fixture();
		symlinkSync(truth, join(home, "auth.json"));
		const opts = {
			canonicalAuthPath: truth,
			collectHomes: async () => ({
				complete: true,
				homes: [
					{ home, ownership: "managed" as const, activity: "active" as const },
				],
			}),
		};
		expect((await checkCodexQuotaReadiness(opts)).ready).toBe(true);
		writeFileSync(join(home, ".credential-copy-pending"), "pending");
		expect((await checkCodexQuotaReadiness(opts)).ready).toBe(false);
		rmSync(join(home, ".credential-copy-pending"));
		rmSync(join(home, "auth.json"));
		symlinkSync(join(home, "missing.json"), join(home, "auth.json"));
		expect((await checkCodexQuotaReadiness(opts)).ready).toBe(false);
	});

	it("requires complete fresh authority and refuses unknown process ownership", async () => {
		const { truth, home } = fixture();
		symlinkSync(truth, join(home, "auth.json"));
		for (const inventory of [
			{ complete: false, homes: [] },
			{
				complete: true,
				homes: [
					{ home, ownership: "unknown" as const, activity: "active" as const },
				],
			},
			{
				complete: true,
				homes: [
					{ home, ownership: "managed" as const, activity: "unknown" as const },
				],
			},
		]) {
			expect(
				(
					await checkCodexQuotaReadiness({
						canonicalAuthPath: truth,
						collectHomes: async () => inventory,
					})
				).ready,
			).toBe(false);
		}
	});

	it("rejects an active managed copy even when its bytes match canonical", async () => {
		const { truth, home } = fixture();
		writeFileSync(join(home, "auth.json"), "fixture-auth", { mode: 0o600 });
		const result = await checkCodexQuotaReadiness({
			canonicalAuthPath: truth,
			collectHomes: async () => ({
				complete: true,
				homes: [{ home, ownership: "managed", activity: "active" }],
			}),
		});
		expect(result.ready).toBe(false);
		expect(result.failures).toEqual([
			{ home, reason: "credential_not_shared" },
		]);
	});
});
