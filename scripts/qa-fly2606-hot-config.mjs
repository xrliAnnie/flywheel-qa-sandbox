#!/usr/bin/env node
// Isolated local acceptance. Never opens an existing Bridge database or production registry.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	mkdtempSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(import.meta.url);
const root = dirname(dirname(script));
const requireTeamlead = createRequire(
	new URL("../packages/teamlead/package.json", import.meta.url),
);
const sha = (value) => createHash("sha256").update(value).digest("hex");
const head = () =>
	execFileSync("git", ["rev-parse", "HEAD"], {
		cwd: root,
		encoding: "utf8",
	}).trim();

async function worker(mode, dir) {
	assert.match(
		realpathSync(dir),
		/^\/(?:private\/)?tmp\/fly2606-acceptance-[A-Za-z0-9]+$/,
	);
	const modelConfigPath = join(dir, "models.json");
	process.env.FLYWHEEL_MODELS_CONFIG = modelConfigPath;
	const express = requireTeamlead("express");
	const { StateStore } = await import(
		"../packages/teamlead/dist/StateStore.js"
	);
	const { loadWorkflowMenuSeeds } = await import(
		"../packages/teamlead/dist/workflow-menu.js"
	);
	const { WorkflowTemplatePublicationService } = await import(
		"../packages/teamlead/dist/workflow-template-publication.js"
	);
	const { ConfirmTokenStore } = await import(
		"../packages/teamlead/dist/bridge/fleet-admin.js"
	);
	const { createWorkflowTemplateAliasRouter, createWorkflowTemplateRouter } =
		await import(
			"../packages/teamlead/dist/bridge/workflow-template-routes.js"
		);
	const { getModelConfigSnapshot } = await import(
		"../packages/config/dist/index.js"
	);
	const { runWorkflowTemplate } = await import(
		"../packages/flywheel-comm/dist/commands/workflow-template.js"
	);
	const store = await StateStore.create(join(dir, "teamlead.db"));
	const id = "tpl_simple_code";
	let server;
	try {
		const seed = loadWorkflowMenuSeeds().find((s) => s.templateId === id);
		assert.ok(seed);
		store.importWorkflowTemplateSeed(seed);
		const service = new WorkflowTemplatePublicationService({
			store,
			tokens: new ConfirmTokenStore(),
			modelSnapshot: getModelConfigSnapshot,
			runtimeBuildSha: head(),
			assertMigrationReady: () => {},
		});
		const app = express();
		app.use("/api/workflow", createWorkflowTemplateRouter(store, service));
		app.use(
			"/api/workflow-templates",
			createWorkflowTemplateAliasRouter(store),
		);
		server = await new Promise((resolve) => {
			const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
		});
		const address = server.address();
		assert.ok(address && typeof address === "object");
		const bridgeUrl = `http://127.0.0.1:${address.port}`;
		const get = async (path) => {
			const response = await fetch(`${bridgeUrl}${path}`);
			const body = await response.text();
			assert.equal(response.status, 200, body);
			return JSON.parse(body);
		};
		const runCli = async (args) => {
			const lines = [];
			const errors = [];
			const exitCode = await runWorkflowTemplate(args, {
				env: { FLYWHEEL_BRIDGE_URL: bridgeUrl },
				log: (line) => lines.push(line),
				error: (line) => errors.push(line),
			});
			assert.equal(exitCode, 0, errors.join("\n"));
			assert.deepEqual(errors, []);
			return lines.map((line) => JSON.parse(line));
		};
		const materialize = (name) =>
			store.materializeWorkflowRun({
				runId: name,
				canonicalRoot: root,
				issueId: name,
				projectName: "flywheel",
				taskCategory: "simple_code",
				claimsReadEnrolled: false,
				actor: "isolated-qa",
			});
		if (mode === "publish") {
			store.bindWorkflowCategory({
				project: "flywheel",
				taskCategory: "simple_code",
				templateId: id,
				updatedBy: "isolated-qa",
			});
			const original = store.getWorkflowTemplateRevision(id, 1);
			const old = materialize("old-run");
			const manifest = JSON.parse(original.manifest);
			const node = manifest.nodes.find((n) => n.id === "implement");
			node.effort = node.effort === "low" ? "high" : "low";
			const candidatePath = join(dir, "template-candidate.json");
			writeFileSync(candidatePath, JSON.stringify(manifest));
			const publication = await runCli([
				"publish",
				"--template",
				id,
				"--from",
				"file",
				"--file",
				candidatePath,
				"--reason",
				"isolated acceptance publish",
			]);
			assert.equal(publication.length, 2);
			const receipt = publication[1];
			assert.equal(receipt.published_revision, 2);
			const replay = await runCli([
				"status",
				"--operation-id",
				receipt.operation_id,
			]);
			assert.deepEqual(replay, [receipt]);
			const current = await get(`/api/workflow/templates/${id}`);
			const alias = await get(`/api/workflow-templates/${id}`);
			assert.equal(current.current_revision.revision, 2);
			assert.deepEqual(alias, current);
			const fresh = materialize("new-run");
			assert.equal(store.getWorkflowRun("old-run").snapshot, old.snapshot);
			assert.equal(JSON.parse(fresh.snapshot).template.revision, 2);
			assert.equal(
				JSON.parse(fresh.snapshot).manifest.nodes.find(
					(n) => n.id === "implement",
				).effort,
				node.effort,
			);
			writeFileSync(
				join(dir, "published.json"),
				JSON.stringify(
					{
						originalDigest: original.manifest_digest,
						oldSnapshot: old.snapshot,
						newSnapshot: fresh.snapshot,
						receipt,
					},
					null,
					2,
				),
			);
			return {
				phase: mode,
				pid: process.pid,
				revision: 2,
				oldSnapshotSha: sha(old.snapshot),
				newSnapshotSha: sha(fresh.snapshot),
				receipt,
			};
		}
		const saved = JSON.parse(readFileSync(join(dir, "published.json"), "utf8"));
		assert.equal(
			store.getWorkflowTemplate(id).current_published_revision,
			mode === "rollback" ? 2 : 3,
		);
		assert.equal(store.getWorkflowTemplate(id).seed_owner, "founder");
		assert.equal(store.getWorkflowRun("old-run").snapshot, saved.oldSnapshot);
		assert.equal(store.getWorkflowRun("new-run").snapshot, saved.newSnapshot);
		assert.deepEqual(
			store.getWorkflowTemplatePublishReceipt(saved.receipt.operation_id),
			saved.receipt,
		);
		if (mode === "rollback") {
			const rollback = await runCli([
				"rollback",
				"--template",
				id,
				"--revision",
				"1",
				"--reason",
				"isolated acceptance rollback",
			]);
			assert.equal(rollback.length, 2);
			const receipt = rollback[1];
			assert.equal(receipt.published_revision, 3);
			assert.equal(receipt.after_digest, saved.originalDigest);
			assert.equal(
				(await get(`/api/workflow-templates/${id}`)).current_revision.revision,
				3,
			);
			assert.equal(
				JSON.parse(materialize("rollback-run").snapshot).template.revision,
				3,
			);
			writeFileSync(
				join(dir, "rollback.json"),
				JSON.stringify(receipt, null, 2),
			);
			return { phase: mode, pid: process.pid, receipt };
		}
		assert.equal(
			store.getWorkflowTemplateRevision(id, 3).manifest_digest,
			saved.originalDigest,
		);
		const rollback = JSON.parse(
			readFileSync(join(dir, "rollback.json"), "utf8"),
		);
		assert.deepEqual(
			store.getWorkflowTemplatePublishReceipt(rollback.operation_id),
			rollback,
		);
		assert.equal(
			(await get(`/api/workflow/templates/${id}`)).current_revision.revision,
			3,
		);
		return {
			phase: mode,
			pid: process.pid,
			revision: 3,
			manualPublicationPreserved: true,
			auditRows: store.listWorkflowTemplateAudit(id).length,
		};
	} finally {
		if (server)
			await new Promise((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
		store.close();
	}
}

if (process.argv[2] === "--worker") {
	const [mode, dir] = process.argv.slice(3);
	assert.ok(["publish", "rollback", "reopen"].includes(mode));
	console.log(JSON.stringify(await worker(mode, dir)));
} else {
	assert.equal(
		process.argv.length,
		2,
		"usage: node scripts/qa-fly2606-hot-config.mjs",
	);
	const dir = mkdtempSync("/tmp/fly2606-acceptance-");
	writeFileSync(join(dir, "models.json"), JSON.stringify({ version: 1 }));
	const evidence = {
		head: head(),
		artifact:
			"isolated flywheel-comm + loopback routes + StateStore across child-process restarts",
		dir,
		modelRegistry: join(dir, "models.json"),
		startedAt: new Date().toISOString(),
		native: "UNVERIFIED - Lead owns isolated host execution",
		visual: "UNVERIFIED",
		steps: [],
	};
	try {
		for (const mode of ["publish", "rollback", "reopen"]) {
			const output = execFileSync(
				process.execPath,
				[script, "--worker", mode, dir],
				{
					cwd: root,
					encoding: "utf8",
					timeout: 120000,
					maxBuffer: 4 * 1024 * 1024,
				},
			);
			evidence.steps.push(JSON.parse(output.trim().split("\n").at(-1)));
		}
		assert.equal(new Set(evidence.steps.map((s) => s.pid)).size, 3);
		assert.equal(head(), evidence.head, "HEAD changed during acceptance");
		evidence.templateServicePassed = true;
	} catch (error) {
		evidence.templateServicePassed = false;
		evidence.error = error.message;
		process.exitCode = 1;
	}
	evidence.finishedAt = new Date().toISOString();
	writeFileSync(join(dir, "evidence.json"), JSON.stringify(evidence, null, 2));
	console.log(JSON.stringify(evidence, null, 2));
}
