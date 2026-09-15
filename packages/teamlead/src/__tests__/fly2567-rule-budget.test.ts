import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

const base = join(__dirname, "../../lead-rules-base");
const inventory = JSON.parse(
	readFileSync(
		join(
			__dirname,
			"../../../../engineering/doc/FLY-2567-lead-token-savings/evidence/rules-inventory.json",
		),
		"utf8",
	),
);

it("FLY-2567 reduces the measured 18-source resident bundle by at least 25 percent", () => {
	const delta = inventory.sources.reduce(
		(sum: number, source: { basename: string; chars: number }) => {
			const path = ["inbox-ack-rule.md", "screencapture-l3-skill.md"].includes(
				source.basename,
			)
				? join(__dirname, "../../scripts", source.basename)
				: join(base, source.basename);
			return sum + [...readFileSync(path, "utf8")].length - source.chars;
		},
		0,
	);
	expect(inventory.bundle_chars + delta).toBeLessThanOrEqual(
		inventory.bundle_chars * 0.75,
	);
});

it("FLY-2567 keeps patrol authority resident and makes the versioned procedure mandatory on demand", () => {
	const resident = readFileSync(join(base, "runner-patrol-rules.md"), "utf8");
	for (const contract of [
		"runbooks/patrol-v1.md",
		"MANIFEST",
		"只巡检自己名下",
		"真实性 guard 停手",
		"永不写 authority/gate/approval/claim",
		"永不终结 Runner",
		"STEP DWELL",
		"步骤 A",
		"步骤 B",
		"UNAVAILABLE",
		"founder-only-authority.md",
	])
		expect(resident).toContain(contract);
	expect(resident).not.toContain("BEGIN IMMEDIATE");
	expect(readFileSync(join(base, "runbooks/patrol-v1.md"), "utf8")).toContain(
		"# FLY-2080-FINDING-GATE-BEGIN",
	);
});
