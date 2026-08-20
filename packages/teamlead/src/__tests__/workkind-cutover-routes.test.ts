import { readFileSync } from "node:fs";
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfirmTokenStore } from "../bridge/fleet-admin.js";
import {
	createWorkKindCutoverRouter,
	FLY1436_TARGET_BINDINGS,
	type Fly1436ActivationEvidence,
	readFly1436ActivationEvidence,
	type WorkKindCutoverCanonical,
	type WorkKindCutoverRouteDeps,
} from "../bridge/workkind-cutover.js";
import { StateStore } from "../StateStore.js";
import { importWorkflowMenuSeeds } from "../workflow-menu.js";
import { importLegacyWorkflowSeeds } from "./fixtures/legacy-workflow-manifests.js";

const servers: Server[] = [];
const stores: StateStore[] = [];
afterEach(async () => {
	await Promise.all(
		servers
			.splice(0)
			.map(
				(server) =>
					new Promise<void>((resolve) => server.close(() => resolve())),
			),
	);
	for (const store of stores.splice(0)) store.close();
});

const READY: Fly1436ActivationEvidence = {
	templateDispatch: true,
	generalizedTemplates: true,
	workKind: true,
	prBAssetsReady: true,
	deployedSha: "a".repeat(40),
	assetsDigest: "b".repeat(64),
};

async function makeDeps(
	overrides: Partial<WorkKindCutoverRouteDeps> = {},
): Promise<WorkKindCutoverRouteDeps> {
	const store = await StateStore.create(":memory:");
	stores.push(store);
	importLegacyWorkflowSeeds(store);
	importWorkflowMenuSeeds(store);
	store.bindWorkflowCategory({
		project: "flywheel",
		templateId: "tpl_eng_heavy",
		updatedBy: "system:bundled-default",
	});
	return {
		store,
		apiToken: "master-token",
		tokens: new ConfirmTokenStore(),
		readActivationEvidence: () => READY,
		newOperationId: (kind) => `fly-1436-${kind}-test`,
		...overrides,
	};
}

async function listen(deps: WorkKindCutoverRouteDeps) {
	const app = express();
	app.use(express.json());
	app.use("/api/workflow/cutovers/FLY-1436", createWorkKindCutoverRouter(deps));
	const server = createServer(app);
	servers.push(server);
	await new Promise<void>((resolve) =>
		server.listen(0, "127.0.0.1", () => resolve()),
	);
	const port = (server.address() as AddressInfo).port;
	return `http://127.0.0.1:${port}/api/workflow/cutovers/FLY-1436`;
}

async function post(
	url: string,
	path: string,
	body: unknown,
	token = "master-token",
	host?: string,
) {
	if (host) {
		return await new Promise<{
			status: number;
			json: Record<string, unknown>;
		}>((resolve, reject) => {
			const target = new URL(`${url}/${path}`);
			const payload = JSON.stringify(body);
			const request = httpRequest(
				target,
				{
					method: "POST",
					headers: {
						host,
						"content-type": "application/json",
						"content-length": Buffer.byteLength(payload),
						authorization: `Bearer ${token}`,
					},
				},
				(response) => {
					const chunks: Buffer[] = [];
					response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
					response.on("end", () =>
						resolve({
							status: response.statusCode ?? 0,
							json: JSON.parse(Buffer.concat(chunks).toString("utf8")),
						}),
					);
				},
			);
			request.on("error", reject);
			request.end(payload);
		});
	}
	const response = await fetch(`${url}/${path}`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: `Bearer ${token}`,
		},
		body: JSON.stringify(body),
	});
	return {
		status: response.status,
		json: (await response.json()) as Record<string, unknown>,
	};
}

describe("FLY-1436 work-kind cutover routes", () => {
	it("reads activation evidence only from the canonical project root and deployed assets", () => {
		const paths: string[] = [];
		const evidence = readFly1436ActivationEvidence({
			projectRoot: "/canonical/flywheel",
			env: {
				FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH: "1",
				FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES: "1",
			},
			readFile: (path) => {
				paths.push(path);
				if (path.endsWith(".flywheel/config.yaml")) {
					return "pipeline:\n  dag: true\n  work_kind: true\n";
				}
				if (path.endsWith("ic-roster.yaml")) {
					return [
						"design: .flywheel/agents/engineering/engineer-executor.md",
						"implement: .flywheel/agents/engineering/engineer-executor.md",
						"qa: .flywheel/agents/engineering/qa-executor.md",
						"pm: .flywheel/agents/engineering/pm-executor.md",
						"designer: .flywheel/agents/engineering/designer-executor.md",
						"proto: .flywheel/agents/engineering/prototype-executor.md",
						"generic: .flywheel/agents/general-executor.md",
					].join("\n");
				}
				if (path.endsWith("adoption.yaml")) {
					return [
						"flywheel-eng-lead: [generic, code]",
						"flywheel-product-lead: [prd, design, prototype]",
						"claude-infra-bot-lead: [generic]",
					].join("\n");
				}
				if (path.includes("menus/shapes/")) {
					return `shape: ${path.split("/").at(-1)?.replace(".yaml", "")}`;
				}
				if (path.endsWith("schemas.js")) {
					return 'taskCategory code simple_code prd design prototype generic required: ["issueId", "taskCategory"]';
				}
				throw new Error(`unexpected path ${path}`);
			},
			gitHead: (root) => {
				expect(root).toBe("/canonical/flywheel");
				return "a".repeat(40);
			},
		});
		expect(evidence).toMatchObject({
			templateDispatch: true,
			generalizedTemplates: true,
			workKind: true,
			prBAssetsReady: true,
			deployedSha: "a".repeat(40),
		});
		expect(evidence.assetsDigest).toMatch(/^[0-9a-f]{64}$/);
		expect(paths).toHaveLength(10);
		expect(paths.every((path) => path.startsWith("/canonical/flywheel/"))).toBe(
			true,
		);
	});

	it("rejects the obsolete wrapped menu asset shape", () => {
		const evidence = readFly1436ActivationEvidence({
			projectRoot: "/canonical/flywheel",
			env: {
				FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH: "1",
				FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES: "1",
			},
			readFile: (path) => {
				if (path.endsWith(".flywheel/config.yaml")) {
					return "pipeline:\n  dag: true\n  work_kind: true\n";
				}
				if (path.endsWith("ic-roster.yaml")) {
					return "roles:\n  pm: .flywheel/agents/engineering/pm-executor.md";
				}
				if (path.endsWith("adoption.yaml")) {
					return "leads:\n  flywheel-product-lead: [prd, design, prototype]";
				}
				if (path.includes("menus/shapes/")) {
					return `shape: ${path.split("/").at(-1)?.replace(".yaml", "")}`;
				}
				if (path.endsWith("schemas.js")) {
					return 'taskCategory code simple_code prd design prototype generic required: ["issueId", "taskCategory"]';
				}
				throw new Error(`unexpected path ${path}`);
			},
			gitHead: () => "a".repeat(40),
		});
		expect(evidence.prBAssetsReady).toBe(false);
	});

	it("fails closed on non-loopback hosts, a missing master token, and wrong bearer auth", async () => {
		const missingToken = await makeDeps({ apiToken: undefined });
		const missingUrl = await listen(missingToken);
		expect((await post(missingUrl, "stage", { kind: "activate" })).status).toBe(
			503,
		);

		const deps = await makeDeps();
		const url = await listen(deps);
		expect(
			(await post(url, "stage", { kind: "activate" }, "wrong-token")).status,
		).toBe(401);
		expect(
			(await post(url, "stage", { kind: "activate" }, "é".repeat(12))).status,
		).toBe(401);
		expect(
			(
				await post(
					url,
					"stage",
					{ kind: "activate" },
					"master-token",
					"evil.example",
				)
			).status,
		).toBe(403);
		expect(
			readFileSync(
				join(__dirname, "..", "bridge", "workkind-cutover.ts"),
				"utf8",
			),
		).toContain("timingSafeEqual");
	});

	it("stages only the server-owned flywheel target and reports every activation blocker", async () => {
		const blocked = await makeDeps({
			readActivationEvidence: () => ({
				...READY,
				templateDispatch: false,
				generalizedTemplates: false,
				workKind: false,
				prBAssetsReady: false,
			}),
		});
		const blockedUrl = await listen(blocked);
		vi.spyOn(
			blocked.store,
			"getGeneralizedWorkflowReleaseState",
		).mockReturnValue({
			activeSchema2Runs: 1,
			nonterminalSideEffects: 1,
			unrespondedReservations: 1,
			releasable: false,
			activeRunIds: ["active-v2"],
			activeSideEffectExecutionIds: ["exec-active-v2"],
			activeReservationKeys: ["start-active-v2"],
			diagnostics: { terminalSchema2RunsWithResidue: 2 },
		});
		const rejected = await post(blockedUrl, "stage", {
			kind: "activate",
			project: "attacker-project",
			bindings: [{ taskCategory: "*", templateId: "attacker-template" }],
		});
		expect(rejected.status).toBe(409);
		expect(rejected.json).toMatchObject({
			ok: false,
			blockers: [
				"TEMPLATE_DISPATCH_OFF",
				"GENERALIZED_OFF",
				"WORK_KIND_OFF",
				"PR_B_ASSETS_NOT_DEPLOYED",
				"GENERALIZED_RELEASABLE_STATE_NONZERO",
			],
			releaseState: {
				activeRunIds: ["active-v2"],
				activeSideEffectExecutionIds: ["exec-active-v2"],
				activeReservationKeys: ["start-active-v2"],
				diagnostics: { terminalSchema2RunsWithResidue: 2 },
			},
		});
		expect(rejected.json).not.toHaveProperty("confirmToken");

		const deps = await makeDeps();
		const url = await listen(deps);
		const staged = await post(url, "stage", {
			kind: "activate",
			project: "attacker-project",
			bindings: [{ taskCategory: "*", templateId: "attacker-template" }],
		});
		expect(staged.status).toBe(200);
		expect(staged.json).toMatchObject({
			ok: true,
			canonical: {
				version: 1,
				activationId: "FLY-1436",
				operationId: "fly-1436-activate-test",
				kind: "activate",
				project: "flywheel",
				actor: "system:fly-1436-cutover",
				before: [{ taskCategory: "*", templateId: "tpl_eng_heavy" }],
				after: FLY1436_TARGET_BINDINGS,
				expected: READY,
			},
			snapshot: {
				version: 1,
				activationId: "FLY-1436",
				sourceOperationId: "fly-1436-activate-test",
				project: "flywheel",
				bindings: [{ taskCategory: "*", templateId: "tpl_eng_heavy" }],
			},
		});
		expect(staged.json.confirmToken).toEqual(expect.any(String));
	});

	it("applies once, then replays the durable receipt without requiring the consumed token", async () => {
		const deps = await makeDeps();
		const url = await listen(deps);
		const staged = await post(url, "stage", { kind: "activate" });
		const canonical = staged.json.canonical as WorkKindCutoverCanonical;
		const applied = await post(url, "apply", {
			canonical,
			confirmToken: staged.json.confirmToken,
		});
		expect(applied.status).toBe(200);
		expect(applied.json).toMatchObject({
			ok: true,
			status: "committed",
			receipt: { operationId: "fly-1436-activate-test" },
		});
		expect(deps.store.listWorkflowCategoryBindings("flywheel")).toMatchObject(
			[...FLY1436_TARGET_BINDINGS]
				.sort((a, b) => a.taskCategory.localeCompare(b.taskCategory))
				.map((binding) => ({
					task_category: binding.taskCategory,
					template_id: binding.templateId,
				})),
		);
		const auditCount = deps.store.listWorkflowTemplateAudit().length;

		const replay = await post(url, "apply", { canonical });
		expect(replay.status).toBe(200);
		expect(replay.json).toMatchObject({
			ok: true,
			status: "replayed",
			receipt: { operationId: "fly-1436-activate-test" },
		});
		expect(deps.store.listWorkflowTemplateAudit()).toHaveLength(auditCount);

		const restartedUrl = await listen({
			...deps,
			tokens: new ConfirmTokenStore(),
		});
		const restartedReplay = await post(restartedUrl, "apply", { canonical });
		expect(restartedReplay.status).toBe(200);
		expect(restartedReplay.json).toMatchObject({
			status: "replayed",
			receipt: { operationId: "fly-1436-activate-test" },
		});
		const conflictingReplay = await post(restartedUrl, "apply", {
			canonical: {
				...canonical,
				expected: {
					...canonical.expected!,
					assetsDigest: "c".repeat(64),
				},
			},
		});
		expect(conflictingReplay.status).toBe(409);
	});

	it("serializes concurrent same-operation apply attempts into one mutation and one replay", async () => {
		const deps = await makeDeps();
		const url = await listen(deps);
		const auditBefore = deps.store.listWorkflowTemplateAudit().length;
		const staged = await post(url, "stage", {
			kind: "activate",
			operationId: "fly-1436-activate-race",
		});
		const body = {
			canonical: staged.json.canonical,
			confirmToken: staged.json.confirmToken,
		};
		const results = await Promise.all([
			post(url, "apply", body),
			post(url, "apply", body),
		]);
		expect(results.map((result) => result.status)).toEqual([200, 200]);
		expect(results.map((result) => result.json.status).sort()).toEqual([
			"committed",
			"replayed",
		]);
		expect(deps.store.listWorkflowTemplateAudit()).toHaveLength(
			auditBefore + FLY1436_TARGET_BINDINGS.length + 1,
		);
	});

	it("invalidates uncommitted tokens across restart and consumes hash-mismatched tokens", async () => {
		const deps = await makeDeps();
		const url = await listen(deps);
		const staged = await post(url, "stage", { kind: "activate" });
		const canonical = staged.json.canonical as WorkKindCutoverCanonical;
		const confirmToken = staged.json.confirmToken as string;

		const tampered = {
			...canonical,
			expected: {
				...canonical.expected!,
				assetsDigest: "c".repeat(64),
			},
		};
		expect(
			(
				await post(url, "apply", {
					canonical: tampered,
					confirmToken,
				})
			).status,
		).toBe(401);
		expect(
			(
				await post(url, "apply", {
					canonical,
					confirmToken,
				})
			).status,
		).toBe(401);

		const restartedUrl = await listen({
			...deps,
			tokens: new ConfirmTokenStore(),
		});
		expect(
			(
				await post(restartedUrl, "apply", {
					canonical,
					confirmToken,
				})
			).status,
		).toBe(401);

		const restartStage = await post(url, "stage", {
			kind: "activate",
			operationId: "fly-1436-activate-restart",
		});
		const restartCanonical = restartStage.json
			.canonical as WorkKindCutoverCanonical;
		expect(
			(
				await post(restartedUrl, "apply", {
					canonical: restartCanonical,
					confirmToken: restartStage.json.confirmToken,
				})
			).status,
		).toBe(401);
		const restaged = await post(restartedUrl, "stage", {
			kind: "activate",
			operationId: "fly-1436-activate-restart",
		});
		expect(
			(
				await post(restartedUrl, "apply", {
					canonical: restaged.json.canonical,
					confirmToken: restaged.json.confirmToken,
				})
			).status,
		).toBe(200);
	});

	it("restores from the activation snapshot even when activation flags and PR-B assets are down", async () => {
		const deps = await makeDeps();
		const url = await listen(deps);
		const staged = await post(url, "stage", { kind: "activate" });
		const activated = await post(url, "apply", {
			canonical: staged.json.canonical,
			confirmToken: staged.json.confirmToken,
		});
		expect(activated.status).toBe(200);

		deps.readActivationEvidence = () => ({
			...READY,
			templateDispatch: false,
			generalizedTemplates: false,
			workKind: false,
			prBAssetsReady: false,
		});
		const noTokenStage = await post(url, "stage", {
			kind: "restore",
			sourceOperationId: "fly-1436-activate-test",
			snapshot: staged.json.snapshot,
			operationId: "fly-1436-restore-no-token",
		});
		expect(
			(
				await post(url, "apply", {
					canonical: noTokenStage.json.canonical,
				})
			).status,
		).toBe(401);

		const mismatchStage = await post(url, "stage", {
			kind: "restore",
			sourceOperationId: "fly-1436-activate-test",
			snapshot: staged.json.snapshot,
			operationId: "fly-1436-restore-mismatch",
		});
		expect(
			(
				await post(url, "apply", {
					canonical: {
						...(mismatchStage.json.canonical as WorkKindCutoverCanonical),
						operationId: "fly-1436-restore-tampered",
					},
					confirmToken: mismatchStage.json.confirmToken,
				})
			).status,
		).toBe(401);

		const restoreStage = await post(url, "stage", {
			kind: "restore",
			sourceOperationId: "fly-1436-activate-test",
			snapshot: staged.json.snapshot,
			operationId: "fly-1436-restore-test",
		});
		expect(restoreStage.status).toBe(200);
		const restored = await post(url, "apply", {
			canonical: restoreStage.json.canonical,
			confirmToken: restoreStage.json.confirmToken,
		});
		expect(restored.status).toBe(200);
		expect(deps.store.listWorkflowCategoryBindings("flywheel")).toMatchObject([
			{ task_category: "*", template_id: "tpl_eng_heavy" },
		]);
	});

	it("fails restore staging closed for a missing receipt, snapshot mismatch, or target drift", async () => {
		const missing = await makeDeps();
		const missingUrl = await listen(missing);
		expect(
			(
				await post(missingUrl, "stage", {
					kind: "restore",
					sourceOperationId: "fly-1436-restore-not-an-activation",
					operationId: "fly-1436-restore-invalid-source",
					snapshot: {},
				})
			).status,
		).toBe(400);
		const missingReceipt = await post(missingUrl, "stage", {
			kind: "restore",
			sourceOperationId: "fly-1436-activate-missing",
			operationId: "fly-1436-restore-missing",
			snapshot: {
				version: 1,
				activationId: "FLY-1436",
				sourceOperationId: "fly-1436-activate-missing",
				project: "flywheel",
				bindings: [{ taskCategory: "*", templateId: "tpl_eng_heavy" }],
			},
		});
		expect(missingReceipt.status).toBe(409);
		expect(missingReceipt.json).toMatchObject({
			reason: "restore_preflight_failed",
			causes: ["ACTIVATION_RECEIPT_NOT_FOUND_OR_INVALID"],
		});

		const mismatched = await makeDeps();
		const mismatchedUrl = await listen(mismatched);
		const staged = await post(mismatchedUrl, "stage", { kind: "activate" });
		await post(mismatchedUrl, "apply", {
			canonical: staged.json.canonical,
			confirmToken: staged.json.confirmToken,
		});
		const originalSnapshot = staged.json.snapshot as {
			bindings: Array<{ taskCategory: string; templateId: string }>;
		};
		const snapshotDrift = await post(mismatchedUrl, "stage", {
			kind: "restore",
			sourceOperationId: "fly-1436-activate-test",
			operationId: "fly-1436-restore-snapshot-drift",
			snapshot: {
				...originalSnapshot,
				bindings: [{ taskCategory: "*", templateId: "tpl_eng_light" }],
			},
		});
		expect(snapshotDrift.status).toBe(409);
		expect(snapshotDrift.json).toMatchObject({
			reason: "restore_preflight_failed",
			causes: ["SNAPSHOT_HASH_MISMATCH", "SNAPSHOT_BINDINGS_MISMATCH"],
		});

		mismatched.store.bindWorkflowCategory({
			project: "flywheel",
			taskCategory: "later",
			templateId: "tpl_eng",
			updatedBy: "later-operator",
		});
		const targetDrift = await post(mismatchedUrl, "stage", {
			kind: "restore",
			sourceOperationId: "fly-1436-activate-test",
			operationId: "fly-1436-restore-target-drift",
			snapshot: staged.json.snapshot,
		});
		expect(targetDrift.status).toBe(409);
		expect(targetDrift.json).toMatchObject({
			reason: "restore_preflight_failed",
			causes: ["BINDING_TARGET_DRIFT"],
		});
	});
});
