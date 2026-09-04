import { spawnSync } from "node:child_process";
import {
	chmodSync,
	cpSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const repoRoot = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"..",
);
const probe = join(repoRoot, "scripts", "codex-tui-nudge-probe.sh");
const hasCodex =
	spawnSync("codex", ["--version"], { encoding: "utf8" }).status === 0;
const hasTmux = spawnSync("tmux", ["-V"], { encoding: "utf8" }).status === 0;
const hasProbeRuntime = hasCodex && hasTmux;

const probeTest = hasProbeRuntime ? it : it.skip;
const availability = hasProbeRuntime ? "" : "SKIPPED: codex/tmux absent — ";

it("rejects a renamed environment switch that mutates the probe config", () => {
	const scratch = mkdtempSync(join(tmpdir(), "fly2296-env-mutation-"));
	try {
		const mutatedProbe = join(scratch, "codex-tui-nudge-probe.sh");
		const fakeServer = join(scratch, "codex-tui-fake-app-server.cjs");
		const binDir = join(scratch, "bin");
		const home = join(scratch, "source-home");
		cpSync(probe, mutatedProbe);
		cpSync(
			join(repoRoot, "scripts", "codex-tui-fake-app-server.cjs"),
			fakeServer,
		);
		mkdirSync(binDir);
		mkdirSync(home);
		chmodSync(mutatedProbe, 0o700);
		writeFileSync(join(home, "config.toml"), 'model = "gpt-5.6-sol"\n');
		const codex = join(binDir, "codex");
		const tmux = join(binDir, "tmux");
		writeFileSync(codex, "#!/bin/bash\nexit 0\n");
		writeFileSync(tmux, "#!/bin/bash\nexit 44\n");
		chmodSync(codex, 0o700);
		chmodSync(tmux, 0o700);

		const needle = '  append_temporary_trust "$config" "$cwd"\n';
		const source = readFileSync(mutatedProbe, "utf8");
		expect(source.split(needle)).toHaveLength(2);
		writeFileSync(
			mutatedProbe,
			source.replace(
				needle,
				`${needle}  if [ "\${FLYWHEEL_NUDGE_PROBE_EXTRA_INJECT:-}" = "1" ]; then
    printf 'probe_unexpected_mutation = true\\n' >> "$config"
  fi
`,
			),
		);

		const result = spawnSync(
			"/bin/bash",
			[mutatedProbe, "--home", home, "--expect", "menu", "--codex-bin", codex],
			{
				cwd: repoRoot,
				encoding: "utf8",
				env: {
					...process.env,
					FLYWHEEL_NUDGE_PROBE_EXTRA_INJECT: "1",
					PATH: `${binDir}:${process.env.PATH ?? ""}`,
				},
				timeout: 5_000,
			},
		);
		const evidence = `${result.stdout ?? ""}${result.stderr ?? ""}`;
		expect(result.status, evidence).toBe(2);
		expect(evidence).toContain("unexpected config copy difference");
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
});

probeTest(
	`${availability}codex-tui-nudge-probe self-check`,
	() => {
		const result = spawnSync("/bin/bash", [probe, "--self-check"], {
			cwd: repoRoot,
			encoding: "utf8",
			timeout: 120_000,
		});
		const evidence = `${result.stdout ?? ""}${result.stderr ?? ""}`;

		expect(result.status, evidence).toBe(0);
	},
	120_000,
);
