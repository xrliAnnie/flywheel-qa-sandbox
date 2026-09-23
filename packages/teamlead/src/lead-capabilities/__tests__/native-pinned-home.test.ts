import { createHash } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { preparePinnedNativeSkillHome } from "../native-home.js";
import { NATIVE_CODEX_SKILL_NAMES } from "../native-skills.js";

const pinned = vi.hoisted(() => ({
	baseline: undefined as
		| {
				codexVersion: string;
				origin: {
					root: string;
					files: { path: string; sha256: string }[];
				};
				sources: { name: string; sha256: string }[];
		  }
		| undefined,
	resolve: vi.fn(),
}));

vi.mock("../native-skill-baseline.js", () => ({
	PINNED_NATIVE_CODEX_SKILLS: { codexVersion: "target", sources: [] },
	resolvePinnedNativeSkillBaseline: (version: string) => {
		pinned.resolve(version);
		if (!pinned.baseline || version !== pinned.baseline.codexVersion)
			throw new Error("baseline_drift");
		return pinned.baseline;
	},
}));

const roots: string[] = [];
afterEach(() => {
	pinned.resolve.mockClear();
	pinned.baseline = undefined;
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

it("selects an immutable baseline by the actual binary version", () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "native-pinned-")));
	roots.push(root);
	const codexHome = join(root, "home");
	const target = join(codexHome, "skills/.system");
	mkdirSync(target, { recursive: true });
	const sources = NATIVE_CODEX_SKILL_NAMES.map((name) => {
		const text = `---\nname: ${name}\ndescription: fixture\n---\nPinned instructions\n`;
		const path = `${name}/SKILL.md`;
		mkdirSync(join(target, name));
		writeFileSync(join(target, path), text);
		return {
			name,
			path,
			sha256: createHash("sha256").update(text).digest("hex"),
		};
	});
	pinned.baseline = {
		codexVersion: "0.154.0",
		origin: {
			root: join(root, "immutable-origin"),
			files: sources.map(({ path, sha256 }) => ({ path, sha256 })),
		},
		sources: sources.map(({ name, sha256 }) => ({ name, sha256 })),
	};

	const prepared = preparePinnedNativeSkillHome({
		codexHome,
		codexVersion: "0.154.0",
		secrets: [],
	});
	expect(pinned.resolve).toHaveBeenCalledWith("0.154.0");
	prepared.assertCurrent();
	prepared.close();

	expect(() =>
		preparePinnedNativeSkillHome({
			codexHome,
			codexVersion: "0.155.0",
			secrets: [],
		}),
	).toThrow("baseline_drift");
});

it("uses the selected rollback baseline when populating a missing home", () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "native-rollback-")));
	roots.push(root);
	const origin = join(root, "immutable-origin");
	const codexHome = join(root, "home");
	mkdirSync(origin);
	mkdirSync(codexHome);
	const sources = NATIVE_CODEX_SKILL_NAMES.map((name) => {
		const text = `---\nname: ${name}\ndescription: fixture\n---\nRollback instructions\n`;
		const path = `${name}/SKILL.md`;
		mkdirSync(join(origin, name));
		writeFileSync(join(origin, path), text);
		return {
			name,
			path,
			sha256: createHash("sha256").update(text).digest("hex"),
		};
	});
	pinned.baseline = {
		codexVersion: "0.153.2",
		origin: {
			root: origin,
			files: sources.map(({ path, sha256 }) => ({ path, sha256 })),
		},
		sources: sources.map(({ name, sha256 }) => ({ name, sha256 })),
	};

	const prepared = preparePinnedNativeSkillHome({
		codexHome,
		codexVersion: "0.153.2",
		secrets: [],
	});
	expect(prepared.root).toBe(join(codexHome, "skills/.system"));
	prepared.assertCurrent();
	prepared.close();
});

it("uses a pinned origin whose configured root traverses a directory symlink", () => {
	const root = realpathSync(
		mkdtempSync(join(tmpdir(), "native-symlink-origin-")),
	);
	roots.push(root);
	const origin = join(root, "immutable-origin");
	const originAlias = join(root, "origin-alias");
	const codexHome = join(root, "home");
	mkdirSync(origin);
	mkdirSync(codexHome);
	symlinkSync(origin, originAlias, "dir");
	const sources = NATIVE_CODEX_SKILL_NAMES.map((name) => {
		const text = `---\nname: ${name}\ndescription: fixture\n---\nSymlinked origin instructions\n`;
		const path = `${name}/SKILL.md`;
		mkdirSync(join(origin, name));
		writeFileSync(join(origin, path), text);
		return {
			name,
			path,
			sha256: createHash("sha256").update(text).digest("hex"),
		};
	});
	pinned.baseline = {
		codexVersion: "0.156.0",
		origin: {
			root: originAlias,
			files: sources.map(({ path, sha256 }) => ({ path, sha256 })),
		},
		sources: sources.map(({ name, sha256 }) => ({ name, sha256 })),
	};

	const prepared = preparePinnedNativeSkillHome({
		codexHome,
		codexVersion: "0.156.0",
		secrets: [],
	});
	expect(prepared.root).toBe(join(codexHome, "skills/.system"));
	prepared.assertCurrent();
	prepared.close();
});

it("reports the native-home contract error when a pinned origin is absent", () => {
	const root = realpathSync(
		mkdtempSync(join(tmpdir(), "native-absent-origin-")),
	);
	roots.push(root);
	const codexHome = join(root, "home");
	mkdirSync(codexHome);
	pinned.baseline = {
		codexVersion: "0.156.0",
		origin: {
			root: join(root, "missing-origin"),
			files: [],
		},
		sources: [],
	};

	expect(() =>
		preparePinnedNativeSkillHome({
			codexHome,
			codexVersion: "0.156.0",
			secrets: [],
		}),
	).toThrow("native_skill_home_unverified");
});
