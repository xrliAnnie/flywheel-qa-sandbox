import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	computeFingerprint,
	probeLegacyMailboxDelivery,
	writeMailboxEntry,
} from "../ClaudeMailboxCodec.js";

describe("FLY-1373 legacy mailbox receipt probe", () => {
	function paths() {
		const dir = mkdtempSync(join(tmpdir(), "fly1373-legacy-mailbox-"));
		return {
			inboxPath: join(dir, "inbox.json"),
			sidecarPath: join(dir, "inbox.json.flywheel.jsonl"),
		};
	}

	it("recognizes a finalized legacy alias", async () => {
		const p = paths();
		await writeMailboxEntry({
			...p,
			flywheelId: "lead-1-attempt-1",
			payload: { from: "bridge", to: "lead-1", content: "hello" },
		});
		await expect(
			probeLegacyMailboxDelivery({
				...p,
				aliases: ["lead-1-attempt-1"],
				to: "lead-1",
				content: "hello",
			}),
		).resolves.toEqual({
			status: "delivered",
			alias: "lead-1-attempt-1",
		});
	});

	it("repairs an exact Phase-B-written pending record", async () => {
		const p = paths();
		const pendingAt = 1_721_404_800_000;
		const timestamp = new Date(pendingAt).toISOString();
		const fingerprint = computeFingerprint({
			from: "bridge",
			to: "lead-1",
			text: "hello",
			timestamp,
		});
		writeFileSync(
			p.sidecarPath,
			`${JSON.stringify({
				flywheelId: "lead-1-attempt-2",
				status: "pending",
				idempotency: "stable",
				payloadFingerprint: fingerprint,
				pendingAt,
			})}\n`,
		);
		writeFileSync(
			p.inboxPath,
			JSON.stringify([
				{ from: "bridge", text: "hello", timestamp, read: true },
			]),
		);
		await expect(
			probeLegacyMailboxDelivery({
				...p,
				aliases: ["lead-1-attempt-2"],
				to: "lead-1",
				content: "hello",
			}),
		).resolves.toEqual({
			status: "delivered",
			alias: "lead-1-attempt-2",
		});
		expect(readFileSync(p.sidecarPath, "utf8")).toContain(
			'"status":"finalized"',
		);
	});

	it("does not accept matching text at a different main-entry ref", async () => {
		const p = paths();
		const pendingAt = 1_721_404_800_000;
		const timestamp = new Date(pendingAt).toISOString();
		writeFileSync(
			p.sidecarPath,
			`${JSON.stringify({
				flywheelId: "lead-1-attempt-3",
				status: "pending",
				idempotency: "stable",
				payloadFingerprint: computeFingerprint({
					from: "bridge",
					to: "lead-1",
					text: "hello",
					timestamp,
				}),
				pendingAt,
			})}\n`,
		);
		writeFileSync(
			p.inboxPath,
			JSON.stringify([
				{
					from: "bridge",
					text: "hello",
					timestamp: new Date(pendingAt + 1).toISOString(),
					read: false,
				},
			]),
		);
		await expect(
			probeLegacyMailboxDelivery({
				...p,
				aliases: ["lead-1-attempt-3"],
				to: "lead-1",
				content: "hello",
			}),
		).resolves.toEqual({ status: "none" });
	});

	it("repairs pending legacy evidence from its frozen sidecar fingerprint even when rendering drifted", async () => {
		const p = paths();
		const pendingAt = 1_721_404_800_000;
		const timestamp = new Date(pendingAt).toISOString();
		writeFileSync(
			p.sidecarPath,
			`${JSON.stringify({
				flywheelId: "lead-1-attempt-drift",
				status: "pending",
				idempotency: "stable",
				payloadFingerprint: computeFingerprint({
					from: "bridge",
					to: "lead-1",
					text: "legacy body with ACK evidence",
					timestamp,
				}),
				pendingAt,
				mainEntryRef: { from: "bridge", timestamp },
			})}\n`,
		);
		writeFileSync(
			p.inboxPath,
			JSON.stringify([
				{
					from: "bridge",
					text: "legacy body with ACK evidence",
					timestamp,
					read: true,
				},
			]),
		);

		await expect(
			probeLegacyMailboxDelivery({
				...p,
				aliases: ["lead-1-attempt-drift"],
				to: "lead-1",
				content: "new renderer body without ACK evidence",
			}),
		).resolves.toEqual({
			status: "delivered",
			alias: "lead-1-attempt-drift",
		});
	});

	it("continues past one conflicting alias when a later alias is finalized", async () => {
		const p = paths();
		const timestamp = "2024-07-19T00:00:00.000Z";
		writeFileSync(
			p.sidecarPath,
			`${[
				JSON.stringify({
					flywheelId: "lead-1-conflict",
					status: "pending",
					idempotency: "stable",
					payloadFingerprint: "wrong",
					pendingAt: Date.parse(timestamp),
					mainEntryRef: { from: "bridge", timestamp },
				}),
				JSON.stringify({
					flywheelId: "lead-1-finalized",
					status: "finalized",
					idempotency: "stable",
					payloadFingerprint: "receipt",
					pendingAt: Date.parse(timestamp),
					finalizedAt: Date.parse(timestamp),
				}),
			].join("\n")}\n`,
		);

		await expect(
			probeLegacyMailboxDelivery({
				...p,
				aliases: ["lead-1-conflict", "lead-1-finalized"],
				to: "lead-1",
				content: "current rendering",
			}),
		).resolves.toEqual({
			status: "delivered",
			alias: "lead-1-finalized",
		});
	});
});
