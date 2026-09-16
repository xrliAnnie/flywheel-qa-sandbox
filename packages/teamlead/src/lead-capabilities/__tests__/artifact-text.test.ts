import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	realpathSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requestLeadOperation } from "flywheel-comm/lead-operation-client";
import { expect, it } from "vitest";
import { SqliteJournalStore } from "../../lead-backends/codex/SqliteJournalStore.js";
import { LeadArtifactStore } from "../artifacts.js";
import type { LeadOperationContext } from "../broker.js";
import { LeadCapabilityBroker } from "../broker.js";
import { LeadCapabilitySocket } from "../broker-socket.js";
import { createArtifactTextHandler } from "../handlers/artifact-text.js";

it("stores authored text only after size, secret, scope and activation checks", async () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "fly2519-text-")));
	const artifactRoot = join(root, "artifacts");
	mkdirSync(artifactRoot, { mode: 0o700 });
	let active = true;
	const current = () => {
		if (!active) throw new Error("stale");
	};
	const store = new LeadArtifactStore({
		projectRoot: root,
		artifactRoot,
		assertCurrent: current,
	});
	const context = {
		projectName: "p",
		leadId: "l",
		activationId: "a",
		requestId: "123e4567-e89b-42d3-a456-426614174000",
		signal: new AbortController().signal,
		assertCurrent: async () => current(),
	} as LeadOperationContext;
	const handler = createArtifactTextHandler({
		projectName: "p",
		leadId: "l",
		activationId: "a",
		store,
		secrets: ["secret-canary"],
		assertCurrent: current,
	});
	try {
		for (const input of [
			{ mimeType: "text/html", text: "secret-canary" },
			{ mimeType: "text/plain", text: "界".repeat(180000) },
			{ mimeType: "image/png", text: "x" },
			{ mimeType: "text/html", text: "x", path: "/tmp/evil" },
		])
			await expect(handler.execute(input, context)).rejects.toThrow();
		expect(readdirSync(artifactRoot)).toEqual([]);
		await expect(
			handler.execute(
				{ mimeType: "text/plain", text: "x" },
				{ ...context, leadId: "other" },
			),
		).rejects.toThrow();
		for (const mimeType of [
			"text/html",
			"text/plain",
			"text/markdown",
			"application/json",
		]) {
			const text =
				mimeType === "application/json" ? "{}" : "<head></head>hello";
			const result = await handler.execute({ mimeType, text }, context);
			expect(result.status).toBe("succeeded");
			expect(Object.keys(result.data as object)).toEqual(["artifactHandle"]);
			const value = await store.read(
				(result.data as { artifactHandle: string }).artifactHandle,
			);
			expect(value.data.toString()).toBe(text);
			expect(value.artifact.mimeType).toBe(mimeType);
		}
		active = false;
		await expect(
			handler.execute({ mimeType: "text/plain", text: "x" }, context),
		).rejects.toThrow();
		expect(readdirSync(artifactRoot)).toHaveLength(4);
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

it("accepts the full text budget through UDS and SQLite, replays once and rejects changed payload", async () => {
	const root = realpathSync(mkdtempSync("/tmp/fly2519-text-uds-"));
	const artifactRoot = join(root, "artifacts");
	mkdirSync(artifactRoot, { mode: 0o700 });
	const store = new LeadArtifactStore({
		projectRoot: root,
		artifactRoot,
		assertCurrent: () => {},
	});
	const journal = new SqliteJournalStore(join(root, "journal.sqlite"));
	const handler = createArtifactTextHandler({
		projectName: "p",
		leadId: "l",
		activationId: "a",
		store,
		secrets: ["secret-canary"],
		assertCurrent: () => {},
	});
	const broker = new LeadCapabilityBroker({
		projectName: "p",
		leadId: "l",
		activationId: "a",
		receipts: journal.operationReceipts,
		allowedOperationIds: () => new Set(["artifact.text.create"]),
		assertCurrent: async () => {},
		handlers: new Map([["artifact.text.create", handler]]),
		secrets: ["secret-canary"],
	});
	const socketPath = join(root, "broker.sock");
	const socket = new LeadCapabilitySocket({
		socketPath,
		dispatch: (raw) => broker.execute(raw),
	});
	try {
		await socket.listen();
		const request = {
			schemaVersion: 1 as const,
			operationId: "artifact.text.create",
			requestId: "123e4567-e89b-42d3-a456-426614174000",
			input: { mimeType: "text/plain", text: "\0".repeat(512 * 1024) },
		};
		const first = await requestLeadOperation(socketPath, request);
		expect(first.status).toBe("succeeded");
		expect(await requestLeadOperation(socketPath, request)).toMatchObject({
			status: "succeeded",
			resourceRefs: first.resourceRefs,
		});
		expect(
			(
				await requestLeadOperation(socketPath, {
					...request,
					input: { ...request.input, text: "changed" },
				})
			).errorCode,
		).toBe("input_digest_conflict");
		expect(readdirSync(artifactRoot)).toHaveLength(1);
		expect(
			(
				await requestLeadOperation(socketPath, {
					...request,
					requestId: "223e4567-e89b-42d3-a456-426614174000",
					input: { ...request.input, text: "x".repeat(512 * 1024 + 1) },
				})
			).status,
		).toBe("rejected");
		expect(readdirSync(artifactRoot)).toHaveLength(1);
	} finally {
		await socket.close();
		await broker.close();
		journal.close();
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});
