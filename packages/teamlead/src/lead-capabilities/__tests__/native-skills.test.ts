import { createHash } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
	NATIVE_CODEX_SKILL_NAMES,
	verifyNativeSkillBaseline,
} from "../native-skills.js";

it("records the exact native baseline and rejects additional sources, content drift and version drift", () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "native-baseline-")));
	const sources = NATIVE_CODEX_SKILL_NAMES.map((name) => {
		const text = `---\nname: ${name}\ndescription: Native fixture.\n---\nPinned content.\n`;
		mkdirSync(join(root, name));
		writeFileSync(join(root, name, "SKILL.md"), text);
		return { name, sha256: createHash("sha256").update(text).digest("hex") };
	});
	const baseline = { codexVersion: "fixture-v1", sources };
	try {
		const receipts = verifyNativeSkillBaseline({
			root,
			baseline,
			codexVersion: "fixture-v1",
			secrets: [],
		});
		expect(receipts).toHaveLength(6);
		expect(receipts[0]).toMatchObject({
			codexVersion: "fixture-v1",
			status: "selected",
			sourcePath: join(root, NATIVE_CODEX_SKILL_NAMES[0], "SKILL.md"),
		});
		mkdirSync(join(root, "extra"));
		expect(() =>
			verifyNativeSkillBaseline({
				root,
				baseline,
				codexVersion: "fixture-v1",
				secrets: [],
			}),
		).toThrow("baseline_drift");
		rmSync(join(root, "extra"), { recursive: true });
		expect(() =>
			verifyNativeSkillBaseline({
				root,
				baseline,
				codexVersion: "fixture-v2",
				secrets: [],
			}),
		).toThrow("baseline_drift");
		writeFileSync(
			join(root, NATIVE_CODEX_SKILL_NAMES[0], "SKILL.md"),
			"changed",
		);
		try {
			verifyNativeSkillBaseline({
				root,
				baseline,
				codexVersion: "fixture-v1",
				secrets: [],
			});
			throw new Error("expected rejection");
		} catch (error) {
			expect(error).toMatchObject({
				message: "baseline_drift",
				receipt: { status: "baseline_drift", codexVersion: "fixture-v1" },
			});
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
