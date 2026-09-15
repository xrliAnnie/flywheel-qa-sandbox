import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const root = new URL("../../../../", import.meta.url);
const manifest = JSON.parse(
	readFileSync(
		new URL("./fixtures/fly2567/compatibility.json", import.meta.url),
		"utf8",
	),
) as {
	owner: string;
	reviewBy: string;
	pairs: {
		id: string;
		rationale: string;
		members: { path: string; sha256: string }[];
	}[];
};
function verify(read: (path: string) => Buffer) {
	for (const pair of manifest.pairs) {
		if (!pair.rationale.trim())
			throw new Error(`${pair.id}: missing compatibility rationale`);
		for (const member of pair.members) {
			const digest = createHash("sha256")
				.update(read(member.path))
				.digest("hex");
			if (digest !== member.sha256)
				throw new Error(
					`${pair.id}: ${member.path} drift; review shared duties and both modes before updating the manifest rationale and hashes`,
				);
		}
	}
}
const read = (path: string) => readFileSync(fileURLToPath(new URL(path, root)));
it("pins every ON/OFF dependency independently with a reviewed compatibility rationale", () => {
	expect(manifest.owner).toBe("flywheel-eng-lead");
	expect(manifest.reviewBy).toBe("2026-10-15");
	verify(read);
});
for (const path of new Set(
	manifest.pairs.flatMap((pair) => pair.members.map((member) => member.path)),
)) {
	it(`rejects independent drift in ${path}`, () => {
		expect(() =>
			verify((candidate) =>
				candidate === path
					? Buffer.concat([read(candidate), Buffer.from("\nmutation")])
					: read(candidate),
			),
		).toThrow(path);
	});
}
