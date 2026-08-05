import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LeadLeaseStore } from "flywheel-comm/lead-lease";
import { MailboxQueue } from "flywheel-comm/mailbox-queue";
import { encodeSenderRef } from "flywheel-comm/sender-ref";
import { afterEach, describe, expect, it } from "vitest";

const RULE_PATH = fileURLToPath(
	new URL("../../lead-rules-base/discord-reply-contract.md", import.meta.url),
);
const COMM_CLI = fileURLToPath(
	new URL("../../../flywheel-comm/dist/index.js", import.meta.url),
);

describe("Discord chat durable-receipt Lead contract", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("documents the receipt formula and only the valid close paths", () => {
		const rules = readFileSync(RULE_PATH, "utf8");

		expect(rules).toContain("chat:<lead_id>:<message_id>");
		expect(rules).toContain("reply_to=<message_id>");
		expect(rules).toContain(
			'node "$FLYWHEEL_COMM_CLI" handle-receipt --lead "$FLYWHEEL_LEAD_ID" --receipt <receipt_id> --request-id <unique_id> --action ack',
		);
		expect(rules).toMatch(/founder task[\s\S]*actual side effect[\s\S]*ack/i);
		expect(rules).toMatch(/relay|respond/);
		expect(rules).toMatch(/pending Runner question/i);
	});

	it("executes the documented ack command against a delivered chat receipt", () => {
		const dir = mkdtempSync(join(tmpdir(), "fly1426-rule-contract-"));
		dirs.push(dir);
		const dbPath = join(dir, "comm.db");
		const leaseDbPath = join(dir, "lead-lease.db");
		const projectsPath = join(dir, "projects.json");
		const leadId = "lead-a";
		const leadKey = `flywheel-${leadId}`;
		const messageId = "100000000000000001";
		const receiptId = `chat:${leadId}:${messageId}`;
		writeFileSync(
			projectsPath,
			JSON.stringify([
				{
					projectName: "flywheel",
					leads: [{ agentId: leadId, backend: "claude-code" }],
				},
			]),
		);

		const queue = new MailboxQueue(dbPath);
		queue.enqueue({
			id: receiptId,
			fromAgent: "founder",
			toAgent: leadId,
			recipientKind: "lead",
			sourceKind: "discord_chat",
			type: "external_delivery",
			msgClass: "model",
			priority: 0,
			content: "founder: ship the report",
			carrier: "external",
			createdAt: "2026-07-22T12:00:00.000Z",
			senderRef: encodeSenderRef(),
		});
		queue.markExternalDelivered(receiptId, "2026-07-22T12:00:01.000Z");

		const holderStart = "test-holder-start";
		const lease = new LeadLeaseStore(leaseDbPath);
		const acquired = lease.acquire({
			leadKey,
			project: "flywheel",
			leadId,
			supervisorPid: process.pid,
			supervisorStart: holderStart,
			acquiredBy: "test",
		});
		expect(acquired.status).toBe("acquired");
		lease.bind({
			leadKey,
			generation: acquired.generation,
			expectedSupervisorPid: process.pid,
			expectedSupervisorStart: holderStart,
			panePid: process.pid,
			paneStart: holderStart,
		});
		lease.close();

		const command =
			'node "$FLYWHEEL_COMM_CLI" handle-receipt --lead "$FLYWHEEL_LEAD_ID" --receipt <receipt_id> --request-id <unique_id> --action ack'
				.replace("<receipt_id>", receiptId)
				.replace("<unique_id>", "fly1426-rule-contract-1");
		const output = execFileSync("/bin/bash", ["-lc", command], {
			encoding: "utf8",
			env: {
				...process.env,
				FLYWHEEL_COMM_CLI: COMM_CLI,
				FLYWHEEL_COMM_DB: dbPath,
				FLYWHEEL_LEAD_ID: leadId,
				FLYWHEEL_PROJECT_NAME: "flywheel",
				FLYWHEEL_PROJECTS_FILE: projectsPath,
				FLYWHEEL_LEAD_LEASE_MODE: "enforce",
				FLYWHEEL_LEAD_LEASE_DB: leaseDbPath,
				FLYWHEEL_LEAD_LEASE_KEY: leadKey,
				FLYWHEEL_LEAD_GENERATION: String(acquired.generation),
			},
		});

		expect(output).toContain(`Handled ${receiptId} with ack`);
		expect(queue.getSettlement(receiptId)?.event).toBe("processed");
		queue.close();
	});
});
