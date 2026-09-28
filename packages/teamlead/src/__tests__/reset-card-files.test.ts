import * as fs from "node:fs";
import {
	chmodSync,
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
import {
	type AuditRow,
	defaultResetCardDir,
	hasLiveIntentFor,
	makeResetCardFiles,
	type ResetCardFs,
	validateProposal,
} from "../account-heal/reset-card-files.js";
import {
	GRANT_ID,
	OTHER_PROPOSAL_ID,
	PROPOSAL_ID,
	REQUEST_ID,
	sampleConsent,
	sampleProposal,
} from "./reset-card-test-fixtures.js";

let root: string;
let dir: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "reset-card-files-"));
	dir = join(root, "claude-quota");
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function intent(patch: Partial<AuditRow> = {}): AuditRow {
	return {
		at: "2026-09-25T23:40:00.000Z",
		kind: "intent",
		proposalId: PROPOSAL_ID,
		target: "business",
		grantId: GRANT_ID,
		requestId: REQUEST_ID,
		...patch,
	} as AuditRow;
}

describe("defaultResetCardDir", () => {
	it("honours FLYWHEEL_STATE_DIR", () => {
		expect(defaultResetCardDir({ FLYWHEEL_STATE_DIR: "/x/state" }, "/h")).toBe(
			"/x/state/claude-quota",
		);
		expect(defaultResetCardDir({}, "/h")).toBe("/h/.flywheel/claude-quota");
	});
});

describe("proposal / consent round trip", () => {
	it("round-trips a digest-bound account table and rejects malformed or edited rows", () => {
		const proposal = sampleProposal({
			accountRows: [
				{
					name: "personal",
					fiveHPct: 88,
					sevenDPct: 41,
					recoveryAt: null,
					cards: [],
				},
			],
		});
		const files = makeResetCardFiles(dir);
		files.writeProposal(proposal);
		expect(files.readProposal()).toEqual({ status: "ok", value: proposal });
		expect(
			validateProposal({
				...proposal,
				accountRows: [{ ...proposal.accountRows![0], name: "bad`name" }],
			}),
		).toBeNull();
		expect(
			validateProposal({
				...proposal,
				accountRows: [{ ...proposal.accountRows![0], fiveHPct: 10 }],
			}),
		).toBeNull();
	});
	it("writes 0600 files in a 0700 dir and reads them back", () => {
		const files = makeResetCardFiles(dir);
		expect(files.readProposal()).toEqual({ status: "absent" });
		expect(files.readConsent()).toEqual({ status: "absent" });
		const proposal = sampleProposal();
		files.writeProposal(proposal);
		files.writeConsent(sampleConsent(proposal));
		expect(files.readProposal()).toEqual({ status: "ok", value: proposal });
		expect(files.readConsent()).toEqual({
			status: "ok",
			value: sampleConsent(proposal),
		});
		expect(statSync(dir).mode & 0o777).toBe(0o700);
		expect(statSync(files.proposalPath).mode & 0o777).toBe(0o600);
		expect(statSync(files.consentPath).mode & 0o777).toBe(0o600);
	});

	it("tightens a pre-existing group-readable directory", () => {
		fs.mkdirSync(dir, { mode: 0o755 });
		chmodSync(dir, 0o755);
		makeResetCardFiles(dir).writeProposal(sampleProposal());
		expect(statSync(dir).mode & 0o777).toBe(0o700);
	});

	it("keeps the blocked-episode snapshot through validation", () => {
		const files = makeResetCardFiles(dir);
		const proposal = sampleProposal({
			status: "switching",
			blockedEpisodeAtSwitch: {
				scope: "5h",
				startedAt: "2026-09-25T23:00:00.000Z",
				lastConfirmedAlertAt: null,
				alertCount: 1,
				blockedRound: 1,
				recoveryRound: 0,
				activeDelivery: null,
			},
		});
		files.writeProposal(proposal);
		expect(files.readProposal()).toEqual({ status: "ok", value: proposal });
	});
});

describe("invalid is not absent", () => {
	it.each<[string, () => void]>([
		[
			"symlink",
			() => {
				const target = join(root, "elsewhere.json");
				writeFileSync(target, JSON.stringify(sampleProposal()));
				fs.mkdirSync(dir, { recursive: true });
				symlinkSync(target, join(dir, "reset-card-proposal.json"));
			},
		],
		[
			"oversized",
			() => {
				fs.mkdirSync(dir, { recursive: true });
				writeFileSync(
					join(dir, "reset-card-proposal.json"),
					" ".repeat(17 * 1024),
				);
			},
		],
		[
			"unknown key",
			() => {
				fs.mkdirSync(dir, { recursive: true });
				writeFileSync(
					join(dir, "reset-card-proposal.json"),
					JSON.stringify({ ...sampleProposal(), extra: 1 }),
				);
			},
		],
		[
			"non-canonical instant",
			() => {
				fs.mkdirSync(dir, { recursive: true });
				writeFileSync(
					join(dir, "reset-card-proposal.json"),
					JSON.stringify({
						...sampleProposal(),
						statusAt: "2026-09-25T23:05:00Z",
					}),
				);
			},
		],
		[
			"bad account name",
			() => {
				fs.mkdirSync(dir, { recursive: true });
				const proposal = sampleProposal();
				writeFileSync(
					join(dir, "reset-card-proposal.json"),
					JSON.stringify({
						...proposal,
						target: { ...proposal.target, name: "../evil" },
					}),
				);
			},
		],
		[
			"tampered core (digest no longer matches)",
			() => {
				fs.mkdirSync(dir, { recursive: true });
				const proposal = sampleProposal();
				writeFileSync(
					join(dir, "reset-card-proposal.json"),
					JSON.stringify({
						...proposal,
						grant: { ...proposal.grant, cardsLeftTotal: 5 },
					}),
				);
			},
		],
		[
			"not json",
			() => {
				fs.mkdirSync(dir, { recursive: true });
				writeFileSync(join(dir, "reset-card-proposal.json"), "{nope");
			},
		],
	])("%s → invalid", (_label, arrange) => {
		arrange();
		expect(makeResetCardFiles(dir).readProposal().status).toBe("invalid");
	});

	it("refuses to write an invalid proposal", () => {
		const files = makeResetCardFiles(dir);
		expect(() =>
			files.writeProposal({ ...sampleProposal(), digest: "0".repeat(64) }),
		).toThrow(/invalid/);
		expect(files.readProposal()).toEqual({ status: "absent" });
	});

	it("validates a consent strictly", () => {
		const files = makeResetCardFiles(dir);
		fs.mkdirSync(dir, { recursive: true });
		writeFileSync(
			files.consentPath,
			JSON.stringify({ ...sampleConsent(), founderId: "not-a-snowflake" }),
		);
		expect(files.readConsent().status).toBe("invalid");
	});
});

describe("atomic write ordering", () => {
	function recordingFs(events: string[]): ResetCardFs {
		return {
			lstatSync: fs.lstatSync,
			readFileSync: fs.readFileSync,
			mkdirSync: fs.mkdirSync,
			chmodSync: fs.chmodSync,
			openSync: ((path: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
				const fd = fs.openSync(path, flags, mode);
				events.push(`open:${String(path).split("/").pop()}#${fd}`);
				return fd;
			}) as ResetCardFs["openSync"],
			writeSync: ((fd: number, data: string) => {
				events.push(`write#${fd}`);
				return fs.writeSync(fd, data);
			}) as ResetCardFs["writeSync"],
			fsyncSync: ((fd: number) => {
				events.push(`fsync#${fd}`);
				fs.fsyncSync(fd);
			}) as ResetCardFs["fsyncSync"],
			closeSync: fs.closeSync,
			renameSync: ((from: fs.PathLike, to: fs.PathLike) => {
				events.push(`rename:${String(to).split("/").pop()}`);
				fs.renameSync(from, to);
			}) as ResetCardFs["renameSync"],
			unlinkSync: fs.unlinkSync,
		};
	}

	it("fsyncs the file, renames, then fsyncs the parent directory", () => {
		const events: string[] = [];
		makeResetCardFiles(dir, recordingFs(events)).writeProposal(
			sampleProposal(),
		);
		const normalized = events.map((event) => event.replace(/#\d+/, ""));
		expect(normalized[0]).toMatch(/^open:reset-card-proposal\.json\.tmp-/);
		expect(normalized.slice(1)).toEqual([
			"write",
			"fsync",
			"rename:reset-card-proposal.json",
			"open:claude-quota",
			"fsync",
		]);
	});

	it("removes the temp file when the rename fails", () => {
		const events: string[] = [];
		const failing = {
			...recordingFs(events),
			renameSync: () => {
				throw new Error("rename boom");
			},
		} as ResetCardFs;
		expect(() =>
			makeResetCardFiles(dir, failing).writeProposal(sampleProposal()),
		).toThrow(/rename boom/);
		expect(fs.readdirSync(dir)).toEqual([]);
	});
});

describe("audit", () => {
	it("appends lines, fsyncs each, and answers the dedup query", () => {
		const events: string[] = [];
		const files = makeResetCardFiles(dir, {
			...fs,
			fsyncSync: ((fd: number) => {
				events.push("fsync");
				fs.fsyncSync(fd);
			}) as ResetCardFs["fsyncSync"],
		} as ResetCardFs);
		expect(files.readAudit()).toEqual({ status: "ok", value: [] });
		files.appendAudit(intent());
		files.appendAudit(
			intent({ proposalId: OTHER_PROPOSAL_ID, target: "school" } as never),
		);
		expect(events.length).toBeGreaterThanOrEqual(2);
		const read = files.readAudit();
		if (read.status !== "ok") throw new Error("expected ok");
		expect(read.value).toHaveLength(2);
		expect(hasLiveIntentFor(read.value, "business", GRANT_ID)).toBe(true);
		// Same grant id on another account is a different card.
		expect(hasLiveIntentFor(read.value, "shopping", GRANT_ID)).toBe(false);
		expect(statSync(files.auditPath).mode & 0o777).toBe(0o600);
	});

	it("ignores an intent that was voided as never posted (F1)", () => {
		const files = makeResetCardFiles(dir);
		files.appendAudit(intent());
		files.appendAudit({
			at: "2026-09-25T23:41:00.000Z",
			kind: "voided",
			proposalId: PROPOSAL_ID,
			requestId: REQUEST_ID,
			reason: "aborted_before_post",
		});
		const read = files.readAudit();
		if (read.status !== "ok") throw new Error("expected ok");
		expect(hasLiveIntentFor(read.value, "business", GRANT_ID)).toBe(false);
	});

	it("fails closed on a torn last line, a bad line, or an oversized file", () => {
		const files = makeResetCardFiles(dir);
		files.appendAudit(intent());
		const good = readFileSync(files.auditPath, "utf8");
		writeFileSync(files.auditPath, `${good}{"at":"2026`);
		expect(files.readAudit()).toEqual({
			status: "invalid",
			reason: "truncated",
		});
		writeFileSync(files.auditPath, `${good}{"kind":"intent"}\n`);
		expect(files.readAudit()).toEqual({
			status: "invalid",
			reason: "line_schema",
		});
		writeFileSync(files.auditPath, "x".repeat(1024 * 1024 + 1));
		expect(files.readAudit()).toEqual({
			status: "invalid",
			reason: "too_large",
		});
		expect(() => files.appendAudit(intent())).toThrow(/unusable/);
	});

	it("refuses to append through a symlink", () => {
		fs.mkdirSync(dir, { recursive: true });
		const target = join(root, "elsewhere.jsonl");
		writeFileSync(target, "");
		symlinkSync(target, join(dir, "reset-card-audit.jsonl"));
		const files = makeResetCardFiles(dir);
		expect(files.readAudit().status).toBe("invalid");
		expect(() => files.appendAudit(intent())).toThrow();
		expect(readFileSync(target, "utf8")).toBe("");
	});
});

describe("validateProposal", () => {
	it("accepts the fixture and rejects a wrong expectedGeneration", () => {
		expect(validateProposal(sampleProposal())).not.toBeNull();
		expect(
			validateProposal(
				sampleProposal({
					status: "executing",
					switchIntent: {
						from: "personal",
						to: "business",
						generationBefore: 7,
						expectedGeneration: 9,
						trigger: { scope: "5h", resetAt: "2026-09-26T02:00:00.000Z" },
						targetDigest: "b".repeat(64),
						verifiedAt: null,
					},
				}),
			),
		).toBeNull();
	});
});
