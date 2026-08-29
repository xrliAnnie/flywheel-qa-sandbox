/**
 * GEO-151 ProofShot config parsing + validation tests.
 */

import { describe, expect, it, vi } from "vitest";
import { ConfigLoader } from "../ConfigLoader.js";
import {
	DEFAULT_PROOFSHOT_CAPTURE_ANGLES,
	DEFAULT_PROOFSHOT_CAPTURE_STAGES,
	DEFAULT_PROOFSHOT_CONFIG,
	DEFAULT_PROOFSHOT_PATH_ALLOWLIST,
	DEFAULT_PROOFSHOT_VISION_TOKEN_BUDGET,
} from "../proofshot-defaults.js";

const BASE_CONFIG = `
project: geoforge3d
linear:
  team_id: "TEAM-123"
runners:
  default: claude
  available:
    claude:
      type: claude
teams:
  - name: engineering
    orchestrators:
      - type: code
        runner: claude
        budget_per_issue: 5.0
decision_layer:
  autonomy_level: manual_only
  escalation_channel: "#flywheel-dev"
`;

const WITH_PROOFSHOT = `${BASE_CONFIG}
skills:
  enabled: true
  proofshot:
    enabled: true
    dev_command: "pnpm dev"
    port: 3000
    capture_stages:
      - test
      - code_review
    vision_default: true
    vision_token_budget: 8000
    model_viewer_url: "https://3dviewer.net"
    model_capture_angles:
      - front
      - side
      - iso
      - top
    artifact_path_allowlist:
      - "^/Users/.+/\\\\.flywheel/screens/"
`;

function makeReadFile(yaml: string) {
	return vi.fn(async (_path: string) => yaml);
}

describe("ConfigLoader.proofshot", () => {
	it("parses skills.proofshot block when present", async () => {
		const loader = new ConfigLoader(makeReadFile(WITH_PROOFSHOT));
		const cfg = await loader.load("/dummy/.flywheel/config.yaml");
		expect(cfg.skills?.proofshot).toBeDefined();
		expect(cfg.skills?.proofshot?.enabled).toBe(true);
		expect(cfg.skills?.proofshot?.dev_command).toBe("pnpm dev");
		expect(cfg.skills?.proofshot?.port).toBe(3000);
		expect(cfg.skills?.proofshot?.capture_stages).toEqual([
			"test",
			"code_review",
		]);
		expect(cfg.skills?.proofshot?.vision_token_budget).toBe(8000);
		expect(cfg.skills?.proofshot?.model_capture_angles).toEqual([
			"front",
			"side",
			"iso",
			"top",
		]);
	});

	it("returns undefined proofshot when skills block has no proofshot", async () => {
		const yaml = `${BASE_CONFIG}
skills:
  enabled: true
  test_command: "pnpm test"
`;
		const loader = new ConfigLoader(makeReadFile(yaml));
		const cfg = await loader.load("/dummy/.flywheel/config.yaml");
		expect(cfg.skills?.proofshot).toBeUndefined();
	});

	it("returns undefined skills when entire skills block missing", async () => {
		const loader = new ConfigLoader(makeReadFile(BASE_CONFIG));
		const cfg = await loader.load("/dummy/.flywheel/config.yaml");
		expect(cfg.skills).toBeUndefined();
	});

	it("rejects non-boolean enabled", async () => {
		const bad = `${BASE_CONFIG}
skills:
  proofshot:
    enabled: "yes"
`;
		const loader = new ConfigLoader(makeReadFile(bad));
		await expect(loader.load("/dummy/.flywheel/config.yaml")).rejects.toThrow(
			/skills\.proofshot\.enabled must be a boolean/,
		);
	});

	it("rejects negative port", async () => {
		const bad = `${BASE_CONFIG}
skills:
  proofshot:
    port: -1
`;
		const loader = new ConfigLoader(makeReadFile(bad));
		await expect(loader.load("/dummy/.flywheel/config.yaml")).rejects.toThrow(
			/skills\.proofshot\.port must be a positive integer/,
		);
	});

	it("rejects capture_stages with non-string entries", async () => {
		const bad = `${BASE_CONFIG}
skills:
  proofshot:
    capture_stages:
      - test
      - 42
`;
		const loader = new ConfigLoader(makeReadFile(bad));
		await expect(loader.load("/dummy/.flywheel/config.yaml")).rejects.toThrow(
			/skills\.proofshot\.capture_stages must be an array of strings/,
		);
	});

	it("rejects non-array allowlist", async () => {
		const bad = `${BASE_CONFIG}
skills:
  proofshot:
    artifact_path_allowlist: "single-string"
`;
		const loader = new ConfigLoader(makeReadFile(bad));
		await expect(loader.load("/dummy/.flywheel/config.yaml")).rejects.toThrow(
			/skills\.proofshot\.artifact_path_allowlist must be an array of strings/,
		);
	});

	it("rejects vision_token_budget <= 0", async () => {
		const bad = `${BASE_CONFIG}
skills:
  proofshot:
    vision_token_budget: 0
`;
		const loader = new ConfigLoader(makeReadFile(bad));
		await expect(loader.load("/dummy/.flywheel/config.yaml")).rejects.toThrow(
			/skills\.proofshot\.vision_token_budget must be a positive number/,
		);
	});

	it("rejects skills as array", async () => {
		const bad = `${BASE_CONFIG}
skills:
  - foo
  - bar
`;
		const loader = new ConfigLoader(makeReadFile(bad));
		await expect(loader.load("/dummy/.flywheel/config.yaml")).rejects.toThrow(
			/skills must be a YAML mapping/,
		);
	});

	it("exports DEFAULT_PROOFSHOT_CONFIG with safe defaults (enabled=false)", () => {
		expect(DEFAULT_PROOFSHOT_CONFIG.enabled).toBe(false);
		expect(DEFAULT_PROOFSHOT_CONFIG.capture_stages).toEqual(
			DEFAULT_PROOFSHOT_CAPTURE_STAGES,
		);
		expect(DEFAULT_PROOFSHOT_CONFIG.vision_default).toBe(true);
		expect(DEFAULT_PROOFSHOT_CONFIG.vision_token_budget).toBe(
			DEFAULT_PROOFSHOT_VISION_TOKEN_BUDGET,
		);
		expect(DEFAULT_PROOFSHOT_CONFIG.model_capture_angles).toEqual(
			DEFAULT_PROOFSHOT_CAPTURE_ANGLES,
		);
		expect(DEFAULT_PROOFSHOT_CONFIG.artifact_path_allowlist).toEqual(
			DEFAULT_PROOFSHOT_PATH_ALLOWLIST,
		);
	});
});
