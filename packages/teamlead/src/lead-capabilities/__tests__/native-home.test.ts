import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { prepareNativeSkillHome } from "../native-home.js";
import { NATIVE_CODEX_SKILL_NAMES } from "../native-skills.js";

it("copies native resources to a new home, detects drift and preserves unrelated home state", () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "native-home-")));
	const sourceRoot = join(root, "source"),
		codexHome = join(root, "home");
	mkdirSync(sourceRoot);
	mkdirSync(codexHome);
	writeFileSync(join(codexHome, "keep"), "untouched");
	const sources = NATIVE_CODEX_SKILL_NAMES.map((name) => {
		const text = `---\nname: ${name}\ndescription: fixture\n---\nNative instructions\n`;
		mkdirSync(join(sourceRoot, name));
		writeFileSync(join(sourceRoot, name, "SKILL.md"), text);
		return { name, sha256: createHash("sha256").update(text).digest("hex") };
	});
	const options = {
		sourceRoot,
		codexHome,
		codexVersion: "fixture",
		baseline: { codexVersion: "fixture", sources },
		secrets: ["secret-canary"],
	};
	try {
		writeFileSync(join(sourceRoot, "imagegen", "helper.py"), "resource");
		const pinned = {
			...options,
			baseline: {
				...options.baseline,
				origin: {
					root: sourceRoot,
					files: [
						...sources.map((source) => ({
							path: `${source.name}/SKILL.md`,
							sha256: source.sha256,
						})),
						{
							path: "imagegen/helper.py",
							sha256: createHash("sha256").update("resource").digest("hex"),
						},
					],
				},
			},
		};
		const pinnedInstall = prepareNativeSkillHome(pinned);
		pinnedInstall.close();
		writeFileSync(join(sourceRoot, "imagegen", "helper.py"), "unreviewed");
		expect(() => prepareNativeSkillHome(pinned)).toThrow();
		expect(existsSync(join(codexHome, "skills/.system"))).toBe(false);
		writeFileSync(join(sourceRoot, "imagegen", "helper.py"), "resource");
		const installed = prepareNativeSkillHome(options);
		expect(
			readFileSync(
				join(codexHome, "skills/.system/imagegen/helper.py"),
				"utf8",
			),
		).toBe("resource");
		installed.assertCurrent();
		writeFileSync(
			join(codexHome, "skills/.system/imagegen/helper.py"),
			"changed",
		);
		expect(() => installed.assertCurrent()).toThrow();
		installed.close();
		expect(existsSync(join(codexHome, "skills/.system"))).toBe(false);
		expect(readFileSync(join(codexHome, "keep"), "utf8")).toBe("untouched");
		writeFileSync(join(sourceRoot, "imagegen", "helper.py"), "secret-canary");
		expect(() => prepareNativeSkillHome(options)).toThrow();
		expect(existsSync(join(codexHome, "skills/.system"))).toBe(false);
		rmSync(join(sourceRoot, "imagegen", "helper.py"));
		symlinkSync(
			join(codexHome, "keep"),
			join(sourceRoot, "imagegen", "helper.py"),
		);
		expect(() => prepareNativeSkillHome(options)).toThrow();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
