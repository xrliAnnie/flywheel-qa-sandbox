import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { installManifestSkills } from "../manifest-skills.js";

it("installs exact pinned skill bytes in the activation discovery directory and detects drift", () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "manifest-skills-"))),
		home = join(root, "home"),
		path = join(root, "SKILL.md");
	mkdirSync(home);
	const text =
		"---\nname: delivery\ndescription: Deliver approved reports.\n---\nUse the broker report capabilities.\n";
	writeFileSync(path, text);
	try {
		const skills = installManifestSkills({
			codexHome: home,
			secrets: [],
			sources: [
				{
					name: "delivery",
					path,
					sha256: createHash("sha256").update(text).digest("hex"),
				},
			],
		});
		const installed = join(home, "skills/delivery/SKILL.md");
		expect(readFileSync(installed, "utf8")).toBe(text);
		expect(skills.receipts[0]).toMatchObject({
			sourceId: "skill/delivery",
			sourcePath: installed,
			status: "selected",
		});
		skills.assertCurrent();
		chmodSync(installed, 0o600);
		writeFileSync(installed, `${text}changed`);
		expect(() => skills.assertCurrent()).toThrow(
			"capability_skills_unverified",
		);
		skills.close();
		expect(existsSync(join(home, "skills"))).toBe(false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
it("rejects mismatched hashes, missing metadata, secrets, duplicate names and extra existing sources", () => {
	const root = realpathSync(
			mkdtempSync(join(tmpdir(), "manifest-skills-deny-")),
		),
		home = join(root, "home"),
		path = join(root, "SKILL.md");
	mkdirSync(home);
	const good =
		"---\nname: delivery\ndescription: Deliver reports.\n---\nBody.\n";
	try {
		for (const text of [good, "# no metadata\n", `${good}SECRET_CANARY`]) {
			writeFileSync(path, text);
			const sha256 = createHash("sha256")
				.update(text === good ? "wrong" : text)
				.digest("hex");
			expect(() =>
				installManifestSkills({
					codexHome: home,
					secrets: ["SECRET_CANARY"],
					sources: [{ name: "delivery", path, sha256 }],
				}),
			).toThrow("capability_skills_unverified");
			expect(existsSync(join(home, "skills"))).toBe(false);
		}
		writeFileSync(path, good);
		const source = {
			name: "delivery",
			path,
			sha256: createHash("sha256").update(good).digest("hex"),
		};
		expect(() =>
			installManifestSkills({
				codexHome: home,
				secrets: [],
				sources: [source, source],
			}),
		).toThrow("capability_skills_unverified");
		mkdirSync(join(home, "skills"));
		writeFileSync(join(home, "skills", "foreign.md"), "KEEP");
		expect(() =>
			installManifestSkills({
				codexHome: home,
				secrets: [],
				sources: [source],
			}),
		).toThrow("capability_skills_unverified");
		expect(readFileSync(join(home, "skills/foreign.md"), "utf8")).toBe("KEEP");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
