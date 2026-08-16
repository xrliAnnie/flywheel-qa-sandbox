import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("FLY-1066 terminal CommDB sync production inventory", () => {
	it("wires one shared queue to both transition opts and every bypass", () => {
		const here = dirname(fileURLToPath(import.meta.url));
		const plugin = readFileSync(
			join(here, "..", "bridge", "plugin.ts"),
			"utf8",
		);
		const runInfra = readFileSync(
			join(here, "..", "bridge", "run-infra.ts"),
			"utf8",
		);
		const directSink = readFileSync(
			join(here, "..", "DirectEventSink.ts"),
			"utf8",
		);
		const marker = readFileSync(
			join(here, "..", "bridge", "complete-marker-reconciler.ts"),
			"utf8",
		);

		const staleStart = plugin.indexOf(
			"const staleGuardTransitionOpts: ApplyTransitionOpts",
		);
		const staleEnd = plugin.indexOf("const staleBlockerGuard", staleStart);
		expect(plugin.slice(staleStart, staleEnd)).toContain(
			"opts?.terminalCommDbSync?.enqueue",
		);

		const sharedStart = plugin.indexOf(
			"const transitionOpts: ApplyTransitionOpts",
		);
		const sharedEnd = plugin.indexOf("const fleetConfigProvider", sharedStart);
		expect(plugin.slice(sharedStart, sharedEnd)).toContain(
			"terminalCommDbSync.enqueue",
		);

		expect(runInfra).toContain(
			"directSink.terminalCommDbSync = runInfraOpts?.terminalCommDbSync",
		);
		expect(
			directSink.match(/this\.enqueueTerminalCommDbStatus\(/g),
		).toHaveLength(3);
		expect(marker).toContain(
			"args.onTerminalStatusPersisted(\n\t\t\t\targs.executionId",
		);
	});

	it("warms before use, threads marker callbacks, and drains on shutdown", () => {
		const here = dirname(fileURLToPath(import.meta.url));
		const plugin = readFileSync(
			join(here, "..", "bridge", "plugin.ts"),
			"utf8",
		);

		expect(plugin).toContain(
			"const terminalCommDbSync = createTerminalCommDbSync({",
		);
		expect(plugin).toContain("await terminalCommDbSync.warmProjects(");
		expect(
			plugin.match(
				/onTerminalStatusPersisted: onMarkerTerminalStatusPersisted/g,
			),
		).toHaveLength(2);
		const effectStart = plugin.indexOf(
			"const onMarkerTerminalStatusPersisted =",
		);
		const effectEnd = plugin.indexOf("const heartbeatService =", effectStart);
		const effect = plugin.slice(effectStart, effectEnd);
		expect(effect).toContain("terminalCommDbSync.enqueue(");
		expect(effect).toContain("store.getSession(executionId)?.issue_id");
		expect(effect).toContain("enqueueIssueDisplayRefresh(issueId)");
		expect(plugin).toContain(
			"const pendingIssueDisplayRefreshes = new Set<string>()",
		);
		expect(plugin).toContain(
			"for (const issueId of pendingIssueDisplayRefreshes)",
		);
		expect(plugin).toContain("pendingIssueDisplayRefreshes.clear()");
		expect(plugin).toContain("await terminalCommDbSync.close(1_000)");
	});
});
