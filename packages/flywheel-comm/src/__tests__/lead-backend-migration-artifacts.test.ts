import { createHash } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
	observeMigrationArtifact,
	preserveMigrationArtifacts,
	replaceMigrationArtifact,
} from "../lead-backend-migration-artifacts.js";

const hash = (value: string) =>
	createHash("sha256").update(value).digest("hex");
const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});
function fixture() {
	const home = mkdtempSync(join(tmpdir(), "fly2459-files-"));
	dirs.push(home);
	mkdirSync(join(home, ".flywheel/lead-backend-migrations"), {
		recursive: true,
		mode: 0o700,
	});
	mkdirSync(join(home, ".flywheel/manifests"));
	mkdirSync(join(home, "Library/LaunchAgents"), { recursive: true });
	const manifest = join(
		home,
		".flywheel/manifests/flywheel-flywheel-product-lead.json",
	);
	const plist = join(
		home,
		"Library/LaunchAgents/com.flywheel.lead.flywheel-flywheel-product-lead.plist",
	);
	writeFileSync(manifest, "old-manifest");
	writeFileSync(plist, "old-plist");
	return {
		home,
		manifest,
		plist,
		expected: {
			manifestSha: hash("old-manifest"),
			plistSha: hash("old-plist"),
		},
		assertStopped: () => {},
	};
}
it("preserves source before stop, stages independently, and restores exact original bytes", () => {
	const f = fixture();
	preserveMigrationArtifacts(f.home, f.expected);
	unlinkSync(f.plist); // Existing lifecycle stop deliberately removes it.
	expect(
		replaceMigrationArtifact(
			f.home,
			f.expected,
			"manifest",
			"new-manifest",
			"apply",
			f.assertStopped,
		),
	).toBe("written");
	expect(
		replaceMigrationArtifact(
			f.home,
			f.expected,
			"plist",
			"new-plist",
			"apply",
			f.assertStopped,
		),
	).toBe("written");
	expect(
		replaceMigrationArtifact(
			f.home,
			f.expected,
			"manifest",
			"new-manifest",
			"apply",
			f.assertStopped,
		),
	).toBe("unchanged");
	replaceMigrationArtifact(
		f.home,
		f.expected,
		"plist",
		"new-plist",
		"rollback",
		f.assertStopped,
	);
	replaceMigrationArtifact(
		f.home,
		f.expected,
		"manifest",
		"new-manifest",
		"rollback",
		f.assertStopped,
	);
	expect(readFileSync(f.manifest, "utf8")).toBe("old-manifest");
	expect(readFileSync(f.plist, "utf8")).toBe("old-plist");
});
it("rejects unknown content after partial staging without overwriting it", () => {
	const f = fixture();
	preserveMigrationArtifacts(f.home, f.expected);
	replaceMigrationArtifact(
		f.home,
		f.expected,
		"manifest",
		"new-manifest",
		"apply",
		f.assertStopped,
	);
	writeFileSync(f.plist, "another-owner");
	expect(() =>
		replaceMigrationArtifact(
			f.home,
			f.expected,
			"plist",
			"new-plist",
			"apply",
			f.assertStopped,
		),
	).toThrow("conflict");
	expect(readFileSync(f.plist, "utf8")).toBe("another-owner");
});
it("refuses to back up stale artifacts or stage before writer absence is proven", () => {
	const f = fixture();
	expect(() =>
		preserveMigrationArtifacts(f.home, {
			...f.expected,
			plistSha: hash("wrong"),
		}),
	).toThrow();
	preserveMigrationArtifacts(f.home, f.expected);
	expect(() =>
		replaceMigrationArtifact(
			f.home,
			f.expected,
			"manifest",
			"new-manifest",
			"apply",
			() => {
				throw new Error("live writer");
			},
		),
	).toThrow("live writer");
	expect(readFileSync(f.manifest, "utf8")).toBe("old-manifest");
});
it("observes source, target and foreign artifact bytes without overwriting them", () => {
	const f = fixture();
	const observe = () =>
		observeMigrationArtifact(
			f.home,
			f.expected,
			"manifest",
			"new-manifest",
			f.assertStopped,
		);
	expect(observe().state).toBe("pre");
	writeFileSync(f.manifest, "new-manifest");
	expect(observe().state).toBe("post");
	writeFileSync(f.manifest, "foreign");
	expect(observe().state).toBe("conflict");
	expect(readFileSync(f.manifest, "utf8")).toBe("foreign");
});
it("accepts a missing plist only after independently proving stop", () => {
	const f = fixture();
	unlinkSync(f.plist);
	expect(() =>
		observeMigrationArtifact(f.home, f.expected, "plist", "new-plist", () => {
			throw Error("live");
		}),
	).toThrow("live");
	expect(
		observeMigrationArtifact(
			f.home,
			f.expected,
			"plist",
			"new-plist",
			f.assertStopped,
		).state,
	).toBe("pre");
	unlinkSync(f.manifest);
	expect(
		observeMigrationArtifact(
			f.home,
			f.expected,
			"manifest",
			"new-manifest",
			f.assertStopped,
		).state,
	).toBe("conflict");
});
