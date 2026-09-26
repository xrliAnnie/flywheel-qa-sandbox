import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { selectLeadRuleSources } from "../lead-capabilities/rule-sources.js";

const root = fileURLToPath(new URL("../../", import.meta.url)).replace(
	/\/$/,
	"",
);
const oracle = JSON.parse(
	readFileSync(
		new URL(
			"../../../../engineering/doc/FLY-2909-ack-action-batching/ack-rule-oracle.json",
			import.meta.url,
		),
		"utf8",
	),
) as { sources: { path: string; off: string; on: string }[] };

for (const savings of [0, 1]) {
	for (const batching of [0, 1]) {
		it(`selects historical bytes for token savings=${savings}, batching=${batching}`, () => {
			for (const name of ["inbox-ack-rule.md", "runner-patrol-rules.md"]) {
				const source =
					name === "inbox-ack-rule.md"
						? `scripts/${name}`
						: `lead-rules-base/${name}`;
				const selected = execFileSync(
					"bash",
					[
						"-c",
						'source "$1/scripts/lead-rules-bundle.sh"; _LEAD_TOKEN_SAVINGS_LAUNCH="$2"; _LEAD_ACK_ACTION_BATCHING_LAUNCH="$3"; rules_bundle_select_source "$1/$4"',
						"fixture",
						root,
						String(savings),
						String(batching),
						source,
					],
					{ encoding: "utf8", env: { ...process.env, BASH_ENV: "/dev/null" } },
				).trim();
				const expected = oracle.sources.find(
					(row) =>
						row.path ===
						(savings ? source : `lead-rules-base/legacy-token-savings/${name}`),
				)!;
				expect(
					createHash("sha256").update(readFileSync(selected)).digest("hex"),
				).toBe(batching ? expected.on : expected.off);
			}
		});
	}
}

for (const backend of ["claude-code", "codex-app-server"] as const) {
	for (const enabled of [false, true]) {
		it(`capability source bytes ${backend}, ACK batching=${enabled}`, () => {
			const result = selectLeadRuleSources({
				scriptsDir: `${root}/scripts`,
				projectRoot: root,
				leadId: "eng-lead",
				role: "dept",
				commBackend: "mailbox",
				hasSummaryDuty: false,
				inboxEnabled: true,
				screencaptureEnabled: false,
				skills: [],
				backend,
				ackActionBatchingEnabled: enabled,
			});
			for (const row of oracle.sources.filter(
				(row) => !row.path.includes("legacy-token-savings"),
			)) {
				const source = result.sources.find((source) =>
					source.sourceId.endsWith(row.path.split("/").at(-1)!),
				)!;
				expect(source.sourceSha256).toBe(enabled ? row.on : row.off);
			}
		});
	}
}

it("preserves pre-batching Bootstrap generator and both formatters byte-for-byte", () => {
	for (const [path, digest] of Object.entries(oracle.bootstrapSources)) {
		expect(
			createHash("sha256")
				.update(readFileSync(`${root}/${path}`))
				.digest("hex"),
		).toBe(digest);
	}
});
