import { execFileSync } from "node:child_process";
import {
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { acquireXhsStagingOwner } from "../xhs-staging-owner.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
function root() {
	const value = realpathSync(
		mkdtempSync(`${realpathSync(tmpdir())}/xhs-stage-owner-`),
	);
	roots.push(value);
	return value;
}
const identity = { readStart: () => "fixture-current-start" };
it("holds a nonce/start-time marker until explicit close and refuses another live owner", async () => {
	const project = root();
	const owner = await acquireXhsStagingOwner(project, identity);
	try {
		const lock = join(project, ".flywheel-xhs-staging-owner");
		const [name] = readdirSync(lock);
		const marker = JSON.parse(readFileSync(join(lock, name!), "utf8"));
		expect(marker).toMatchObject({
			pid: process.pid,
			processStartTime: "fixture-current-start",
		});
		expect(marker.token).toMatch(/^[a-f0-9]{24}$/);
		expect(lstatSync(join(lock, name!)).mode & 0o777).toBe(0o600);
		await expect(acquireXhsStagingOwner(project, identity)).rejects.toThrow(
			"xhs_staging_owner_unavailable",
		);
		expect(() => owner.assertCurrent()).not.toThrow();
	} finally {
		await owner.close();
	}
	expect(readdirSync(project)).toEqual([]);
	const next = await acquireXhsStagingOwner(project, identity);
	await next.close();
});
it("refuses missing process identity before creating state and preserves malformed old markers", async () => {
	const project = root();
	await expect(
		acquireXhsStagingOwner(project, { readStart: () => null }),
	).rejects.toThrow("xhs_staging_owner_unavailable");
	expect(readdirSync(project)).toEqual([]);
	const lock = join(project, ".flywheel-xhs-staging-owner");
	mkdirSync(lock);
	writeFileSync(join(lock, "holder"), "{}", { mode: 0o600 });
	await expect(acquireXhsStagingOwner(project, identity)).rejects.toThrow(
		"xhs_staging_owner_unavailable",
	);
	expect(readFileSync(join(lock, "holder"), "utf8")).toBe("{}");
});

it("takes over a marker only after its real child process has exited", async () => {
	const project = root(),
		lock = join(project, ".flywheel-xhs-staging-owner");
	const pid = Number(
		execFileSync(
			process.execPath,
			["-e", "process.stdout.write(String(process.pid))"],
			{ encoding: "utf8" },
		),
	);
	expect(pid).toBeGreaterThan(0);
	mkdirSync(lock);
	writeFileSync(
		join(lock, `holder.${pid}.old`),
		JSON.stringify({
			pid,
			at: Date.now(),
			token: "old",
			processStartTime: "departed-start",
		}),
		{ mode: 0o600 },
	);
	const owner = await acquireXhsStagingOwner(project, identity);
	expect(() => owner.assertCurrent()).not.toThrow();
	const [name] = readdirSync(lock);
	expect(name).not.toBe(`holder.${pid}.old`);
	await owner.close();
	expect(readdirSync(project)).toEqual([]);
});
it("refuses staging and release while the owned marker bytes are changed", async () => {
	const project = root(),
		owner = await acquireXhsStagingOwner(project, identity),
		lock = join(project, ".flywheel-xhs-staging-owner");
	const [name] = readdirSync(lock),
		path = join(lock, name!),
		original = readFileSync(path, "utf8");
	try {
		writeFileSync(path, "{}", { mode: 0o600 });
		expect(() => owner.assertCurrent()).toThrow(
			"xhs_staging_owner_unavailable",
		);
		await expect(owner.close()).rejects.toThrow(
			"xhs_staging_owner_unavailable",
		);
		expect(readFileSync(path, "utf8")).toBe("{}");
	} finally {
		writeFileSync(path, original, { mode: 0o600 });
		await owner.close();
	}
});
