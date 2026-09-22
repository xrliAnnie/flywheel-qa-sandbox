import { execFileSync } from "node:child_process";
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
	const resolver = join(__dirname, "../../scripts/lead-rules-bundle.sh");
	const assembled = execFileSync(
		"bash",
		[
			"-c",
			'source "$1"; compute_lead_rule_bundle dept "$2" mailbox 1',
			"_",
			resolver,
			base,
		],
		{
			encoding: "utf8",
			env: {
				...process.env,
				FLYWHEEL_LEAD_HAS_SUMMARY_DUTY: "1",
				FLYWHEEL_CODEX_CAPABILITY_BUNDLE_VERSION: "2",
			},
		},
	)
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((path) => path.split("/").pop() as string)
		.filter((name) => name !== "codex-discord-reply-contract.md");
	const currentSources = new Set([
		...assembled,
		"discord-reply-contract.md",
		"inbox-ack-rule.md",
		"screencapture-l3-skill.md",
	]);
	const baselineChars = new Map<string, number>(
		inventory.sources.map((source: { basename: string; chars: number }) => [
			source.basename,
			source.chars,
		]),
	);
	const union = new Set([...baselineChars.keys(), ...currentSources]);
	const measured = new Set<string>();
	let delta = 0;
	for (const basename of union) {
		const path = ["inbox-ack-rule.md", "screencapture-l3-skill.md"].includes(
			basename,
		)
			? join(__dirname, "../../scripts", basename)
			: join(base, basename);
		const currentChars = currentSources.has(basename)
			? [...readFileSync(path, "utf8")].length
			: 0;
		delta += currentChars - (baselineChars.get(basename) ?? 0);
		measured.add(basename);
	}
	expect([...currentSources].filter((name) => !measured.has(name))).toEqual([]);
	expect(currentSources).toContain("visible-tui-default.md");
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
