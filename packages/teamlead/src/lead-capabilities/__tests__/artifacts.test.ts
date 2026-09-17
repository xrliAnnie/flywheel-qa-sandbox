import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { LeadArtifactStore } from "../artifacts.js";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});
function setup() {
	const projectRoot = realpathSync(
		mkdtempSync(join(tmpdir(), "fly2519-artifacts-")),
	);
	dirs.push(projectRoot);
	const artifactRoot = join(projectRoot, "artifacts");
	mkdirSync(artifactRoot, { mode: 0o700 });
	return {
		projectRoot,
		artifactRoot,
		store: new LeadArtifactStore({
			projectRoot,
			artifactRoot,
			assertCurrent() {},
		}),
	};
}
it("publishes bounded immutable-content handles into the project and resolves only its own handles", async () => {
	const a = setup(),
		b = setup();
	const handle = await a.store.put(Buffer.from("qa screenshot"), "image/png");
	expect(handle).toMatchObject({ mimeType: "image/png", size: 13 });
	expect(handle.relativePath).toMatch(/^artifacts\/[a-f0-9-]+\.png$/);
	expect((await a.store.read(handle.handle)).data.toString()).toBe(
		"qa screenshot",
	);
	await expect(b.store.read(handle.handle)).rejects.toThrow(/artifact/);
	await expect(a.store.read("../secrets")).rejects.toThrow(/artifact/);
});
it("rejects changes and symlink replacements instead of publishing changed bytes", async () => {
	const { store, projectRoot } = setup(),
		handle = await store.put(Buffer.from("safe"), "text/plain");
	const path = join(projectRoot, handle.relativePath);
	writeFileSync(path, "evil");
	await expect(store.read(handle.handle)).rejects.toThrow(/artifact/);
	rmSync(path);
	symlinkSync("/etc/passwd", path);
	await expect(store.read(handle.handle)).rejects.toThrow(/artifact/);
});
it("rejects outside roots and stale authority without writing", async () => {
	const a = setup(),
		b = setup();
	expect(
		() =>
			new LeadArtifactStore({
				projectRoot: a.projectRoot,
				artifactRoot: b.artifactRoot,
				assertCurrent() {},
			}),
	).toThrow(/artifact/);
	const store = new LeadArtifactStore({
		projectRoot: a.projectRoot,
		artifactRoot: a.artifactRoot,
		assertCurrent() {
			throw Error("revoked");
		},
	});
	await expect(store.put(Buffer.from("x"), "text/plain")).rejects.toThrow(
		/artifact/,
	);
});

it("invalidates the activation store on close", async () => {
	const { store } = setup(),
		h = await store.put(Buffer.from("x"), "text/plain");
	store.close();
	await expect(store.read(h.handle)).rejects.toThrow(/artifact/);
	await expect(store.put(Buffer.from("x"), "text/plain")).rejects.toThrow(
		/artifact/,
	);
});

it("requires a direct project child so a writable intermediate directory cannot redirect publication", () => {
	const { projectRoot } = setup(),
		parent = join(projectRoot, "nested"),
		artifactRoot = join(parent, "artifacts");
	mkdirSync(artifactRoot, { recursive: true, mode: 0o700 });
	expect(
		() =>
			new LeadArtifactStore({ projectRoot, artifactRoot, assertCurrent() {} }),
	).toThrow(/artifact/);
});

it("registers a bounded video stream in the current parent scope and preserves bytes", async () => {
	const a = setup(),
		b = setup();
	const data = Buffer.from(
		"000000186674797069736f6d0000000069736f6d6d703432",
		"hex",
	);
	const handle = await a.store.putVideo(
		(async function* () {
			yield data.subarray(0, 8);
			yield data.subarray(8);
		})(),
	);
	expect(handle).toMatchObject({ mimeType: "video/mp4", size: data.length });
	expect(handle.relativePath).toMatch(/\.mp4$/);
	expect((await a.store.read(handle.handle)).data).toEqual(data);
	await expect(b.store.read(handle.handle)).rejects.toThrow(
		"lead_artifact_denied",
	);
});
it("rejects oversized, failed, cancelled or stale video streams without registering a handle", async () => {
	const a = setup();
	const cancelled = new AbortController();
	cancelled.abort();
	for (const stream of [
		(async function* () {
			yield Buffer.alloc(10 * 1024 * 1024);
			yield Buffer.from("x");
		})(),
		(async function* () {
			yield Buffer.from("x");
			throw Error("private details");
		})(),
		(async function* () {})(),
	])
		await expect(a.store.putVideo(stream)).rejects.toThrow(
			"lead_artifact_denied",
		);
	await expect(
		a.store.putVideo(
			(async function* () {
				yield Buffer.from("x");
			})(),
			cancelled.signal,
		),
	).rejects.toThrow("lead_artifact_denied");
	await expect(
		a.store.putVideo("https://example.test/video" as never),
	).rejects.toThrow("lead_artifact_denied");
	await expect(
		a.store.put(Buffer.alloc(10 * 1024 * 1024 + 1), "video/mp4"),
	).rejects.toThrow("lead_artifact_denied");
	await expect(
		a.store.putVideo(
			(async function* () {
				yield Buffer.from("x");
				a.store.close();
				yield Buffer.from("y");
			})(),
		),
	).rejects.toThrow("lead_artifact_denied");
	expect(readdirSync(a.artifactRoot)).toEqual([]);
});
it("cancels a pending video read and admits only one active video stream", async () => {
	const a = setup(),
		abort = new AbortController();
	let release!: () => void;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	const pending = a.store.putVideo(
		(async function* () {
			await held;
			yield Buffer.from("x");
		})(),
		abort.signal,
	);
	try {
		await expect(
			a.store.putVideo(
				(async function* () {
					yield Buffer.from("x");
				})(),
			),
		).rejects.toThrow("lead_artifact_denied");
		abort.abort();
		await expect(pending).rejects.toThrow("lead_artifact_denied");
		expect(readdirSync(a.artifactRoot)).toEqual([]);
	} finally {
		release();
	}
});
