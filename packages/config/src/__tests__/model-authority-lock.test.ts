import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

it("canonicalizes aliased parents for mutual exclusion even before authority exists", async () => {
	const { withModelAuthorityLock } = await import("../model-authority-lock.js");
	const root = mkdtempSync(join(tmpdir(), "fly2570-lock-"));
	const alias = root + "-alias";
	symlinkSync(root, alias);
	try {
		await withModelAuthorityLock(join(root, "models.json"), async () => {
			await expect(
				withModelAuthorityLock(
					join(alias, "models.json"),
					async () => {
						throw new Error("entered second writer");
					},
					{ timeoutMs: 10 },
				),
			).rejects.toThrow(/acquisition budget exhausted/);
		});
		await expect(
			withModelAuthorityLock(join(alias, "models.json"), async () => 42),
		).resolves.toBe(42);
		await expect(
			withModelAuthorityLock(
				join(root, "missing", "models.json"),
				async () => 42,
			),
		).rejects.toThrow(/parent directory.*missing/);
	} finally {
		rmSync(alias);
		rmSync(root, { recursive: true, force: true });
	}
});

it("recovers an empty orphan only after the 120 second fallback", async () => {
	const { mkdirSync, utimesSync } = await import("node:fs");
	const { withModelAuthorityLock } = await import("../model-authority-lock.js");
	const root = mkdtempSync(join(tmpdir(), "fly2570-empty-"));
	const path = join(root, "models.json");
	mkdirSync(`${path}.lock`);
	try {
		await expect(
			withModelAuthorityLock(path, async () => 42, { timeoutMs: 10 }),
		).rejects.toThrow(/budget exhausted/);
		const old = new Date(Date.now() - 121000);
		utimesSync(`${path}.lock`, old, old);
		expect(await withModelAuthorityLock(path, async () => 42)).toBe(42);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

it("does not age-steal a holder whose PID cannot be inspected", async () => {
	const { mkdirSync, writeFileSync } = await import("node:fs");
	const { vi } = await import("vitest");
	const { withModelAuthorityLock } = await import("../model-authority-lock.js");
	const root = mkdtempSync(join(tmpdir(), "fly2570-eperm-"));
	const path = join(root, "models.json");
	mkdirSync(`${path}.lock`);
	writeFileSync(
		join(`${path}.lock`, "holder.fixture"),
		JSON.stringify({ pid: 2147483646, at: 1 }),
	);
	const realKill = process.kill.bind(process);
	const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
		if (pid === 2147483646)
			throw Object.assign(new Error("uninspectable"), { code: "EPERM" });
		return realKill(pid, signal);
	});
	try {
		await expect(
			withModelAuthorityLock(path, async () => 42, { timeoutMs: 10 }),
		).rejects.toThrow(/budget exhausted/);
	} finally {
		kill.mockRestore();
		rmSync(root, { recursive: true, force: true });
	}
});
