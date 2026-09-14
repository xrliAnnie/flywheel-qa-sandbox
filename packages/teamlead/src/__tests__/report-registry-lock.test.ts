import {
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ReportRegistry } from "../bridge/report-registry.js";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

it("serializes registry operations across instances and releases after failure", async () => {
	const dir = mkdtempSync(join(tmpdir(), "fly2538-registry-lock-"));
	dirs.push(dir);
	const first = new ReportRegistry(dir);
	const second = new ReportRegistry(dir);
	const events: string[] = [];
	let release!: () => void;
	let entered!: () => void;
	const barrier = new Promise<void>((resolve) => {
		release = resolve;
	});
	const ready = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const holder = first.withLock(async () => {
		events.push("first");
		entered();
		await barrier;
		throw new Error("operation failed");
	});
	const failed = expect(holder).rejects.toThrow("operation failed");
	await ready;
	const waiter = second.withLock(async () => {
		events.push("second");
	});
	await new Promise((resolve) => setTimeout(resolve, 75));
	expect(events).toEqual(["first"]);
	release();
	await failed;
	await waiter;
	expect(events).toEqual(["first", "second"]);
});

it("preserves both entries when two instances stage before either commits", async () => {
	const dir = mkdtempSync(join(tmpdir(), "fly2538-registry-union-"));
	dirs.push(dir);
	const first = new ReportRegistry(dir);
	const second = new ReportRegistry(dir);
	const html =
		"<html><head><title>report</title></head><body>test</body></html>";
	await first
		.stagePublish("seed", html, undefined, first.hostingBinding())
		.commit();
	const a = first.stagePublish("a", html, undefined, first.hostingBinding());
	const b = second.stagePublish("b", html, undefined, second.hostingBinding());
	await a.commit();
	await b.commit();
	expect(first.list().map((entry) => entry.projectName)).toEqual([
		"seed",
		"a",
		"b",
	]);
});

it("rejects a staged publish after the hosting binding changes", async () => {
	const dir = mkdtempSync(join(tmpdir(), "fly2538-registry-binding-"));
	dirs.push(dir);
	const registry = new ReportRegistry(dir);
	const html = "<html><head></head><body>report</body></html>";
	await registry
		.stagePublish("seed", html, undefined, registry.hostingBinding())
		.commit();
	const pending = registry.stagePublish(
		"pending",
		html,
		undefined,
		registry.hostingBinding(),
	);
	const path = join(dir, "registry.json");
	const changed = JSON.parse(readFileSync(path, "utf8"));
	changed.vercelProjectName = "fw-reports-abcdef";
	changed.hosting = {
		provider: "vercel-blob",
		storeId: "next",
		migratedAt: new Date().toISOString(),
		gatewayDeploymentId: "new",
	};
	writeFileSync(path, JSON.stringify(changed));
	await expect(pending.commit()).rejects.toMatchObject({
		name: "ReportHostingBindingConflict",
	});
	expect(registry.list().map((entry) => entry.projectName)).toEqual(["seed"]);
	expect(registry.vercelProjectName()).toBe("fw-reports-abcdef");
});

it("rejects marker CAS when a newer publication changed the retained set", async () => {
	const dir = mkdtempSync(join(tmpdir(), "fly2538-registry-cas-"));
	dirs.push(dir);
	const registry = new ReportRegistry(dir);
	const html = "<html><head></head><body>report</body></html>";
	await registry
		.stagePublish("seed", html, undefined, registry.hostingBinding())
		.commit();
	const binding = registry.hostingBinding();
	const snapshot = registry.retainedSnapshot();
	await registry
		.stagePublish("newer", html, undefined, registry.hostingBinding())
		.commit();
	await expect(
		registry.commitRetarget({
			expectedSourceHostingKey: binding.hostingKey,
			expectedManifestDigest: snapshot.manifestDigest,
			expectedContentDigest: snapshot.contentDigest,
			vercelProjectName: "fw-reports-abcdef",
			hosting: {
				provider: "vercel-blob",
				storeId: "next",
				gatewayDeploymentId: "dpl_next",
				gatewayFormat: "gzip-v1",
				manifestDigest: snapshot.manifestDigest,
				contentDigest: snapshot.contentDigest,
			},
			now: () => Date.now(),
		}),
	).rejects.toMatchObject({ name: "ReportRetargetManifestStale" });
	expect(registry.hostingBinding()).toEqual(binding);
});

it("backs up the exact prior registry once and makes a proved retarget replay a no-op", async () => {
	const dir = mkdtempSync(join(tmpdir(), "fly2538-registry-replay-"));
	dirs.push(dir);
	const registry = new ReportRegistry(dir);
	await registry
		.stagePublish(
			"seed",
			"<html><head></head><body>seed</body></html>",
			undefined,
			registry.hostingBinding(),
		)
		.commit();
	const binding = registry.hostingBinding();
	const snapshot = registry.retainedSnapshot();
	const before = readFileSync(join(dir, "registry.json"), "utf8");
	const input = {
		expectedSourceHostingKey: binding.hostingKey,
		expectedManifestDigest: snapshot.manifestDigest,
		expectedContentDigest: snapshot.contentDigest,
		vercelProjectName: "fw-reports-abcdef",
		hosting: {
			provider: "vercel-blob" as const,
			storeId: "next",
			gatewayDeploymentId: "dpl_next",
			gatewayFormat: "gzip-v1" as const,
		},
		now: () => Date.now(),
	};
	expect((await registry.commitRetarget(input)).written).toBe(true);
	const after = readFileSync(join(dir, "registry.json"), "utf8");
	expect((await registry.commitRetarget(input)).written).toBe(false);
	expect(readFileSync(join(dir, "registry.json"), "utf8")).toBe(after);
	const backups = readdirSync(dir).filter((name) =>
		name.startsWith("registry.json.bak-"),
	);
	expect(backups).toHaveLength(1);
	expect(readFileSync(join(dir, backups[0]!), "utf8")).toBe(before);
	await expect(
		registry.commitRetarget({
			...input,
			vercelProjectName: "fw-reports-fedcba",
			hosting: { ...input.hosting, storeId: "third" },
		}),
	).rejects.toMatchObject({ name: "ReportHostingBindingConflict" });
	expect(
		readdirSync(dir).filter((name) => name.startsWith("registry.json.bak-")),
	).toEqual(backups);
});

it("refuses a legacy migration marker proved against another hosting binding", async () => {
	const dir = mkdtempSync(join(tmpdir(), "fly2538-marker-cas-"));
	dirs.push(dir);
	const registry = new ReportRegistry(dir);
	await registry.ensureVercelProjectName();
	const before = readFileSync(join(dir, "registry.json"), "utf8");
	await expect(
		async () =>
			await registry.markHostingMigrated(
				{
					provider: "vercel-blob",
					migratedAt: new Date().toISOString(),
					gatewayDeploymentId: "old-proof",
				},
				{ expectedHostingKey: "wrong/store" },
			),
	).rejects.toMatchObject({ name: "ReportHostingBindingConflict" });
	expect(readFileSync(join(dir, "registry.json"), "utf8")).toBe(before);
});

it("binds gateway format and store discovery markers to the proved hosting", async () => {
	const dir = mkdtempSync(join(tmpdir(), "fly2538-proof-markers-"));
	dirs.push(dir);
	const registry = new ReportRegistry(dir);
	const project = await registry.ensureVercelProjectName();
	await registry.markHostingMigrated(
		{
			provider: "vercel-blob",
			migratedAt: new Date().toISOString(),
			gatewayDeploymentId: "initial",
		},
		{ expectedHostingKey: registry.hostingBinding().hostingKey },
	);
	const before = readFileSync(join(dir, "registry.json"), "utf8");
	await expect(
		registry.recordHostingStoreId({
			expectedProjectName: "wrong",
			storeId: "store_NeXt",
			blobHost: "next.private.blob.vercel-storage.com",
		}),
	).rejects.toMatchObject({ name: "ReportHostingBindingConflict" });
	expect(readFileSync(join(dir, "registry.json"), "utf8")).toBe(before);
	await registry.recordHostingStoreId({
		expectedProjectName: project,
		storeId: "store_NeXt",
		blobHost: "next.private.blob.vercel-storage.com",
	});
	expect(registry.hosting()?.storeId).toBe("next");
	await expect(
		registry.markGatewayFormat({
			expectedHostingKey: "wrong/store",
			gatewayDeploymentId: "dpl_wrong",
		}),
	).rejects.toMatchObject({ name: "ReportHostingBindingConflict" });
	await registry.markGatewayFormat({
		expectedHostingKey: registry.hostingBinding().hostingKey,
		gatewayDeploymentId: "dpl_proved",
	});
	expect(registry.hosting()).toMatchObject({
		storeId: "next",
		gatewayFormat: "gzip-v1",
		gatewayDeploymentId: "dpl_proved",
	});
});

it("reports lock contention as typed busy without stealing a live holder", async () => {
	const dir = mkdtempSync(join(tmpdir(), "fly2538-busy-"));
	dirs.push(dir);
	const first = new ReportRegistry(dir);
	const second = new ReportRegistry(dir, {
		lockOptions: { timeoutMs: 25, retryMs: 5 },
	});
	await first.withLock(async () => {
		await expect(
			second.withLock(async () => {
				throw new Error("must not enter");
			}),
		).rejects.toMatchObject({ name: "ReportRegistryLockBusy" });
	});
	await expect(second.withLock(async () => 42)).resolves.toBe(42);
});

it("serializes whole hosting mutations independently of the target project", async () => {
	const dir = mkdtempSync(join(tmpdir(), "fly2538-hosting-lock-"));
	dirs.push(dir);
	const first = new ReportRegistry(dir);
	const second = new ReportRegistry(dir, {
		lockOptions: { timeoutMs: 25, retryMs: 5 },
	});
	await first.withHostingMutationLock(async () => {
		await expect(
			second.withHostingMutationLock(async () => {}),
		).rejects.toMatchObject({ name: "ReportRegistryLockBusy" });
		await expect(second.withLock(async () => 42)).resolves.toBe(42);
	});
	await expect(second.withHostingMutationLock(async () => 42)).resolves.toBe(
		42,
	);
});

it("rejects malformed registry tokens before reading migration content paths", () => {
	const dir = mkdtempSync(join(tmpdir(), "fly2538-snapshot-token-"));
	dirs.push(dir);
	writeFileSync(
		join(dir, "registry.json"),
		JSON.stringify({
			reports: [
				{
					token: "../outside",
					projectName: "p",
					createdAt: new Date().toISOString(),
					bytes: 1,
				},
			],
		}),
	);
	expect(() => new ReportRegistry(dir).retainedSnapshot()).toThrow(
		"invalid report token",
	);
});
