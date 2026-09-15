import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import { writeContentRef } from "flywheel-comm/utils";
import { afterEach, expect, it, vi } from "vitest";
import { generateBootstrap as generateCurrentBootstrap } from "../bridge/bootstrap-generator.js";
import { defaultGetCommDbPath } from "../bridge/session-capture.js";
import { StateStore } from "../StateStore.js";
import { generateBootstrap } from "./fixtures/fly2567/bootstrap-generator-legacy.js";

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

it("historical recovery preserves completed asks and refs while excluding closed obligations", async () => {
	const root = mkdtempSync(join(tmpdir(), "fly2567-generator-negative-"));
	vi.stubEnv("FLYWHEEL_COMM_DIR", root);
	const store = await StateStore.create(":memory:");
	const projects = [
		{
			projectName: "fixture",
			projectRoot: root,
			leads: [
				{ agentId: "fixture-lead", match: { labels: ["Product"] } },
				{ agentId: "ops-lead", match: { labels: ["Ops"] } },
			],
		},
	];
	try {
		for (const [id, status, label] of [
			["active", "running", "Product"],
			["finished", "completed", "Product"],
			["ops", "running", "Ops"],
		])
			store.upsertSession({
				execution_id: id!,
				issue_id: id!,
				project_name: "fixture",
				status: status!,
				issue_labels: JSON.stringify([label]),
			});
		const ref = writeContentRef(
			defaultGetCommDbPath("fixture"),
			"ref-ask",
			"full referenced obligation 🧭",
		);
		const db = new CommDB(defaultGetCommDbPath("fixture"));
		try {
			db.insertQuestion("finished", "fixture-lead", "still needs action", {
				id: "completed-ask",
			});
			db.insertQuestion("finished", "fixture-lead", "stale gate", {
				id: "completed-gate",
				checkpoint: "question",
			});
			db.insertQuestion("ops", "fixture-lead", "wrong-scope gate", {
				id: "ops-gate",
				checkpoint: "question",
			});
			db.insertQuestion("ops", "fixture-lead", "explicit cross-label ask", {
				id: "cross-label-ask",
			});
			db.insertQuestion("active", "fixture-lead", "ref fallback", {
				id: "ref-ask",
				contentType: "ref",
				contentRef: ref,
			});
			db.insertQuestion("active", "fixture-lead", "answered", {
				id: "answered",
			});
			db.insertResponse("answered", "fixture-lead", "resolved");
			db.insertQuestion("active", "fixture-lead", "disposed", {
				id: "disposed",
			});
			expect(db.markQuestionTerminalDisposed("disposed")).toBe(true);
			db.insertQuestion("active", "ops-lead", "another recipient", {
				id: "other-recipient",
			});
			const stop =
				"RUNNER-STOPPED kind=runner_stopped reason=done issue=FLY-2567 exec=finished route=- detail=parked";
			db.insertQuestion("finished", "fixture-lead", stop, {
				id: `rstop-${"d".repeat(32)}`,
				kind: "report",
			});
			db.insertQuestion("finished", "fixture-lead", stop, {
				id: "rstop-near-match",
				kind: "report",
			});
		} finally {
			db.close();
		}
		const snapshot = await generateBootstrap("fixture-lead", store, projects);
		for (const project of projects)
			expect(
				store.applyScopedFlagValueChange({
					name: "lead_token_savings",
					scope: project.projectName,
					op: "set",
					rawTo: "0",
					expectedChangeSeq: 0,
					actor: "fixture-lead",
					reason: "legacy oracle comparison",
				}).ok,
			).toBe(true);
		const { tokenSavingsEnabled, ...current } = await generateCurrentBootstrap(
			"fixture-lead",
			store,
			projects,
		);
		expect(current).toEqual(snapshot);
		expect(tokenSavingsEnabled).toBe(false);
		expect(snapshot.pendingGateQuestions).toBeUndefined();
		expect(snapshot.pendingRunnerQuestions?.map((q) => q.questionId)).toEqual([
			"completed-ask",
			"cross-label-ask",
			"ref-ask",
			"rstop-near-match",
		]);
		expect(
			snapshot.pendingRunnerQuestions?.find((q) => q.questionId === "ref-ask")
				?.content,
		).toBe("full referenced obligation 🧭");
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

it("executes the unchanged historical generator against real question stores", async () => {
	const source = readFileSync(
		new URL(
			"./fixtures/fly2567/bootstrap-generator-legacy.ts",
			import.meta.url,
		),
		"utf8",
	)
		.split("\n")
		.slice(1)
		.join("\n")
		.replaceAll('"../../../bridge/', '"./')
		.replaceAll('"../../../', '"../');
	// Imports are rebased, sorted and formatted by Biome; implementation bytes stay untouched.
	const imports = source.match(/^import [\s\S]*?;\n/gm) ?? [];
	const canonical =
		imports
			.map((value) => value.replace(/\s+/g, "").replace(/,}/g, "}"))
			.sort()
			.join("\n") +
		"\n" +
		source.replace(/^import [\s\S]*?;\n/gm, "");
	expect(createHash("sha256").update(canonical).digest("hex")).toBe(
		"b7bf73160c61577670b16e6ee8ff88ae07eb596d3dbaae8992f9072f531aa344",
	);
	const root = mkdtempSync(join(tmpdir(), "fly2567-generator-oracle-"));
	vi.stubEnv("FLYWHEEL_COMM_DIR", root);
	vi.spyOn(console, "warn").mockImplementation(() => {});
	const store = await StateStore.create(":memory:");
	try {
		const projects = ["first", "second"].map((projectName) => ({
			projectName,
			projectRoot: root,
			leads: [{ agentId: "fixture-lead", match: { labels: ["Product"] } }],
		}));
		for (const project of projects) {
			const execution = `exec-${project.projectName}`;
			store.upsertSession({
				execution_id: execution,
				issue_id: execution,
				project_name: project.projectName,
				status: "running",
				issue_labels: JSON.stringify(["Product"]),
			});
			const db = new CommDB(defaultGetCommDbPath(project.projectName));
			try {
				db.insertQuestion(execution, "fixture-lead", "report with checkpoint", {
					id: `gate-${execution}`,
					kind: "report",
					checkpoint: "question",
				});
				db.insertQuestion(
					execution,
					"fixture-lead",
					"report without checkpoint",
					{
						id: `report-${execution}`,
						kind: "report",
					},
				);
				db.insertQuestion("missing-execution", "fixture-lead", "orphan", {
					id: `orphan-${execution}`,
				});
			} finally {
				db.close();
			}
		}
		const snapshot = await generateBootstrap("fixture-lead", store, projects);
		for (const project of projects)
			expect(
				store.applyScopedFlagValueChange({
					name: "lead_token_savings",
					scope: project.projectName,
					op: "set",
					rawTo: "0",
					expectedChangeSeq: 0,
					actor: "fixture-lead",
					reason: "legacy oracle comparison",
				}).ok,
			).toBe(true);
		const { tokenSavingsEnabled, ...current } = await generateCurrentBootstrap(
			"fixture-lead",
			store,
			projects,
		);
		expect(current).toEqual(snapshot);
		expect(tokenSavingsEnabled).toBe(false);
		expect(snapshot.pendingGateQuestions?.map((q) => q.questionId)).toEqual([
			"gate-exec-first",
			"gate-exec-second",
		]);
		expect(snapshot.pendingRunnerQuestions?.map((q) => q.questionId)).toEqual([
			"report-exec-first",
			"report-exec-second",
		]);
		expect(snapshot).not.toHaveProperty("pendingReports");
		for (const question of snapshot.pendingRunnerQuestions ?? []) {
			expect(question).not.toHaveProperty("kind");
			expect(question).not.toHaveProperty("readAt");
			expect(question).not.toHaveProperty("relayState");
		}
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});
