import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	assertIsolationBoundaryAtBoot,
	checkBoundaryEvidence,
	IsolationRootInvalid,
	resolveIsolationRoot,
} from "../src/isolation-boundary.js";

describe("FLY-2454 isolation boundary", () => {
	const roots: string[] = [];

	afterEach(() => {
		for (const root of roots.splice(0)) {
			rmSync(root, { recursive: true, force: true });
		}
	});

	function scratch(): string {
		const root = mkdtempSync(join(tmpdir(), "fly2454-isolation-"));
		roots.push(root);
		return root;
	}

	it("keeps production mode disabled when no isolation root is configured", () => {
		expect(resolveIsolationRoot({})).toBeNull();
	});

	it("resolves an existing absolute directory without losing its lexical spelling", () => {
		const root = scratch();
		const resolved = resolveIsolationRoot({ FLYWHEEL_ISOLATION_ROOT: root });

		expect(resolved).toEqual({
			lexical: root,
			canonical: expect.stringMatching(/fly2454-isolation-/),
		});
	});

	it.each([
		["relative", "relative/root"],
		["line break", `/tmp/fly2454-${String.fromCharCode(10)}escape`],
		["missing", join(tmpdir(), "fly2454-root-does-not-exist")],
	])("rejects a %s isolation root", (_label, root) => {
		expect(() =>
			resolveIsolationRoot({ FLYWHEEL_ISOLATION_ROOT: root }),
		).toThrow(IsolationRootInvalid);
	});

	it("rejects a symlinked isolation root", () => {
		const parent = scratch();
		const target = join(parent, "target");
		const link = join(parent, "link");
		mkdirSync(target);
		symlinkSync(target, link, "dir");

		expect(() =>
			resolveIsolationRoot({ FLYWHEEL_ISOLATION_ROOT: link }),
		).toThrow(IsolationRootInvalid);
	});

	it("treats missing evidence as safe only in production mode", () => {
		expect(checkBoundaryEvidence(null, {})).toEqual({
			ok: true,
			mode: "production",
		});

		const root = resolveIsolationRoot({
			FLYWHEEL_ISOLATION_ROOT: scratch(),
		});
		expect(checkBoundaryEvidence(root, {})).toEqual({
			ok: false,
			reason: "no_evidence",
		});
	});

	it("accepts the root itself and missing descendants whose existing parent is owned", () => {
		const lexical = scratch();
		const existingParent = join(lexical, "sockets");
		mkdirSync(existingParent);
		const root = resolveIsolationRoot({ FLYWHEEL_ISOLATION_ROOT: lexical });

		expect(
			checkBoundaryEvidence(root, {
				codexHome: lexical,
				socketPath: join(existingParent, "not-created.sock"),
			}),
		).toEqual({ ok: true, mode: "isolated" });
	});

	it("reports every evidence field that resolves outside the isolation root", () => {
		const lexical = scratch();
		const outside = scratch();
		const root = resolveIsolationRoot({ FLYWHEEL_ISOLATION_ROOT: lexical });

		expect(
			checkBoundaryEvidence(root, {
				codexHome: lexical,
				socketPath: join(outside, "daemon.sock"),
				tmuxSocketPath: join(outside, "tmux.sock"),
			}),
		).toEqual({
			ok: false,
			reason: "outside_root",
			offending: ["socketPath", "tmuxSocketPath"],
		});
	});

	it("canonicalizes /tmp aliases before comparing boundary evidence", () => {
		const lexical = mkdtempSync("/tmp/fly2454-isolation-alias-");
		roots.push(lexical);
		const root = resolveIsolationRoot({ FLYWHEEL_ISOLATION_ROOT: lexical });

		expect(root?.canonical).not.toBe("");
		expect(
			checkBoundaryEvidence(root, {
				ledgerPath: join(root?.canonical ?? lexical, "kill-ledger"),
			}),
		).toEqual({ ok: true, mode: "isolated" });
	});

	it("enforces the contract boot axis only when isolation is enabled", () => {
		const lexical = scratch();
		const contract = [
			{ name: "FLYWHEEL_STATE_DIR", boot: "mustBeUnderRoot" as const },
			{ name: "TMUX", boot: "mustBeAbsent" as const },
			{
				name: "FLYWHEEL_BRIDGE_LOG_PATH",
				boot: "mustBeUnderRootIfSet" as const,
			},
			{ name: "VERCEL_TOKEN", boot: "unchecked" as const },
		];

		expect(
			assertIsolationBoundaryAtBoot(
				{ FLYWHEEL_STATE_DIR: "/production", TMUX: "prod" },
				contract,
			),
		).toEqual({ ok: true, mode: "production" });
		expect(
			assertIsolationBoundaryAtBoot(
				{
					FLYWHEEL_ISOLATION_ROOT: lexical,
					FLYWHEEL_STATE_DIR: lexical,
					TMUX: "prod",
					FLYWHEEL_BRIDGE_LOG_PATH: join(scratch(), "bridge.log"),
					VERCEL_TOKEN: "slot-local-token",
				},
				contract,
			),
		).toEqual({
			ok: false,
			offenders: [
				{ name: "TMUX", value: "prod", kind: "must_be_absent" },
				{
					name: "FLYWHEEL_BRIDGE_LOG_PATH",
					value: expect.stringContaining("fly2454-isolation-"),
					kind: "outside_root",
				},
			],
		});
	});

	it("rejects an unset mustBeUnderRoot coordinate", () => {
		const lexical = scratch();
		expect(
			assertIsolationBoundaryAtBoot({ FLYWHEEL_ISOLATION_ROOT: lexical }, [
				{ name: "FLYWHEEL_COMM_ROOT", boot: "mustBeUnderRoot" },
			]),
		).toEqual({
			ok: false,
			offenders: [{ name: "FLYWHEEL_COMM_ROOT", value: "", kind: "unset" }],
		});
	});
});
