import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { computeEnvSha } from "../bridge/env-file-writer.js";
import {
	applyMailboxQueueOperatorOff,
	beginMailboxQueueDeployBarrier,
	defaultMailboxQueueBarrierMarkerPath,
	holdMailboxQueueDeployBarrier,
	type MailboxQueueDeployBarrierMarker,
	markMailboxQueueDeployBarrierReady,
	readMailboxQueueDeployBarrierMarker,
	releaseMailboxQueueDeployBarrier,
} from "../bridge/mailbox-queue-deploy-barrier.js";

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function fixture(raw = "# production env\nOTHER=1\n") {
	const dir = mkdtempSync(join(tmpdir(), "mailbox-queue-barrier-"));
	dirs.push(dir);
	const envPath = join(dir, ".env");
	writeFileSync(envPath, raw, { mode: 0o600 });
	const markerPath = defaultMailboxQueueBarrierMarkerPath(envPath);
	const env: Record<string, string | undefined> = {};
	return { dir, envPath, markerPath, env };
}

function writeMarker(
	f: ReturnType<typeof fixture>,
	overrides: Partial<MailboxQueueDeployBarrierMarker>,
): MailboxQueueDeployBarrierMarker {
	mkdirSync(join(f.dir, "state"), { recursive: true });
	const marker: MailboxQueueDeployBarrierMarker = {
		schemaVersion: 1,
		targetSha: "a".repeat(40),
		priorRaw: null,
		phase: "preparing",
		ownershipToken: "owner-a",
		envRevision: computeEnvSha(readFileSync(f.envPath, "utf8")),
		updatedAt: "2026-08-10T00:00:00.000Z",
		...overrides,
	};
	writeFileSync(f.markerPath, `${JSON.stringify(marker)}\n`, { mode: 0o600 });
	return marker;
}

describe("mailbox queue deploy readiness barrier", () => {
	it("persists marker first and forces default-ON deployments OFF before Bridge start", () => {
		const f = fixture();
		const result = beginMailboxQueueDeployBarrier(
			{ ...f, newToken: () => "owner-a" },
			"a".repeat(40),
		);

		expect(result).toMatchObject({ ok: true, owned: true, token: "owner-a" });
		expect(readFileSync(f.envPath, "utf8")).toContain(
			"FLYWHEEL_MAILBOX_QUEUE=0",
		);
		expect(f.env.FLYWHEEL_MAILBOX_QUEUE).toBe("0");
		expect(readMailboxQueueDeployBarrierMarker(f.markerPath)).toMatchObject({
			phase: "off_persisted",
			priorRaw: null,
			ownershipToken: "owner-a",
		});
	});

	it("a crash after marker persistence resumes with the same owner and converges to OFF", () => {
		const f = fixture();
		writeMarker(f, { phase: "preparing", ownershipToken: "owner-a" });

		const result = beginMailboxQueueDeployBarrier(
			{ ...f, newToken: () => "must-not-replace-owner" },
			"a".repeat(40),
		);
		expect(result).toMatchObject({ ok: true, owned: true, token: "owner-a" });
		expect(f.env.FLYWHEEL_MAILBOX_QUEUE).toBe("0");
		expect(readMailboxQueueDeployBarrierMarker(f.markerPath)?.phase).toBe(
			"off_persisted",
		);
	});

	it("a crash after Bridge start reuses the durable owner instead of creating a second rollout", () => {
		const f = fixture("FLYWHEEL_MAILBOX_QUEUE=0\n");
		f.env.FLYWHEEL_MAILBOX_QUEUE = "0";
		writeMarker(f, {
			phase: "off_persisted",
			ownershipToken: "owner-a",
			envRevision: computeEnvSha(readFileSync(f.envPath, "utf8")),
		});

		const result = beginMailboxQueueDeployBarrier(f, "a".repeat(40));
		expect(result).toMatchObject({ ok: true, owned: true, token: "owner-a" });
	});

	it("all-Leads-ready before release is restart-safe", () => {
		const f = fixture();
		const begin = beginMailboxQueueDeployBarrier(
			{ ...f, newToken: () => "owner-a" },
			"a".repeat(40),
		);
		expect(
			markMailboxQueueDeployBarrierReady(
				f,
				"a".repeat(40),
				begin.token as string,
				"all launchers and MCP tools ready",
			),
		).toMatchObject({ ok: true });

		// A later process can finish the same transaction with the durable token.
		expect(
			releaseMailboxQueueDeployBarrier(
				f,
				"a".repeat(40),
				begin.token as string,
			),
		).toMatchObject({ ok: true, released: true });
		expect(readFileSync(f.envPath, "utf8")).not.toContain(
			"FLYWHEEL_MAILBOX_QUEUE=",
		);
		expect(f.env.FLYWHEEL_MAILBOX_QUEUE).toBeUndefined();
		expect(existsSync(f.markerPath)).toBe(false);
	});

	it("a crash after env/live release but before marker cleanup converges without re-disabling", () => {
		const f = fixture();
		writeMarker(f, {
			phase: "released",
			ownershipToken: "owner-a",
			envRevision: computeEnvSha(readFileSync(f.envPath, "utf8")),
		});

		expect(
			releaseMailboxQueueDeployBarrier(f, "a".repeat(40), "owner-a"),
		).toMatchObject({ ok: true, released: true });
		expect(existsSync(f.markerPath)).toBe(false);
	});

	it("a crash between env/live release and the released-phase marker also converges", () => {
		const f = fixture();
		writeMarker(f, {
			phase: "releasing",
			ownershipToken: "owner-a",
			envRevision: computeEnvSha("FLYWHEEL_MAILBOX_QUEUE=0\n"),
		});

		const resumed = beginMailboxQueueDeployBarrier(f, "a".repeat(40));
		expect(resumed).toMatchObject({
			ok: true,
			owned: false,
			alreadyReleased: true,
		});
		expect(readFileSync(f.envPath, "utf8")).not.toContain(
			"FLYWHEEL_MAILBOX_QUEUE=0",
		);
		expect(existsSync(f.markerPath)).toBe(false);
	});

	it("pre-existing operator OFF is never claimed or auto-released", () => {
		const f = fixture("FLYWHEEL_MAILBOX_QUEUE=0\n");
		f.env.FLYWHEEL_MAILBOX_QUEUE = "0";

		const result = beginMailboxQueueDeployBarrier(f, "a".repeat(40));
		expect(result).toMatchObject({ ok: true, owned: false, operatorOff: true });
		expect(existsSync(f.markerPath)).toBe(false);
		expect(f.env.FLYWHEEL_MAILBOX_QUEUE).toBe("0");
	});

	it("operator OFF during rollout changes ownership even when env bytes already equal 0", () => {
		const f = fixture();
		const begin = beginMailboxQueueDeployBarrier(
			{ ...f, newToken: () => "deploy-owner" },
			"a".repeat(40),
		);
		const beforeBytes = readFileSync(f.envPath, "utf8");

		expect(
			applyMailboxQueueOperatorOff({
				...f,
				newToken: () => "operator-owner",
				reason: "emergency rollback",
			}),
		).toMatchObject({ ok: true, ownershipInvalidated: true });
		expect(readFileSync(f.envPath, "utf8")).toBe(beforeBytes);
		expect(readMailboxQueueDeployBarrierMarker(f.markerPath)).toMatchObject({
			phase: "operator_override",
			ownershipToken: "operator-owner",
		});
		expect(
			releaseMailboxQueueDeployBarrier(
				f,
				"a".repeat(40),
				begin.token as string,
			),
		).toMatchObject({ ok: false, code: 409 });
		expect(f.env.FLYWHEEL_MAILBOX_QUEUE).toBe("0");
	});

	it("partial Lead failure is durable, explicit, and cannot release", () => {
		const f = fixture();
		const begin = beginMailboxQueueDeployBarrier(
			{ ...f, newToken: () => "owner-a" },
			"a".repeat(40),
		);
		expect(
			holdMailboxQueueDeployBarrier(
				f,
				"a".repeat(40),
				begin.token as string,
				"lead restart failed=1 skipped=0",
			),
		).toMatchObject({ ok: true });
		expect(readMailboxQueueDeployBarrierMarker(f.markerPath)).toMatchObject({
			phase: "failed",
			reason: "lead restart failed=1 skipped=0",
		});
		expect(
			releaseMailboxQueueDeployBarrier(
				f,
				"a".repeat(40),
				begin.token as string,
			),
		).toMatchObject({ ok: false, code: 409 });
		expect(f.env.FLYWHEEL_MAILBOX_QUEUE).toBe("0");
	});

	it("an interrupted happy-path rerun resumes failed ownership and reaches ON", () => {
		const f = fixture();
		const first = beginMailboxQueueDeployBarrier(
			{ ...f, newToken: () => "owner-a" },
			"a".repeat(40),
		);
		holdMailboxQueueDeployBarrier(
			f,
			"a".repeat(40),
			first.token as string,
			"process interrupted",
		);

		const resumed = beginMailboxQueueDeployBarrier(f, "a".repeat(40));
		expect(resumed).toMatchObject({ ok: true, owned: true, token: "owner-a" });
		expect(
			markMailboxQueueDeployBarrierReady(
				f,
				"a".repeat(40),
				"owner-a",
				"retry ready",
			),
		).toMatchObject({ ok: true });
		expect(
			releaseMailboxQueueDeployBarrier(f, "a".repeat(40), "owner-a"),
		).toMatchObject({ ok: true, released: true });
		expect(existsSync(f.markerPath)).toBe(false);
	});
});
