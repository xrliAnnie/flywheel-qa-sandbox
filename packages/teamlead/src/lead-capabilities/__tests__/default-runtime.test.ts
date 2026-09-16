import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { CodexLeadRuntimeConfig } from "../../lead-backends/codex/codex-lead-runtime.js";
import { SqliteJournalStore } from "../../lead-backends/codex/SqliteJournalStore.js";
import { startDefaultLeadCapabilityParent } from "../default-runtime.js";
import type { LeadRuntimeParentOptions } from "../runtime-factory.js";

const state = vi.hoisted(() => ({
	project: "",
	options: undefined as LeadRuntimeParentOptions | undefined,
	fail: false,
	tick: 0,
	nativeClosed: false,
	nativeCloseFailure: false,
	head: "a".repeat(40),
}));
vi.mock("node:child_process", async (original) => ({
	...(await original<object>()),
	execFileSync: () => "codex-cli 0.153.2\n",
}));
vi.mock("../deployment.js", () => ({
	verifyLeadDeployment: () => ({
		schemaVersion: 1,
		checkoutRoot: "fixture",
		headSha: state.head,
		entrySha256: { a: "b" },
		observedAt: String(++state.tick),
	}),
}));
vi.mock("../runtime-context.js", () => ({
	createLeadCapabilityContext: () => ({
		projectRoot: state.project,
		assertActivationCurrent: () => ({
			identity: { identityDigest: "d".repeat(64), hasSummaryDuty: false },
		}),
	}),
}));
vi.mock("../native-home.js", () => ({
	preparePinnedNativeSkillHome: () => ({
		assertCurrent: () => {},
		close: () => {
			state.nativeClosed = true;
			if (state.nativeCloseFailure) throw new Error("cleanup_failed");
		},
	}),
}));
vi.mock("../../workflow-menu.js", () => ({
	resolveLeadMenus: () => [{ shape: "implement" }],
}));
vi.mock("../skill-discovery.js", () => ({
	discoverLeadRuleSources: () => ({
		sourceDigest: "source",
		records: [],
		skillInventory: [],
	}),
}));
vi.mock("../runtime-factory.js", () => ({
	startLeadRuntimeParent: async (options: LeadRuntimeParentOptions) => {
		state.options = options;
		await options.assertPreparedCurrent();
		if (state.fail) throw new Error("provider_failed");
		return {
			close: async () => {},
			assertCurrent: options.assertPreparedCurrent,
		};
	},
}));
afterEach(() => {
	vi.unstubAllEnvs();
	state.options = undefined;
	state.fail = false;
	state.tick = 0;
	state.nativeClosed = false;
	state.nativeCloseFailure = false;
	state.head = "a".repeat(40);
});
it.each([false, true])(
	"owns default preparation and cleans directories (provider failure %s)",
	async (fail) => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "default-lead-")));
		state.project = join(root, "project");
		mkdirSync(state.project);
		const home = join(root, "codex");
		mkdirSync(home);
		vi.stubEnv("HOME", root);
		vi.stubEnv("LINEAR_API_KEY", "fixture-token");
		state.fail = fail;
		const journal = new SqliteJournalStore(":memory:");
		const config = {
			capabilityBundleVersion: 2,
			fullAccessProjectRoot: state.project,
			projectName: "p",
			leadId: "l",
			identityDigest: "d".repeat(64),
			bridgeUrl: "http://127.0.0.1:9999",
			apiToken: "api",
			botToken: "bot",
			codexBin: process.execPath,
			codexHome: home,
		} as CodexLeadRuntimeConfig;
		try {
			if (fail)
				await expect(
					startDefaultLeadCapabilityParent({
						config,
						journal,
						carrierInstanceId: "claim",
					}),
				).rejects.toThrow("provider_failed");
			else {
				const parent = await startDefaultLeadCapabilityParent({
					config,
					journal,
					carrierInstanceId: "claim",
				});
				expect(state.options!.browser.egress()).toEqual({
					protectedPorts: [],
					localQaTargets: [],
				});
				await parent.assertCurrent();
				state.head = "b".repeat(40);
				await expect(parent.assertCurrent()).rejects.toThrow(
					"preparation_changed",
				);
				state.nativeCloseFailure = true;
				await expect(parent.close()).rejects.toThrow(
					"default_capability_cleanup_failed",
				);
			}
			expect(state.nativeClosed).toBe(true);
			for (const path of [
				state.options!.parent.activationRoot,
				state.options!.parent.artifactRoot,
				state.options!.parent.modelTempRoot,
			])
				expect(existsSync(path)).toBe(false);
		} finally {
			journal.close();
			rmSync(root, { recursive: true, force: true });
		}
	},
);
