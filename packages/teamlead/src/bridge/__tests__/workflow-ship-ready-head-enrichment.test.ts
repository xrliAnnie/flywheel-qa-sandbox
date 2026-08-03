import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkPrMergeViaGh } from "../external-merge-reconcile.js";
import { enrichPrHeadViaGh } from "../workflow-ship-ready-arm.js";

describe.sequential("runner-ship REST head enrichment process path", () => {
	const originalPath = process.env.PATH;
	let fixtureRoot = "";
	let binRoot = "";
	let repoRoot = "";
	let captureRoot = "";

	beforeAll(() => {
		fixtureRoot = mkdtempSync(join(tmpdir(), "fly1624-gh-process-"));
		binRoot = join(fixtureRoot, "bin");
		repoRoot = join(fixtureRoot, "repo");
		captureRoot = join(fixtureRoot, "capture");
		mkdirSync(binRoot);
		mkdirSync(repoRoot);
		mkdirSync(captureRoot);
		const ghPath = join(binRoot, "gh");
		writeFileSync(
			ghPath,
			`#!/bin/sh
printf '%s' "$PWD" > "$FLY1624_GH_CAPTURE/cwd"
printf '%s\n' "$@" > "$FLY1624_GH_CAPTURE/argv"
case "$FLY1624_GH_MODE" in
  valid) printf '{"merged_at":"2026-08-03T01:02:03Z","head":{"sha":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}}' ;;
  not_merged) printf '{"merged_at":null,"head":{"sha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}}' ;;
  invalid_head) printf '{"merged_at":"2026-08-03T01:02:03Z","head":{"sha":"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"}}' ;;
  invalid_json) printf '{broken' ;;
  graphql_valid) printf '{"state":"MERGED","mergedAt":"2026-08-03T01:02:03Z","headRefOid":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}' ;;
  graphql_invalid) printf '{"state":"MERGED","mergedAt":"2026-08-03T01:02:03Z","headRefOid":"not-a-sha"}' ;;
  nonzero) printf 'provider unavailable' >&2; exit 7 ;;
  timeout) sleep 1 ;;
esac
`,
			"utf8",
		);
		chmodSync(ghPath, 0o755);
		process.env.PATH = `${binRoot}:${originalPath ?? ""}`;
		process.env.FLY1624_GH_CAPTURE = captureRoot;
	});

	afterAll(() => {
		process.env.PATH = originalPath;
		delete process.env.FLY1624_GH_CAPTURE;
		delete process.env.FLY1624_GH_MODE;
		rmSync(fixtureRoot, { recursive: true, force: true });
	});

	it("executes gh api with explicit repo, cwd, and bounded timeout", async () => {
		process.env.FLY1624_GH_MODE = "valid";
		await expect(
			enrichPrHeadViaGh(repoRoot, "xrliAnnie/flywheel", 1624, 500),
		).resolves.toEqual({
			ok: true,
			headSha: "a".repeat(40),
			mergedAt: "2026-08-03T01:02:03Z",
		});
		expect(realpathSync(readFileSync(join(captureRoot, "cwd"), "utf8"))).toBe(
			realpathSync(repoRoot),
		);
		expect(readFileSync(join(captureRoot, "argv"), "utf8")).toBe(
			"api\nrepos/xrliAnnie/flywheel/pulls/1624\n",
		);
	});

	it("uses the cwd-repository REST endpoint when no slug is authoritative", async () => {
		process.env.FLY1624_GH_MODE = "valid";
		await enrichPrHeadViaGh(repoRoot, null, 7, 500);
		expect(readFileSync(join(captureRoot, "argv"), "utf8")).toBe(
			"api\nrepos/{owner}/{repo}/pulls/7\n",
		);
	});

	it("distinguishes not-merged, malformed JSON, and bounded invalid heads", async () => {
		process.env.FLY1624_GH_MODE = "not_merged";
		await expect(enrichPrHeadViaGh(repoRoot, null, 7, 500)).resolves.toEqual({
			ok: false,
			reason: "not_merged",
			rawHead: "b".repeat(40),
		});
		process.env.FLY1624_GH_MODE = "invalid_json";
		await expect(enrichPrHeadViaGh(repoRoot, null, 7, 500)).resolves.toEqual({
			ok: false,
			reason: "bad_json",
		});
		process.env.FLY1624_GH_MODE = "invalid_head";
		await expect(enrichPrHeadViaGh(repoRoot, null, 7, 500)).resolves.toEqual({
			ok: false,
			reason: "invalid_head",
			rawHead: "x".repeat(80),
		});
	});

	it("turns nonzero exits and timeouts into typed failures", async () => {
		process.env.FLY1624_GH_MODE = "nonzero";
		const nonzero = await enrichPrHeadViaGh(repoRoot, null, 7, 500);
		expect(nonzero).toEqual({ ok: false, reason: "nonzero" });

		process.env.FLY1624_GH_MODE = "timeout";
		const timeout = await enrichPrHeadViaGh(repoRoot, null, 7, 10);
		expect(timeout).toEqual({ ok: false, reason: "timeout" });
	});

	it("turns process spawn failures and invalid PR input into typed failures", async () => {
		const activePath = process.env.PATH;
		const emptyPath = join(fixtureRoot, "empty-bin");
		mkdirSync(emptyPath);
		process.env.PATH = emptyPath;
		try {
			await expect(enrichPrHeadViaGh(repoRoot, null, 7, 500)).resolves.toEqual({
				ok: false,
				reason: "spawn",
			});
		} finally {
			process.env.PATH = activePath;
		}
		await expect(enrichPrHeadViaGh(repoRoot, null, 0, 500)).resolves.toEqual({
			ok: false,
			reason: "invalid_pr_number",
		});
	});

	it("preserves the raw GraphQL head while only exposing a normalized valid SHA", async () => {
		process.env.FLY1624_GH_MODE = "graphql_valid";
		await expect(
			checkPrMergeViaGh(repoRoot, 1624, 500, "xrliAnnie/flywheel"),
		).resolves.toEqual({
			state: "merged",
			headRefOid: "a".repeat(40),
			rawHeadRefOid: "A".repeat(40),
		});
		expect(readFileSync(join(captureRoot, "argv"), "utf8")).toBe(
			"pr\nview\n1624\n--repo\nxrliAnnie/flywheel\n--json\nstate,mergedAt,mergeCommit,headRefOid\n",
		);

		process.env.FLY1624_GH_MODE = "graphql_invalid";
		await expect(
			checkPrMergeViaGh(repoRoot, 1624, 500, "xrliAnnie/flywheel"),
		).resolves.toEqual({
			state: "merged",
			headRefOid: undefined,
			rawHeadRefOid: "not-a-sha",
		});
	});
});
