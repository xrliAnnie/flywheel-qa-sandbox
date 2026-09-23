import { createHash } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("./standing-authority-activation-store.js", () => ({
	loadVerifiedStandingAuthority: () => ({
		manifest: {
			independentConfirmation: {
				identity: "flywheel-cos-lead",
				receiptId: "confirmation-receipt",
			},
		},
		verification: {
			entryId: "raya-carrier-follow-main/v1",
			entryDigest: "a".repeat(64),
			manifestDigest: "b".repeat(64),
			mechanismVersion: "standing-authority/v1",
			revision: 2,
			packageDigest: "c".repeat(64),
		},
	}),
}));

import { migrateMigrationToStandingAuthority } from "./raya-migration-init.js";
import {
	runMigrationManifest,
	standingMigrationAuthorization,
	verifyStandingMigrationAuthorization,
} from "./raya-migration-manifest.js";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});
const sha = (value: string | Buffer) =>
	createHash("sha256").update(value).digest("hex");

it("builds standing authority without a founder canonical line", () => {
	const authorization = standingMigrationAuthorization("/unused");
	expect(authorization).toMatchObject({
		granted_by: "standing-carve-out",
		entry_id: "raya-carrier-follow-main/v1",
		manifest_revision: 2,
		confirmed_by: "flywheel-cos-lead",
	});
	expect(authorization).not.toHaveProperty("canonical_line");
	expect(
		verifyStandingMigrationAuthorization("/unused", authorization),
	).toEqual(authorization);
	expect(() =>
		verifyStandingMigrationAuthorization("/unused", {
			...authorization,
			entry_digest: "f".repeat(64),
		}),
	).toThrow("standing-migration-authorization-mismatch");
});

it("migrates an untouched P2 founder ledger in place with digest CAS", () => {
	const home = realpathSync(
		mkdtempSync(join(tmpdir(), "fly2654-raya-standing-")),
	);
	dirs.push(home);
	const folder = join(home, ".flywheel/raya/migrations/FLY-2445-standard-lead");
	mkdirSync(folder, { recursive: true });
	const file = join(folder, "manifest.json");
	const original = {
		schemaVersion: 1,
		checkpoint: "P2",
		migration_id: "legacy",
		target_raya_sha: "1".repeat(40),
		authorization: {
			legacy_stop: true,
			granted_by: "founder",
			granted_at: "2026-09-16T22:49:00.000Z",
			evidence_message_id: "12345678901234567",
			evidence_channel_id: "22345678901234567",
			evidence_author_id: "32345678901234567",
			content_sha256: "a".repeat(64),
			canonical_line:
				"FLY-2496 AUTHORIZE register cutover=11111111 urgent-restart baseline=quiet15m",
			issued_by: "flywheel-eng-lead",
		},
		legacy_owner: [
			{ label: "brain", pid: 1 },
			{ label: "voice", pid: 2 },
		],
		cursor: { path: "/preserved", status: null },
		unresolved: [{ reason: "preserved" }],
	};
	const bytes = `${JSON.stringify(original)}\n`;
	const unsafeBytes = `${JSON.stringify({ ...original, prestop_probe: { message_id: "42345678901234567" } })}\n`;
	writeFileSync(file, unsafeBytes, { mode: 0o600 });
	expect(() =>
		migrateMigrationToStandingAuthority({
			home,
			expectedManifestDigest: sha(unsafeBytes),
		}),
	).toThrow("migration-standing-transition-unsafe");
	writeFileSync(file, bytes, { mode: 0o600 });
	const result = migrateMigrationToStandingAuthority({
		home,
		expectedManifestDigest: sha(bytes),
	});
	expect(result.status).toBe("migrated");
	const migrated = JSON.parse(readFileSync(file, "utf8"));
	expect(migrated.cursor).toEqual(original.cursor);
	expect(migrated.unresolved).toEqual(original.unresolved);
	expect(migrated.authorization.granted_by).toBe("standing-carve-out");
	expect(migrated.authorization_history).toEqual([original.authorization]);
	expect(() =>
		migrateMigrationToStandingAuthority({
			home,
			expectedManifestDigest: sha(bytes),
		}),
	).toThrow("migration-cas-conflict");
});

it("rejects standing init argument mixing before any migration I/O", async () => {
	const context = {
		home: "/unused",
		flywheelDir: "/unused",
		io: {
			fetch: globalThis.fetch,
			now: () => 0,
			run: async () => {
				throw new Error("unexpected-io");
			},
		},
	};
	await expect(
		runMigrationManifest(
			[
				"init",
				"--standing-authority",
				"--authorization-message-id",
				"12345678901234567",
			],
			context,
		),
	).rejects.toThrow("migration-arguments-invalid");
	await expect(
		runMigrationManifest(
			["init", "--standing-authority", "--migration-manifest", "/ignored"],
			context,
		),
	).rejects.toThrow("migration-arguments-invalid");
});
