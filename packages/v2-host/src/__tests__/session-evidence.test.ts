import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifySessionProcess } from "flywheel-v2-engine";
import { afterEach, describe, expect, it } from "vitest";
import {
	classifyProbeOutput,
	FileSessionEvidenceProbe,
	probeProcessStart,
	probeProcessStartWithBin,
	publishSessionProof,
	readProcessStartIdentity,
} from "../session-evidence.js";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("session evidence", () => {
	it("hashes the full DAG session ref while retaining exact identity in the proof", () => {
		const root = mkdtempSync(join(tmpdir(), "flywheel-v2-proof-"));
		roots.push(root);
		const sessionId = "v2dag:attempt-1:1:activation-1";
		const path = publishSessionProof({
			root,
			sessionId,
			pid: 1234,
			pidStart: "test-start",
		});
		expect(path).toBe(
			join(
				root,
				`${createHash("sha256").update(sessionId).digest("hex")}.json`,
			),
		);
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(new FileSessionEvidenceProbe(root).sessionOwner(sessionId)).toEqual({
			pid: 1234,
			pidStart: "test-start",
		});
	});
});

describe("FLY-1503 / Codex R3 HIGH-1 — the process probe is not PATH-resolvable", () => {
	it("ignores a shadowed ps earlier in PATH", () => {
		const root = mkdtempSync(join(tmpdir(), "fly1503-ps-shadow-"));
		try {
			// A same-uid runner can write to directories that precede /usr/bin and
			// /bin in the production launchd PATH, so a shadowed `ps` must not be
			// reachable: it could forge a start identity for a live lead's pid and
			// enable a takeover.
			const shadow = join(root, "ps");
			writeFileSync(shadow, '#!/bin/sh\necho "FORGED-START-IDENTITY"\n', {
				mode: 0o755,
			});
			const originalPath = process.env.PATH;
			process.env.PATH = `${root}:${originalPath ?? ""}`;
			try {
				const observed = readProcessStartIdentity(process.pid);
				expect(observed).not.toBeNull();
				expect(observed).not.toContain("FORGED");
			} finally {
				if (originalPath === undefined) delete process.env.PATH;
				else process.env.PATH = originalPath;
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("reports a live pid as present and a never-issued pid as absent", () => {
		const live = probeProcessStart(process.pid);
		expect(live.status).toBe("present");
		expect(
			live.status === "present" ? live.startIdentity : "",
		).not.toHaveLength(0);
		// pid_max is 99998 on macOS, so this can never name a live process. `ps`
		// answers exit 1 with no output, which is the only failure this reads as
		// absence.
		expect(probeProcessStart(4_194_303)).toEqual({ status: "absent" });
	});

	it("classifies an unusable pid as unavailable rather than absent", () => {
		// A malformed pid is not evidence that a process is gone. Reporting it as
		// absent is precisely the fail-open the takeover gate must never see.
		for (const pid of [0, -1, 1.5, Number.NaN]) {
			expect(probeProcessStart(pid).status).toBe("unavailable");
		}
	});

	it("refuses to read forged multi-line probe output as an identity", () => {
		// A probe answering with several lines is not the single-pid query this is
		// defined over -- e.g. a `ps` that ignores `-p` and lists every process.
		// Taking line one would let the answer for one pid stand in for another.
		const original = process.env.FLYWHEEL_V2_TEST_PROCESS_START_EVIDENCE;
		const originalEnv = process.env.NODE_ENV;
		process.env.NODE_ENV = "test";
		process.env.FLYWHEEL_V2_TEST_PROCESS_START_EVIDENCE = JSON.stringify({
			"777": "Tue Jul 28 01:00:00 2026\nTue Jul 28 02:00:00 2026",
		});
		try {
			// The multi-line value arrives through the trusted-binary path in
			// production; here the classification itself is what is under test.
			const probed = probeProcessStart(777);
			expect(probed.status).toBe("present");
			// The test override is a single opaque string by construction, so assert
			// the production splitter instead: it must reject a multi-line answer.
			expect(classifyProbeOutput("a\nb")).toEqual({
				status: "unavailable",
				reason: "/bin/ps returned 2 start identities",
			});
			expect(classifyProbeOutput("   ")).toEqual({
				status: "unavailable",
				reason: "/bin/ps returned 0 start identities",
			});
			expect(classifyProbeOutput("Tue Jul 28 01:00:00 2026\n")).toEqual({
				status: "present",
				startIdentity: "Tue Jul 28 01:00:00 2026",
			});
		} finally {
			process.env.NODE_ENV = originalEnv;
			if (original === undefined) {
				delete process.env.FLYWHEEL_V2_TEST_PROCESS_START_EVIDENCE;
			} else {
				process.env.FLYWHEEL_V2_TEST_PROCESS_START_EVIDENCE = original;
			}
		}
	});
});

describe("Codex R4 HIGH-2 — absence comes from a syscall, not a ps exit status", () => {
	it("reports unavailable when ps fails only for a pid that exists", () => {
		// The exact hole R4 named: `exit 1 + empty stdout` was read as absence, but
		// ps can exit 1 for target-specific reasons while writing the diagnosis to
		// stderr, which the probe discards. A live lead was declared dead.
		//
		// kill(pid,0) proves this pid exists, so the ps failure below must classify
		// as `probe_unavailable` -- never `pid_absent`.
		const root = mkdtempSync(join(tmpdir(), "fly1503-ps-target-fail-"));
		try {
			const failing = join(root, "ps");
			// Mimics the real failure mode: status 1, nothing on stdout, diagnosis on
			// stderr where the probe cannot see it.
			writeFileSync(
				failing,
				'#!/bin/sh\necho "ps: permission denied for that pid" >&2\nexit 1\n',
				{ mode: 0o755 },
			);
			const probed = probeProcessStartWithBin(process.pid, failing);
			expect(probed.status).toBe("unavailable");
			expect(probed.status === "unavailable" ? probed.reason : "").toContain(
				"for a pid that exists",
			);
			// And the takeover gate refuses on that state.
			expect(classifySessionProcess(probed, "whatever")).toBe(
				"probe_unavailable",
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("reports absent only for a pid the kernel says does not exist", () => {
		// pid_max is 99998 on macOS, so this can never name a live process, and the
		// answer must come from ESRCH rather than from parsing ps.
		expect(probeProcessStart(4_194_303)).toEqual({ status: "absent" });
		expect(probeProcessStart(process.pid).status).toBe("present");
	});
});

describe("FLY-1503 / Codex R3 HIGH-1 — four-state adjudication", () => {
	it("only reads a different process or an absent pid as death", () => {
		expect(
			classifySessionProcess(
				{ status: "present", startIdentity: "same" },
				"same",
			),
		).toBe("same_process");
		expect(
			classifySessionProcess(
				{ status: "present", startIdentity: "other" },
				"same",
			),
		).toBe("different_process");
		expect(classifySessionProcess({ status: "absent" }, "same")).toBe(
			"pid_absent",
		);
		expect(
			classifySessionProcess({ status: "unavailable", reason: "x" }, "same"),
		).toBe("probe_unavailable");
	});
});
