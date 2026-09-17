import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	truncateSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { XhsBridgeArtifactRegistry } from "../xhs-artifact-registry.js";

const fault = vi.hoisted(() => ({ badMode: false }));
vi.mock("node:fs", async (original) => {
	const fs = await original<typeof import("node:fs")>();
	return {
		...fs,
		mkdtempSync: (prefix: string) => {
			const root = fs.mkdtempSync(prefix);
			if (fault.badMode && prefix.includes(".flywheel-xhs-artifact-"))
				fs.chmodSync(root, 0o755);
			return root;
		},
	};
});

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
	fault.badMode = false;
	for (const close of cleanup.splice(0).reverse()) await close();
});
function setup() {
	const root = realpathSync(mkdtempSync("/tmp/xhs-bridge-artifact-"));
	const registry = new XhsBridgeArtifactRegistry();
	const state = { current: true };
	const context = {
		scope: { projectId: "project", leadId: "lead", activationId: "activation" },
		projectRoot: root,
		assertCurrent: () => {
			if (!state.current) throw Error("stale");
		},
	};
	cleanup.push(async () => {
		try {
			await registry.close();
		} catch {}
		rmSync(root, { recursive: true, force: true });
	});
	return { root, registry, state, context };
}
it("registers bounded bytes with the real parent artifact store and keeps handles activation-scoped", async () => {
	const s = setup();
	const artifact = await s.registry.put(
		s.context,
		Buffer.from("fixture"),
		"image/png",
	);
	expect(artifact).not.toHaveProperty("relativePath");
	expect(
		(
			await s.registry.forScope(s.context.scope).read(artifact.handle)
		).data.toString(),
	).toBe("fixture");
	for (const patch of [
		{ projectId: "other" },
		{ leadId: "other" },
		{ activationId: "other" },
	])
		expect(() =>
			s.registry.forScope({ ...s.context.scope, ...patch }),
		).toThrow();
	s.state.current = false;
	await expect(
		s.registry.forScope(s.context.scope).read(artifact.handle),
	).rejects.toThrow();
});
it("rejects oversize/unsupported input before creating directories and detects changed bytes", async () => {
	const s = setup();
	await expect(
		s.registry.put(s.context, Buffer.alloc(10 * 1024 * 1024 + 1), "image/png"),
	).rejects.toThrow();
	await expect(
		s.registry.put(s.context, Buffer.from("x"), "text/html"),
	).rejects.toThrow();
	expect(readdirSync(s.root)).toEqual([]);
	const artifact = await s.registry.put(
		s.context,
		Buffer.from("fixture"),
		"image/png",
	);
	const directory = join(
		s.root,
		readdirSync(s.root).find((name) =>
			name.startsWith(".flywheel-xhs-artifact-"),
		)!,
	);
	writeFileSync(join(directory, `${artifact.handle}.png`), "changed");
	await expect(
		s.registry.forScope(s.context.scope).read(artifact.handle),
	).rejects.toThrow();
});
it("removes only owned directories on close and does not follow a replaced directory", async () => {
	const s = setup();
	const other = join(s.root, "other");
	mkdirSync(other);
	writeFileSync(join(other, "keep"), "safe");
	const artifact = await s.registry.put(
		s.context,
		Buffer.from("fixture"),
		"image/png",
	);
	const owned = join(
		s.root,
		readdirSync(s.root).find((name) =>
			name.startsWith(".flywheel-xhs-artifact-"),
		)!,
	);
	renameSync(owned, `${owned}-moved`);
	symlinkSync(other, owned);
	await expect(s.registry.close()).rejects.toThrow(
		"xhs_artifact_cleanup_unconfirmed",
	);
	expect(readFileSync(join(other, "keep"), "utf8")).toBe("safe");
	expect(existsSync(join(`${owned}-moved`, `${artifact.handle}.png`))).toBe(
		true,
	);
});
it("cleans a normal activation and invalidates its handles", async () => {
	const s = setup();
	await s.registry.put(s.context, Buffer.from("fixture"), "image/png");
	await s.registry.close();
	await s.registry.close();
	expect(readdirSync(s.root)).toEqual([]);
	expect(() => s.registry.forScope(s.context.scope)).toThrow();
});

it("retains cleanup ownership when store initialization fails", async () => {
	const s = setup();
	fault.badMode = true;
	await expect(
		s.registry.put(s.context, Buffer.from("fixture"), "image/png"),
	).rejects.toThrow("xhs_artifact_unavailable");
	const names = readdirSync(s.root).filter((name) =>
		name.startsWith(".flywheel-xhs-artifact-"),
	);
	expect(names).toHaveLength(1);
	await expect(s.registry.close()).rejects.toThrow(
		"xhs_artifact_cleanup_unconfirmed",
	);
	chmodSync(join(s.root, names[0]!), 0o700);
	await s.registry.close();
	expect(readdirSync(s.root)).toEqual([]);
});

// Sandbox ps is unavailable; keep real lock/filesystem behavior with an explicit
// start-time observation seam for this test process.
vi.mock("flywheel-config", async (original) => ({
	...(await original<typeof import("flywheel-config")>()),
	processStartTime: () => "fixture-bridge-start",
}));

it("refuses new allocation when retained directories reach the cap and preserves them", async () => {
	const s = setup();
	const paths = Array.from({ length: 8 }, () =>
		mkdtempSync(join(s.root, ".flywheel-xhs-artifact-")),
	);
	await expect(
		s.registry.put(s.context, Buffer.from("x"), "image/png"),
	).rejects.toThrow("staging_leftovers_exceeded");
	await s.registry.close();
	for (const path of paths) expect(existsSync(path)).toBe(true);
});
it("holds exclusive project ownership until registry close", async () => {
	const s = setup(),
		other = new XhsBridgeArtifactRegistry();
	try {
		await s.registry.put(s.context, Buffer.from("x"), "image/png");
		await expect(
			other.put(s.context, Buffer.from("y"), "image/png"),
		).rejects.toThrow();
		await s.registry.close();
		await expect(
			other.put(s.context, Buffer.from("y"), "image/png"),
		).resolves.toMatchObject({ size: 1 });
	} finally {
		await other.close();
	}
});

it("freezes upload bytes before asynchronous owner acquisition", async () => {
	const s = setup(),
		data = Buffer.from("before"),
		pending = s.registry.put(s.context, data, "image/png");
	data.fill(0);
	const artifact = await pending;
	expect(
		(
			await s.registry.forScope(s.context.scope).read(artifact.handle)
		).data.toString(),
	).toBe("before");
});
it("waits for pending owner acquisition on close without admitting the upload", async () => {
	const s = setup(),
		put = s.registry.put(s.context, Buffer.from("x"), "image/png");
	const closed = s.registry.close();
	await expect(put).rejects.toThrow();
	await closed;
	expect(readdirSync(s.root)).toEqual([]);
});

it("counts retained bytes together with concurrent reservations across activations", async () => {
	const s = setup();
	const retained = mkdtempSync(join(s.root, ".flywheel-xhs-artifact-"));
	const file = join(retained, "retained.bin");
	writeFileSync(file, "");
	truncateSync(file, 256 * 1024 * 1024 - 3);
	const results = await Promise.allSettled(
		["first", "second"].map((activationId) =>
			s.registry.put(
				{ ...s.context, scope: { ...s.context.scope, activationId } },
				Buffer.from("xx"),
				"image/png",
			),
		),
	);
	expect(
		results.filter((result) => result.status === "fulfilled"),
	).toHaveLength(1);
	expect(results.filter((result) => result.status === "rejected")).toEqual([
		{
			status: "rejected",
			reason: expect.objectContaining({
				message: "staging_leftovers_exceeded",
			}),
		},
	]);
	await s.registry.close();
	expect(readdirSync(s.root)).toEqual([retained.split("/").at(-1)]);
	expect(existsSync(file)).toBe(true);
});

it("rejects both existing handle reads and new uploads after owner marker tampering", async () => {
	const s = setup();
	const artifact = await s.registry.put(
		s.context,
		Buffer.from("x"),
		"image/png",
	);
	const lock = join(s.root, ".flywheel-xhs-staging-owner");
	const marker = join(lock, readdirSync(lock)[0]!);
	const original = readFileSync(marker);
	try {
		writeFileSync(marker, "{}");
		await expect(
			s.registry.forScope(s.context.scope).read(artifact.handle),
		).rejects.toThrow();
		await expect(
			s.registry.put(s.context, Buffer.from("y"), "image/png"),
		).rejects.toThrow();
	} finally {
		writeFileSync(marker, original);
	}
});
