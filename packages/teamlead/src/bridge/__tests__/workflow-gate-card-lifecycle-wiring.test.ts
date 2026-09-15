import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

describe("workflow gate card lifecycle wiring", () => {
	it("FLY-2561 wires all gate refresh callbacks after startup buffering is initialized", () => {
		const source = readFileSync(
			fileURLToPath(new URL("../plugin.ts", import.meta.url)),
			"utf8",
		);
		const projector = source.indexOf(
			"const workflowSourceProjector = startWorkflowSourceProjector({",
		);
		for (const declaration of [
			"const issueDisplayRefreshHolder:",
			"const pendingIssueDisplayRefreshes =",
			"const enqueueIssueDisplayRefresh =",
		]) {
			expect(source.indexOf(declaration)).toBeGreaterThan(-1);
			expect(source.indexOf(declaration)).toBeLessThan(projector);
		}
		const parsed = ts.createSourceFile(
			"plugin.ts",
			source,
			ts.ScriptTarget.Latest,
			true,
		);
		const calls = new Map<string, ts.CallExpression>();
		let enqueue: ts.VariableDeclaration | undefined;
		const visit = (node: ts.Node): void => {
			if (
				ts.isCallExpression(node) &&
				[
					"startWorkflowSourceProjector",
					"materializeWorkflowGateHolder",
					"voidSupersededWorkflowGateCards",
				].includes(node.expression.getText(parsed))
			)
				calls.set(node.expression.getText(parsed), node);
			if (
				ts.isVariableDeclaration(node) &&
				node.name.getText(parsed) === "enqueueIssueDisplayRefresh"
			)
				enqueue = node;
			ts.forEachChild(node, visit);
		};
		visit(parsed);
		expect(calls.size).toBe(3);
		for (const call of calls.values()) {
			const deps = call.arguments[0];
			expect(deps && ts.isObjectLiteralExpression(deps)).toBe(true);
			if (!deps || !ts.isObjectLiteralExpression(deps))
				throw new Error("missing deps");
			const hook = deps.properties.find(
				(property) =>
					property.name?.getText(parsed) === "onIssueDisplayRefresh",
			);
			expect(
				hook && ts.isPropertyAssignment(hook)
					? hook.initializer.getText(parsed)
					: undefined,
			).toBe("enqueueIssueDisplayRefresh");
		}
		expect(enqueue?.initializer?.getText(parsed)).toContain(
			"config.chatThreadsEnabled",
		);
		expect(enqueue?.initializer?.getText(parsed)).not.toContain(
			"chatThreadCreator",
		);
		expect(source).toContain("pendingIssueDisplayRefreshes.add(issueId)");
		expect(source).toContain(
			"for (const issueId of pendingIssueDisplayRefreshes)",
		);
	});

	it("closes sessionless gates, recovers, materializes, voids old cards, then watches", () => {
		const source = readFileSync(
			fileURLToPath(new URL("../plugin.ts", import.meta.url)),
			"utf8",
		);
		const tickStart = source.indexOf(
			"const workflowGateMaterializeTick = async",
		);
		const tickEnd = source.indexOf("let landOperationSweepRunning", tickStart);
		const tick = source.slice(tickStart, tickEnd);
		const materializationListIndex = tick.indexOf(
			".listWorkflowGateHoldersForMaterialization",
		);
		const reconcileIndex = tick.indexOf(
			"await reconcileSessionlessWorkflowGates",
		);
		const recoveryIndex = tick.indexOf(
			"await reconcileUnanswerableWorkflowGates",
		);
		const voidIndex = tick.indexOf("await voidSupersededWorkflowGateCards");
		expect(source).toContain("reconcileSessionlessWorkflowGates");
		expect(source).toContain("reconcileUnanswerableWorkflowGates");
		expect(source).toContain("voidSupersededWorkflowGateCards,");
		expect(source).toContain("watchVoidedWorkflowGateCards,");
		expect(reconcileIndex).toBeGreaterThan(-1);
		expect(recoveryIndex).toBeGreaterThan(reconcileIndex);
		expect(materializationListIndex).toBeGreaterThan(recoveryIndex);
		expect(voidIndex).toBeGreaterThan(materializationListIndex);
		expect(tick.indexOf("await watchVoidedWorkflowGateCards")).toBeGreaterThan(
			voidIndex,
		);
	});
});
