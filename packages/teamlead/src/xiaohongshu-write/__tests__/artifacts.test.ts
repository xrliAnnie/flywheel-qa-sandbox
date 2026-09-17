import { createHash } from "node:crypto";
import {
	chmodSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { XhsFrozenArtifactStore } from "../artifacts.js";
import { XhsWriteStore } from "../store.js";

const roots: string[] = [];
const ledgers: XhsWriteStore[] = [];
const png = Buffer.from("89504e470d0a1a0a0000000049454e44ae426082", "hex");
function fixture(limit = 1024) {
	const dir = mkdtempSync(join(tmpdir(), "xhs-media-"));
	roots.push(dir);
	const root = join(dir, "media");
	mkdirSync(root, { mode: 0o700 });
	const path = join(dir, "ledger.db");
	const ledger = new XhsWriteStore(path, {
		initialize: true,
		providerGeneration: "generation",
	});
	ledgers.push(ledger);
	const validate = vi.fn(async () => {});
	const store = new XhsFrozenArtifactStore(root, ledger, {
		attachmentLimit: limit,
		totalLimit: 4096,
		validate,
	});
	return { dir, root, path, ledger, validate, store };
}
async function* bytes(data = png) {
	yield data;
}
afterEach(() => {
	for (const ledger of ledgers.splice(0)) ledger.close();
	for (const dir of roots.splice(0))
		rmSync(dir, { recursive: true, force: true });
});
it("freezes exact bytes and reopens from the actual persistent catalog", async () => {
	const f = fixture();
	const artifact = await f.store.import("project", "image/png", bytes(), 1000);
	expect(artifact.sha256).toBe(createHash("sha256").update(png).digest("hex"));
	expect(f.validate).toHaveBeenCalledOnce();
	expect(await f.store.read("project", artifact)).toEqual(png);
	f.ledger.close();
	const reopened = new XhsWriteStore(f.path, {
		providerGeneration: "generation",
	});
	ledgers.push(reopened);
	const store = new XhsFrozenArtifactStore(f.root, reopened, {
		attachmentLimit: 1024,
		totalLimit: 4096,
		validate: f.validate,
	});
	expect(await store.read("project", artifact)).toEqual(png);
	await expect(store.read("other", artifact)).rejects.toThrow(
		"artifact_unverified",
	);
});
it("rejects false MIME, decoder failures, oversized streams and metadata failures without registering files", async () => {
	const f = fixture(32);
	await expect(
		f.store.import("project", "video/mp4", bytes(), 1000),
	).rejects.toThrow("artifact_unverified");
	f.validate.mockRejectedValueOnce(Error("decoder private details"));
	await expect(
		f.store.import("project", "image/png", bytes(), 1000),
	).rejects.toThrow("artifact_unverified");
	await expect(
		f.store.import("project", "image/png", bytes(Buffer.alloc(33)), 1000),
	).rejects.toThrow("preview_media_too_large");
	vi.spyOn(f.ledger, "registerArtifact").mockImplementationOnce(() => {
		throw Error("disk failure");
	});
	await expect(
		f.store.import("project", "image/png", bytes(), 1000),
	).rejects.toThrow("artifact_unverified");
	expect(readdirSync(f.root)).toEqual([]);
});
it.each(["symlink", "hardlink", "bytes", "inode"])(
	"rejects changed frozen file: %s",
	async (mode) => {
		const f = fixture();
		const artifact = await f.store.import(
			"project",
			"image/png",
			bytes(),
			1000,
		);
		const file = join(f.root, readdirSync(f.root)[0]!);
		if (mode === "symlink") {
			renameSync(file, `${file}.old`);
			symlinkSync(`${file}.old`, file);
		}
		if (mode === "hardlink") linkSync(file, `${file}.extra`);
		if (mode === "bytes") writeFileSync(file, Buffer.alloc(png.length));
		if (mode === "inode") {
			renameSync(file, `${file}.old`);
			writeFileSync(file, png, { mode: 0o600 });
		}
		await expect(f.store.read("project", artifact)).rejects.toThrow(
			"artifact_unverified",
		);
	},
);
it("rejects directory replacement and unsafe root modes", async () => {
	const f = fixture();
	const artifact = await f.store.import("project", "image/png", bytes(), 1000);
	renameSync(f.root, `${f.root}-old`);
	mkdirSync(f.root, { mode: 0o700 });
	await expect(f.store.read("project", artifact)).rejects.toThrow(
		"artifact_unverified",
	);
	chmodSync(f.root, 0o777);
	expect(
		() =>
			new XhsFrozenArtifactStore(f.root, f.ledger, {
				attachmentLimit: 1024,
				totalLimit: 4096,
				validate: f.validate,
			}),
	).toThrow("artifact_unverified");
});
it("does not accept a path or URL as a stream", async () => {
	const f = fixture();
	await expect(
		f.store.import(
			"project",
			"image/png",
			"https://example.test/x.png" as never,
			1000,
		),
	).rejects.toThrow("artifact_unverified");
	expect(readdirSync(f.root)).toEqual([]);
});

it("counts in-flight and restart files against the global budget", async () => {
	const f = fixture();
	let release!: () => void;
	let entered!: () => void;
	const ready = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const pending = new Promise<void>((resolve) => {
		release = resolve;
	});
	const store = new XhsFrozenArtifactStore(f.root, f.ledger, {
		attachmentLimit: 1024,
		totalLimit: png.length,
		validate: async () => {
			entered();
			await pending;
		},
	});
	const first = store.import("project", "image/png", bytes(), 1000);
	await ready;
	try {
		await expect(
			store.import("project", "image/png", bytes(), 1000),
		).rejects.toThrow("artifact_capacity_exceeded");
	} finally {
		release();
	}
	await first;
	const reopened = new XhsFrozenArtifactStore(f.root, f.ledger, {
		attachmentLimit: 1024,
		totalLimit: png.length,
		validate: f.validate,
	});
	await expect(
		reopened.import("project", "image/png", bytes(), 1000),
	).rejects.toThrow("artifact_capacity_exceeded");
	expect(readdirSync(f.root)).toHaveLength(1);
});
it("revalidates identity and bytes after asynchronous decoding", async () => {
	const f = fixture();
	f.validate.mockImplementationOnce(async () => {
		const file = join(f.root, readdirSync(f.root)[0]!);
		writeFileSync(file, Buffer.alloc(png.length));
	});
	await expect(
		f.store.import("project", "image/png", bytes(), 1000),
	).rejects.toThrow("artifact_unverified");
	expect(readdirSync(f.root)).toEqual([]);
});

it("reuses retained verified content across retries, concurrent imports and ledger reopen, scoped by project", async () => {
	const f = fixture();
	const [first, concurrent] = await Promise.all([
		f.store.import("project", "image/png", bytes(), 1000),
		f.store.import("project", "image/png", bytes(), 1000),
	]);
	expect(concurrent).toEqual(first);
	const repeated = await Promise.all([
		f.store.import("project", "image/png", bytes(), 2000),
		f.store.import("project", "image/png", bytes(), 3000),
	]);
	expect(repeated).toEqual([first, first]);
	expect(readdirSync(f.root)).toHaveLength(1);
	f.ledger.close();
	const ledger = new XhsWriteStore(f.path, {
		providerGeneration: "generation",
	});
	ledgers.push(ledger);
	const reopened = new XhsFrozenArtifactStore(f.root, ledger, {
		attachmentLimit: 1024,
		totalLimit: 4096,
		validate: f.validate,
	});
	expect(await reopened.import("project", "image/png", bytes(), 4000)).toEqual(
		first,
	);
	expect(ledger.artifact(first.artifactId, "project")?.retentionUntil).toBe(
		4000 + 7 * 86400_000,
	);
	const other = await reopened.import("other", "image/png", bytes(), 5000);
	expect(other.artifactId).not.toBe(first.artifactId);
	const changed = await reopened.import(
		"project",
		"image/png",
		bytes(Buffer.concat([png, Buffer.from("different")])),
		6000,
	);
	expect(changed.artifactId).not.toBe(first.artifactId);
	expect(readdirSync(f.root)).toHaveLength(3);
});
it("does not conceal a corrupted retained artifact by registering a fresh replacement", async () => {
	const f = fixture();
	const first = await f.store.import("project", "image/png", bytes(), 1000);
	writeFileSync(join(f.root, first.artifactId), Buffer.alloc(png.length));
	await expect(
		f.store.import("project", "image/png", bytes(), 2000),
	).rejects.toThrow("artifact_unverified");
	expect(readdirSync(f.root)).toEqual([first.artifactId]);
});
