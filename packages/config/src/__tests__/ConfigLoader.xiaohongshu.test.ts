/**
 * FLY-222: xiaohongshu_learning config parsing + static-shape validation tests.
 *
 * ConfigLoader does SHAPE validation only. The routing-tuple cross-check (Lead
 * exists + canSpawnRunners, label routes uniquely to lead_id, Linear resolves)
 * is a runtime scheduler concern and is NOT exercised here.
 */

import { describe, expect, it, vi } from "vitest";
import { ConfigLoader } from "../ConfigLoader.js";

const BASE_CONFIG = `
project: sub
linear:
  team_id: "TEAM-123"
runners:
  default: claude
  available:
    claude:
      type: claude
teams:
  - name: content
    orchestrators:
      - type: code
        runner: claude
        budget_per_issue: 5.0
decision_layer:
  autonomy_level: manual_only
  escalation_channel: "#flywheel-dev"
`;

const VALID_COLLECTION = `
    - collection_id: "69c8a73e00000000160351e1"
      label: "AI-视频"
      lead_id: "sub-lead"
      department_label: "Sub"
      target_linear_project: "Sub"
      cadence: weekly
      max_fetch: 13`;

function withXhs(body: string): string {
	return `${BASE_CONFIG}
xiaohongshu_learning:
${body}`;
}

function makeReadFile(yaml: string) {
	return vi.fn(async (_path: string) => yaml);
}

function load(yaml: string) {
	const loader = new ConfigLoader(makeReadFile(yaml));
	return loader.load("/fake/config.yaml");
}

describe("ConfigLoader — xiaohongshu_learning (FLY-222)", () => {
	it("loads a fully-specified valid config", async () => {
		const cfg = await load(
			withXhs(`  enabled: true
  video_opt_in: true
  collections:${VALID_COLLECTION}`),
		);
		const xhs = cfg.xiaohongshu_learning;
		expect(xhs?.enabled).toBe(true);
		expect(xhs?.video_opt_in).toBe(true);
		expect(xhs?.collections).toHaveLength(1);
		const col = xhs?.collections?.[0];
		expect(col?.collection_id).toBe("69c8a73e00000000160351e1");
		expect(col?.lead_id).toBe("sub-lead");
		expect(col?.department_label).toBe("Sub");
		expect(col?.target_linear_project).toBe("Sub");
		expect(col?.cadence).toBe("weekly");
		expect(col?.max_fetch).toBe(13);
	});

	it("loads the FLY-286 per-collection review fields", async () => {
		const cfg = await load(
			withXhs(`  enabled: true
  collections:
    - collection_id: "6884765b0000000023036a58"
      label: "claude"
      lead_id: "flywheel-eng-lead"
      department_label: "Flywheel"
      target_linear_project: "Flywheel"
      cadence: weekly
      review_channel: web-local
      first_run_cap: 15
      first_run_analyze_limit: 200
      auto_create: true`),
		);
		const col = cfg.xiaohongshu_learning?.collections?.[0];
		expect(col?.review_channel).toBe("web-local");
		expect(col?.first_run_cap).toBe(15);
		expect(col?.first_run_analyze_limit).toBe(200);
		expect(col?.auto_create).toBe(true);
	});

	it("allows the FLY-286 review fields to be omitted (runtime defaults applied later)", async () => {
		const cfg = await load(
			withXhs(`  enabled: true
  collections:${VALID_COLLECTION}`),
		);
		const col = cfg.xiaohongshu_learning?.collections?.[0];
		expect(col?.review_channel).toBeUndefined();
		expect(col?.first_run_cap).toBeUndefined();
		expect(col?.first_run_analyze_limit).toBeUndefined();
		expect(col?.auto_create).toBeUndefined();
	});

	it("is absent-safe — config with no xiaohongshu_learning key loads (byte-compat)", async () => {
		const cfg = await load(BASE_CONFIG);
		expect(cfg.xiaohongshu_learning).toBeUndefined();
	});

	it("allows a disabled block with no collections (off = byte-compat)", async () => {
		const cfg = await load(withXhs(`  enabled: false`));
		expect(cfg.xiaohongshu_learning?.enabled).toBe(false);
	});

	it("allows cadence + max_fetch to be omitted (runtime defaults applied later)", async () => {
		const cfg = await load(
			withXhs(`  enabled: true
  collections:
    - collection_id: "abc"
      label: "x"
      lead_id: "sub-lead"
      department_label: "Sub"
      target_linear_project: "Sub"`),
		);
		const col = cfg.xiaohongshu_learning?.collections?.[0];
		expect(col?.cadence).toBeUndefined();
		expect(col?.max_fetch).toBeUndefined();
	});

	describe("rejections (static shape)", () => {
		it("rejects a scalar xiaohongshu_learning", async () => {
			await expect(
				load(`${BASE_CONFIG}\nxiaohongshu_learning: "nope"`),
			).rejects.toThrow(/must be a YAML mapping/);
		});

		it("rejects a non-boolean enabled", async () => {
			await expect(load(withXhs(`  enabled: "yes"`))).rejects.toThrow(
				/enabled must be a boolean/,
			);
		});

		it("rejects a non-boolean video_opt_in", async () => {
			await expect(
				load(withXhs(`  enabled: false\n  video_opt_in: "yes"`)),
			).rejects.toThrow(/video_opt_in must be a boolean/);
		});

		it("rejects collections that is not an array", async () => {
			await expect(
				load(withXhs(`  enabled: false\n  collections: "x"`)),
			).rejects.toThrow(/collections must be an array/);
		});

		it("rejects enabled:true with empty collections", async () => {
			await expect(
				load(withXhs(`  enabled: true\n  collections: []`)),
			).rejects.toThrow(
				/non-empty array when xiaohongshu_learning.enabled is true/,
			);
		});

		it.each([
			"collection_id",
			"label",
			"lead_id",
			"department_label",
			"target_linear_project",
		])("rejects a collection missing %s", async (field) => {
			const lines = [
				`      collection_id: "abc"`,
				`      label: "x"`,
				`      lead_id: "sub-lead"`,
				`      department_label: "Sub"`,
				`      target_linear_project: "Sub"`,
			].filter((l) => !l.includes(`${field}:`));
			await expect(
				load(
					withXhs(
						`  enabled: true\n  collections:\n    -\n${lines.join("\n")}`,
					),
				),
			).rejects.toThrow(new RegExp(`${field} must be a non-empty string`));
		});

		it("rejects an empty-string required field (even when present)", async () => {
			await expect(
				load(
					withXhs(`  enabled: true
  collections:
    - collection_id: ""
      label: "x"
      lead_id: "sub-lead"
      department_label: "Sub"
      target_linear_project: "Sub"`),
				),
			).rejects.toThrow(/collection_id must be a non-empty string/);
		});

		it("rejects a collection_id that violates the state-segment charset (codex MEDIUM)", async () => {
			await expect(
				load(
					withXhs(`  enabled: true
  collections:
    - collection_id: "bad/id"
      label: "x"
      lead_id: "sub-lead"
      department_label: "Sub"
      target_linear_project: "Sub"`),
				),
			).rejects.toThrow(/collection_id "bad\/id" must match/);
		});

		it("rejects an unknown cadence", async () => {
			await expect(
				load(
					withXhs(`  enabled: true
  collections:
    - collection_id: "abc"
      label: "x"
      lead_id: "sub-lead"
      department_label: "Sub"
      target_linear_project: "Sub"
      cadence: hourly`),
				),
			).rejects.toThrow(/cadence must be one of/);
		});

		it.each([0, 201, -5, 3.5])(
			"rejects max_fetch out of range / non-integer: %s",
			async (badFetch) => {
				await expect(
					load(
						withXhs(`  enabled: true
  collections:
    - collection_id: "abc"
      label: "x"
      lead_id: "sub-lead"
      department_label: "Sub"
      target_linear_project: "Sub"
      max_fetch: ${badFetch}`),
					),
				).rejects.toThrow(/max_fetch must be an integer between 1 and 200/);
			},
		);

		it("rejects duplicate collection_id within a project", async () => {
			await expect(
				load(
					withXhs(`  enabled: true
  collections:
    - collection_id: "dup"
      label: "a"
      lead_id: "sub-lead"
      department_label: "Sub"
      target_linear_project: "Sub"
    - collection_id: "dup"
      label: "b"
      lead_id: "sub-lead"
      department_label: "Sub"
      target_linear_project: "Sub"`),
				),
			).rejects.toThrow(/collection_id "dup" is duplicated/);
		});

		it("rejects an unknown review_channel (FLY-286)", async () => {
			await expect(
				load(
					withXhs(`  enabled: true
  collections:
    - collection_id: "abc"
      label: "x"
      lead_id: "sub-lead"
      department_label: "Sub"
      target_linear_project: "Sub"
      review_channel: web-public`),
				),
			).rejects.toThrow(/review_channel must be one of/);
		});

		it.each([-1, 201, 2.5])(
			"rejects first_run_cap out of range / non-integer: %s (FLY-286)",
			async (bad) => {
				await expect(
					load(
						withXhs(`  enabled: true
  collections:
    - collection_id: "abc"
      label: "x"
      lead_id: "sub-lead"
      department_label: "Sub"
      target_linear_project: "Sub"
      first_run_cap: ${bad}`),
					),
				).rejects.toThrow(/first_run_cap must be an integer between 0 and 200/);
			},
		);

		it.each([0, 201, 2.5])(
			"rejects first_run_analyze_limit out of range / non-integer: %s (FLY-286)",
			async (bad) => {
				await expect(
					load(
						withXhs(`  enabled: true
  collections:
    - collection_id: "abc"
      label: "x"
      lead_id: "sub-lead"
      department_label: "Sub"
      target_linear_project: "Sub"
      first_run_analyze_limit: ${bad}`),
					),
				).rejects.toThrow(
					/first_run_analyze_limit must be an integer between 1 and 200/,
				);
			},
		);

		it("rejects a non-boolean auto_create (FLY-286)", async () => {
			await expect(
				load(
					withXhs(`  enabled: true
  collections:
    - collection_id: "abc"
      label: "x"
      lead_id: "sub-lead"
      department_label: "Sub"
      target_linear_project: "Sub"
      auto_create: "yes"`),
				),
			).rejects.toThrow(/auto_create must be a boolean/);
		});

		it("validates collection shape even when enabled is false (loud-fail)", async () => {
			await expect(
				load(
					withXhs(`  enabled: false
  collections:
    - collection_id: "abc"
      label: "x"
      lead_id: "sub-lead"
      department_label: "Sub"
      target_linear_project: "Sub"
      max_fetch: 999`),
				),
			).rejects.toThrow(/max_fetch must be an integer between 1 and 200/);
		});
	});
});

// FLY-709 P4.4: optional per-collection runner model (validated against the
// FLY-728 dispatch whitelist — a typo must fail at the config boundary, never
// silently spawn the account-default model every day).
describe("ConfigLoader — collections[].model (FLY-709)", () => {
	it("accepts a bare alias and keeps it verbatim", async () => {
		const cfg = await load(
			withXhs(`  enabled: true
  collections:
${VALID_COLLECTION}
      model: sonnet`),
		);
		expect(cfg.xiaohongshu_learning?.collections?.[0]?.model).toBe("sonnet");
	});

	it("accepts a canonical tier id", async () => {
		const cfg = await load(
			withXhs(`  enabled: true
  collections:
${VALID_COLLECTION}
      model: "claude-haiku-4-5-20251001"`),
		);
		expect(cfg.xiaohongshu_learning?.collections?.[0]?.model).toBe(
			"claude-haiku-4-5-20251001",
		);
	});

	it("rejects a model outside the dispatch whitelist", async () => {
		await expect(
			load(
				withXhs(`  enabled: true
  collections:
${VALID_COLLECTION}
      model: gpt-5`),
			),
		).rejects.toThrow(/model must be a recognized model tier/);
	});

	it("rejects a non-string model", async () => {
		await expect(
			load(
				withXhs(`  enabled: true
  collections:
${VALID_COLLECTION}
      model: 5`),
			),
		).rejects.toThrow(/model must be a recognized model tier/);
	});

	it("absent model stays undefined (byte-compat)", async () => {
		const cfg = await load(
			withXhs(`  enabled: true
  collections:
${VALID_COLLECTION}`),
		);
		expect(cfg.xiaohongshu_learning?.collections?.[0]?.model).toBeUndefined();
	});
});
