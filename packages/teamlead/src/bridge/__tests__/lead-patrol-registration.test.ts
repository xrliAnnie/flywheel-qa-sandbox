import { createHash, randomUUID } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { SqliteOutboundDedupStore } from "../../lead-backends/codex/SqliteOutboundDedupStore.js";
import { leadOperationInputDigest } from "../../lead-capabilities/broker.js";
import { recordLeadPatrolJudgment } from "../lead-patrol-judgment.js";
import { registerLeadPatrolSnapshot } from "../lead-patrol-registration.js";
import * as helper from "../lead-patrol-snapshot.js";

it("registers actual reports in Bridge receipts and replays read-only across SQLite restart", async () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "patrol-register-")));
	const deploymentRoot = realpathSync(resolve("../.."));
	const stateDir = join(root, "state"),
		activationRoot = join(root, "activation");
	for (const path of [stateDir, activationRoot])
		mkdirSync(path, { mode: 0o700 });
	const projectsPath = join(root, "projects.json");
	writeFileSync(
		projectsPath,
		JSON.stringify([
			{
				projectName: "demo",
				projectRepo: "owner/repo",
				leads: [{ agentId: "eng" }],
			},
		]),
	);
	let store = new SqliteOutboundDedupStore(join(root, "receipts.db"));
	const run = vi.spyOn(helper, "executeLeadPatrolSnapshot");
	const options = {
		deploymentRoot,
		stateDir,
		activationRoot,
		projectsPath,
		nodePath: realpathSync(process.execPath),
		stateDbPath: join(root, "absent.db"),
		commDbPath: join(root, "demo/comm.db"),
		helperPins: Object.fromEntries(
			helper.PATROL_HELPER_SOURCES.map((name) => [
				name,
				createHash("sha256")
					.update(readFileSync(join(deploymentRoot, name)))
					.digest("hex"),
			]),
		),
		projectName: "demo",
		leadId: "eng",
		activationId: "a1",
		requestId: randomUUID(),
		tickId: "42",
		githubFacts: {
			projectName: "demo",
			leadId: "eng",
			pulls: [],
			runs: { workflow_runs: [] },
		},
		secrets: [],
		signal: new AbortController().signal,
		assertCurrent: async () => {},
		receipts: store.operationReceipts,
	};
	try {
		const first = await registerLeadPatrolSnapshot(options);
		expect(first.status).toBe("succeeded");
		expect(first.data?.text).toContain("project: demo\nlead: eng");
		store.close();
		store = new SqliteOutboundDedupStore(join(root, "receipts.db"));
		options.receipts = store.operationReceipts;
		const replay = await registerLeadPatrolSnapshot({
			...options,
			receiptOnly: true,
		});
		expect(replay).toEqual(first);
		expect(await registerLeadPatrolSnapshot(options)).toEqual(first);
		expect(
			await registerLeadPatrolSnapshot({
				...options,
				githubFacts: { changedProviderObservation: true },
			}),
		).toEqual(first);
		expect(run).toHaveBeenCalledTimes(1);
		expect(
			(await registerLeadPatrolSnapshot({ ...options, tickId: "43" }))
				.errorCode,
		).toBe("input_digest_conflict");
		expect(
			(
				await registerLeadPatrolSnapshot({
					...options,
					requestId: randomUUID(),
					receiptOnly: true,
				})
			).status,
		).toBe("unknown");
		expect(
			(
				await registerLeadPatrolSnapshot({
					...options,
					leadId: "foreign",
					receiptOnly: true,
				})
			).status,
		).toBe("unknown");
		const rules = realpathSync(
			resolve("lead-rules-base/runbooks/patrol-v1.md"),
		);
		const judgment = {
			projectName: options.projectName,
			leadId: options.leadId,
			activationId: options.activationId,
			stateDir,
			receipts: options.receipts,
			requestId: randomUUID(),
			signal: options.signal,
			secrets: [],
			assertCurrent: () => {},
			rootCauseAsk: () => undefined,
			source: {
				path: rules,
				sha256: createHash("sha256").update(readFileSync(rules)).digest("hex"),
			},
			input: {
				tickId: "42",
				executionId: "exec",
				step: 1,
				judgment: "healthy",
				evidenceHandle: first.data!.evidenceHandle,
			},
		};
		const beforeJudgment = readFileSync(first.data!.path, "utf8");
		expect(
			recordLeadPatrolJudgment({
				...judgment,
				requestId: randomUUID(),
				source: { ...judgment.source, sha256: "0".repeat(64) },
			}).status,
		).toBe("rejected");
		expect(readFileSync(first.data!.path, "utf8")).toBe(beforeJudgment);
		const judged = recordLeadPatrolJudgment(judgment);
		expect(judged.status).toBe("succeeded");
		expect(judged.data?.gates).toHaveLength(3);
		const second = recordLeadPatrolJudgment({
			...judgment,
			requestId: randomUUID(),
			input: { ...judgment.input, step: 2 },
		});
		expect(second.status).toBe("succeeded");
		const afterJudgments = readFileSync(first.data!.path, "utf8");
		store.close();
		store = new SqliteOutboundDedupStore(join(root, "receipts.db"));
		options.receipts = store.operationReceipts;
		judgment.receipts = store.operationReceipts;
		expect(
			recordLeadPatrolJudgment({ ...judgment, receiptOnly: true }),
		).toEqual(judged);
		expect(recordLeadPatrolJudgment(judgment)).toEqual(judged);
		expect(readFileSync(first.data!.path, "utf8")).toBe(afterJudgments);
		expect(
			recordLeadPatrolJudgment({
				...judgment,
				input: { ...judgment.input, step: 3 },
			}).errorCode,
		).toBe("input_digest_conflict");
		expect(
			recordLeadPatrolJudgment({
				...judgment,
				leadId: "foreign",
				requestId: randomUUID(),
			}).status,
		).toBe("rejected");

		// A report changed after judgment cannot masquerade as the old immutable snapshot.
		writeFileSync(first.data!.path, `${first.data!.text}changed\n`);
		expect((await registerLeadPatrolSnapshot(options)).status).toBe("unknown");
		expect(run).toHaveBeenCalledTimes(1);
		expect(
			recordLeadPatrolJudgment({
				...judgment,
				requestId: randomUUID(),
				input: { ...judgment.input, step: 3 },
			}).status,
		).toBe("rejected");
		// A persisted dispatch without a success receipt is never resent, including after activation change.
		const requestId = randomUUID();
		const prepared = store.operationReceipts.prepare({
			projectName: options.projectName,
			leadId: options.leadId,
			activationId: options.activationId,
			operationId: "patrol.snapshot",
			requestId,
			inputDigest: leadOperationInputDigest({
				tickId: options.tickId,
			}),
			now: Date.now(),
		});
		store.operationReceipts.transition({
			projectName: options.projectName,
			leadId: options.leadId,
			activationId: options.activationId,
			operationId: "patrol.snapshot",
			requestId,
			inputDigest: prepared.receipt.inputDigest,
			now: Date.now(),
			from: "prepared",
			to: "dispatched",
		});
		expect(
			(
				await registerLeadPatrolSnapshot({
					...options,
					requestId,
					activationId: "a2",
				})
			).status,
		).toBe("unknown");
		expect(run).toHaveBeenCalledTimes(1);
		const interruptedId = randomUUID();
		let release!: () => void;
		const waiting = new Promise<void>((resolve) => {
			release = resolve;
		});
		let entered!: () => void;
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		run.mockImplementationOnce(async () => {
			entered();
			await waiting;
			throw new Error("partial report write");
		});
		const interrupted = registerLeadPatrolSnapshot({
			...options,
			requestId: interruptedId,
		});
		await started;
		expect(
			(
				await registerLeadPatrolSnapshot({
					...options,
					requestId: interruptedId,
				})
			).status,
		).toBe("unknown");
		release();
		expect((await interrupted).status).toBe("unknown");
		expect(
			(
				await registerLeadPatrolSnapshot({
					...options,
					requestId: interruptedId,
					activationId: "a2",
				})
			).status,
		).toBe("unknown");
		expect(run).toHaveBeenCalledTimes(2);
	} finally {
		run.mockRestore();
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
}, 20000);
