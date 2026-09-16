import { spawnSync } from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

it.each(["headless", "tui"])(
	"v2 %s requires dist unless explicit dev source mode is enabled",
	(mode) => {
		const root = mkdtempSync(join(tmpdir(), "v2-launch-"));
		try {
			const scripts = join(root, "scripts"),
				bin = join(root, "bin"),
				home = join(root, "home"),
				trace = join(root, "trace");
			for (const path of [
				join(scripts, "lib"),
				bin,
				home,
				join(root, "src/lead-backends/codex"),
				join(root, "dist/bin"),
			])
				mkdirSync(path, { recursive: true });
			copyFileSync(
				join(__dirname, "../../scripts/codex-lead.sh"),
				join(scripts, "codex-lead.sh"),
			);
			writeFileSync(
				join(scripts, "lib/canonical-lead-identity.sh"),
				"canonical_lead_identity_resolve() { export FLYWHEEL_PROJECT_NAME=demo FLYWHEEL_LEAD_ID=eng; }\n",
			);
			writeFileSync(
				join(scripts, "lead-rules-bundle.sh"),
				"assemble_full_access_governance() { return 0; }\n",
			);
			writeFileSync(
				join(root, "dist/bin/verify-codex-deployment.js"),
				"// verifier fixture\n",
			);
			const runtime =
				mode === "tui" ? "codex-lead-tui-runtime" : "codex-lead-runtime";
			writeFileSync(
				join(root, `src/lead-backends/codex/${runtime}.ts`),
				"// source fixture\n",
			);
			writeFileSync(
				join(scripts, "codex-lead-tui-home.sh"),
				'#!/bin/sh\nprintf old-home >> "$TRACE"\n',
			);
			for (const tool of ["node", "npx"]) {
				writeFileSync(
					join(bin, tool),
					`#!/bin/sh\nprintf '%s\\n' '${tool}' >> "$TRACE"\n`,
				);
				chmodSync(join(bin, tool), 0o755);
			}
			const env = {
				PATH: `${bin}:/usr/bin:/bin`,
				HOME: home,
				TRACE: trace,
				FLYWHEEL_CODEX_LEAD_PROFILE: "full-access",
				FLYWHEEL_CODEX_CAPABILITY_BUNDLE_VERSION: "2",
				FLYWHEEL_CODEX_LEAD_MODE: mode,
				FLYWHEEL_LEAD_DRY_RUN: "1",
				CODEX_HOME: home,
				FLYWHEEL_CODEX_TUI_CWD: root,
			};
			const run = (extra = {}) =>
				spawnSync(
					"/bin/bash",
					[join(scripts, "codex-lead.sh"), "eng", root, "demo"],
					{ env: { ...env, ...extra }, encoding: "utf8" },
				);
			const production = run();
			expect(production.status).not.toBe(0);
			expect(readFileSync(trace, "utf8")).not.toContain("npx");
			writeFileSync(trace, "");
			expect(run({ FLYWHEEL_CODEX_LEAD_DEV_SOURCE: "1" }).status).toBe(0);
			expect(readFileSync(trace, "utf8")).toContain("npx");
			mkdirSync(join(root, "dist/lead-backends/codex"), { recursive: true });
			writeFileSync(
				join(root, `dist/lead-backends/codex/${runtime}.js`),
				"// compiled fixture\n",
			);
			writeFileSync(trace, "");
			expect(run({ FLYWHEEL_LEAD_DRY_RUN: "0" }).status).toBe(0);
			expect(readFileSync(trace, "utf8")).not.toContain("old-home");
			writeFileSync(join(bin, "node"), "#!/bin/sh\nexit 78\n");
			writeFileSync(trace, "");
			expect(run({ FLYWHEEL_LEAD_DRY_RUN: "0" }).status).toBe(78);
			expect(readFileSync(trace, "utf8")).not.toContain("old-home");
			expect(readFileSync(trace, "utf8")).not.toContain("npx");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	},
);
