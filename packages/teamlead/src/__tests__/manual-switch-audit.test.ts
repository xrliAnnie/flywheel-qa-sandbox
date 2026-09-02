import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendManualSwitchFailureAudit } from "../account-heal/manual-switch-audit.js";

describe("appendManualSwitchFailureAudit", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "fly2265-manual-audit-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("creates a missing owner-only audit file with the fallback failure record", () => {
		const auditDir = join(tmp, "audit");
		const auditPath = join(auditDir, "profile-audit.log");
		mkdirSync(auditDir, { mode: 0o700 });

		appendManualSwitchFailureAudit({
			path: auditPath,
			command: "use",
			profile: "school",
			reasonCode: "apply_failed",
			reason: "spawn flywheel-claude-profile ENOENT",
			actor: "test",
		});

		const raw = readFileSync(auditPath, "utf8");
		const records = raw
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({
			cmd: "use",
			profile: "school",
			phase: "entry",
			probeSummary: "apply_failed",
			actor: "test",
			actorTrust: "untrusted_hint",
			exitCode: 1,
			details: {
				reasonCode: "apply_failed",
				reason: "spawn flywheel-claude-profile ENOENT",
			},
		});
		expect(records[0].ts).toEqual(expect.any(String));
		expect(statSync(auditPath).mode & 0o777).toBe(0o600);
		expect(raw).not.toContain("sk-ant-oat01");
		expect(raw).not.toContain("accessToken");
	});

	it("enforces owner-only mode when the caller umask masks owner write", () => {
		const auditPath = join(tmp, "profile-audit.log");
		const previousUmask = process.umask(0o200);
		try {
			appendManualSwitchFailureAudit({
				path: auditPath,
				command: "use",
				profile: "school",
				reasonCode: "apply_failed",
				reason: "spawn flywheel-claude-profile ENOENT",
				actor: "test",
			});
		} finally {
			process.umask(previousUmask);
		}

		expect(statSync(auditPath).mode & 0o777).toBe(0o600);
		expect(readFileSync(auditPath, "utf8")).toContain(
			'"reasonCode":"apply_failed"',
		);
	});

	it("refuses a symlink without modifying its referent", () => {
		const referent = join(tmp, "referent.log");
		const auditPath = join(tmp, "profile-audit.log");
		writeFileSync(referent, "original\n", { mode: 0o600 });
		symlinkSync(referent, auditPath);

		expect(() =>
			appendManualSwitchFailureAudit({
				path: auditPath,
				command: "use",
				profile: "school",
				reasonCode: "apply_failed",
				reason: "synthetic failure",
				actor: "test",
			}),
		).toThrow();
		expect(readFileSync(referent, "utf8")).toBe("original\n");
	});

	it("refuses a group-readable audit file without appending", () => {
		const auditPath = join(tmp, "profile-audit.log");
		writeFileSync(auditPath, "original\n", { mode: 0o600 });
		chmodSync(auditPath, 0o644);

		expect(() =>
			appendManualSwitchFailureAudit({
				path: auditPath,
				command: "next",
				profile: null,
				reasonCode: "apply_failed",
				reason: "synthetic failure",
				actor: "test",
			}),
		).toThrow();
		expect(readFileSync(auditPath, "utf8")).toBe("original\n");
	});
});
