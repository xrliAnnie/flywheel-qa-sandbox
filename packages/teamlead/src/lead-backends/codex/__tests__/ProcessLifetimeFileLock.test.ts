import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireProcessLifetimeFileLock } from "../ProcessLifetimeFileLock.js";

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

describe("acquireProcessLifetimeFileLock", () => {
	it("holds an exclusive flock until the parent closes its stdin pipe", async () => {
		const dir = mkdtempSync(join(tmpdir(), "flywheel-lock-"));
		dirs.push(dir);
		const path = join(dir, "owner.lock");
		const first = await acquireProcessLifetimeFileLock(path);
		expect(first.status).toBe("acquired");
		const second = await acquireProcessLifetimeFileLock(path);
		expect(second.status).toBe("conflict");
		if (first.status === "acquired") await first.handle.close();
		const third = await acquireProcessLifetimeFileLock(path);
		expect(third.status).toBe("acquired");
		if (third.status === "acquired") await third.handle.close();
	});

	it("distinguishes helper failure from a live-owner conflict", async () => {
		const result = await acquireProcessLifetimeFileLock("/unused", {
			pythonPath: "/missing/python3",
		});
		expect(result).toMatchObject({ status: "unavailable" });
	});
});
