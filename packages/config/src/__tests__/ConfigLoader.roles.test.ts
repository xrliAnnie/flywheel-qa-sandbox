/**
 * FLY-123: ConfigLoader `roles:` block validation (Codex design review R1 #7).
 * Misspelled role keys / unsupported backends must fail at LOAD time;
 * configs without `roles` must load unchanged (reverse-compat).
 */
import { describe, expect, it } from "vitest";
import { ConfigLoader } from "../ConfigLoader.js";

const BASE = `
project: testproj
linear:
  team_id: team-1
runners:
  default: claude
  available:
    claude:
      type: claude
teams:
  - name: eng
    orchestrators:
      - id: orch-1
        runner: claude
decision_layer:
  mode: rules
  autonomy_level: observer
  escalation_channel: "#test"
`;

function loaderFor(yaml: string): ConfigLoader {
	return new ConfigLoader(async () => yaml);
}

describe("ConfigLoader roles block (FLY-123)", () => {
	it("reverse-compat: config WITHOUT roles loads unchanged", async () => {
		const config = await loaderFor(BASE).load("fake.yaml");
		expect(config.project).toBe("testproj");
		expect(config.roles).toBeUndefined();
	});

	it("accepts a valid roles block", async () => {
		const yaml = `${BASE}
roles:
  runner:
    backend: codex-tmux
    model: gpt-5.5-codex
  lead:
    backend: claude-tmux
`;
		const config = await loaderFor(yaml).load("fake.yaml");
		expect(config.roles?.runner?.backend).toBe("codex-tmux");
		expect(config.roles?.runner?.model).toBe("gpt-5.5-codex");
		expect(config.roles?.lead?.backend).toBe("claude-tmux");
	});

	it("[FLY-241] trims surrounding whitespace on a set model (quoted padded value)", async () => {
		// A quoted padded model passes the non-empty check but would reach the
		// CLI as `--model "  claude-fable-5  "` (rejected → Runner won't start).
		// ConfigLoader normalizes it to the bare id on load.
		const yaml = `${BASE}
roles:
  runner:
    backend: claude-tmux
    model: "  claude-fable-5  "
`;
		const config = await loaderFor(yaml).load("fake.yaml");
		expect(config.roles?.runner?.model).toBe("claude-fable-5");
	});

	it("rejects misspelled role keys", async () => {
		const yaml = `${BASE}
roles:
  runer:
    backend: codex-tmux
`;
		await expect(loaderFor(yaml).load("fake.yaml")).rejects.toThrow(
			/roles\.runer is not a recognized role/,
		);
	});

	it("rejects unsupported backends", async () => {
		const yaml = `${BASE}
roles:
  runner:
    backend: gemini-tmux
`;
		await expect(loaderFor(yaml).load("fake.yaml")).rejects.toThrow(
			/roles\.runner\.backend "gemini-tmux" is not supported/,
		);
	});

	it("rejects missing backend", async () => {
		const yaml = `${BASE}
roles:
  runner:
    model: opus
`;
		await expect(loaderFor(yaml).load("fake.yaml")).rejects.toThrow(
			/roles\.runner\.backend is required/,
		);
	});

	it("rejects empty model string", async () => {
		const yaml = `${BASE}
roles:
  runner:
    backend: codex-tmux
    model: "  "
`;
		await expect(loaderFor(yaml).load("fake.yaml")).rejects.toThrow(
			/roles\.runner\.model must be a non-empty string/,
		);
	});

	it("rejects scalar roles block", async () => {
		const yaml = `${BASE}
roles: codex
`;
		await expect(loaderFor(yaml).load("fake.yaml")).rejects.toThrow(
			/roles must be a YAML mapping/,
		);
	});
});
