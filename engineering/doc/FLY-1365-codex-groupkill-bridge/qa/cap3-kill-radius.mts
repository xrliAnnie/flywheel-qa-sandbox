/**
 * QA·FLY-1365 — Capability ③ (kill radius / self-group protection)
 *
 * Drives the REAL production factory `createDefaultKillGroup` (imported from source).
 * Proves:
 *   - a legit daemon group (its own detached pgid) is signalled with `-pgid`
 *     (POSIX group signal) — radius = exactly that group, nothing wider;
 *   - the guard REFUSES pgid === pid, pgid === ppid, AND pgid === the Bridge's
 *     REAL process group (the grandparent `npm exec tsx` group — the production
 *     topology the issue was worried about);
 *   - MUTATION CONTROL: the pre-fix guard shape (pid/ppid only, no own-pgid
 *     lookup) WOULD have signalled the Bridge's real group → proving the new
 *     own-pgid guard is load-bearing, not a vacuous pass.
 */
import {
	codexDaemonExitWaitMs,
	createDefaultKillGroup,
} from "../../../../packages/claude-runner/src/codex-daemon-runtime.js";

// Simulated production topology (mirrors research.md §2.4 activebody ps):
const BRIDGE_PID = 30576;
const BRIDGE_PPID = 30339; // node tsx cli.mjs
const BRIDGE_REAL_PGID = 28163; // grandparent `npm exec tsx` — the group Bridge actually lives in
const DAEMON_OWN_PGID = 1265; // the detached codex daemon shim's own group (kill target)

type KillCall = { target: number; signal: NodeJS.Signals };

function realFactory(recorder: KillCall[]) {
	return createDefaultKillGroup({
		pid: BRIDGE_PID,
		ppid: BRIDGE_PPID,
		processGroupOf: (pid) =>
			pid === BRIDGE_PID ? BRIDGE_REAL_PGID : undefined,
		kill: (target, signal) => recorder.push({ target, signal }),
		logger: () => {},
	});
}

/** MUTATION: the OLD guard (pre-FLY-1365) only checked pid/ppid — no own-pgid. */
function oldGuardShape(recorder: KillCall[]) {
	return (pgid: number, signal: NodeJS.Signals): void => {
		if (!Number.isInteger(pgid) || pgid <= 1) return;
		if (pgid === BRIDGE_PID || pgid === BRIDGE_PPID) return;
		recorder.push({ target: -pgid, signal });
	};
}

function run(): void {
	let pass = true;
	const check = (name: string, ok: boolean, detail = "") => {
		console.log(
			`  [${ok ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`,
		);
		if (!ok) pass = false;
	};

	console.log("── Capability ③: kill radius / self-group protection ──\n");

	// 1. Legit daemon group → signalled with NEGATIVE pgid (group), nothing wider.
	{
		const calls: KillCall[] = [];
		realFactory(calls)(DAEMON_OWN_PGID, "SIGKILL");
		const ok =
			calls.length === 1 &&
			calls[0].target === -DAEMON_OWN_PGID &&
			calls[0].signal === "SIGKILL";
		check(
			"legit daemon group is killed as a group (-pgid), radius = that group only",
			ok,
			`calls=${JSON.stringify(calls)}`,
		);
	}

	// 2. pgid === Bridge's REAL process group → REFUSED (the production-topology gap).
	{
		const calls: KillCall[] = [];
		realFactory(calls)(BRIDGE_REAL_PGID, "SIGKILL");
		check(
			"REFUSES the Bridge's real (grandparent npm) process group",
			calls.length === 0,
			`calls=${JSON.stringify(calls)}`,
		);
	}

	// 3. pgid === pid and pgid === ppid → REFUSED.
	{
		const c1: KillCall[] = [];
		realFactory(c1)(BRIDGE_PID, "SIGKILL");
		check("REFUSES pgid === own pid", c1.length === 0);
		const c2: KillCall[] = [];
		realFactory(c2)(BRIDGE_PPID, "SIGKILL");
		check("REFUSES pgid === parent pid", c2.length === 0);
	}

	// 4. pgid <= 1 (0 = own group, 1 = init, negatives) → REFUSED outright.
	{
		const calls: KillCall[] = [];
		const k = realFactory(calls);
		k(0, "SIGKILL");
		k(1, "SIGKILL");
		k(-5, "SIGKILL");
		check("REFUSES pgid 0 / 1 / negative outright", calls.length === 0);
	}

	// 5. MUTATION CONTROL: the OLD guard shape would have killed the Bridge group.
	{
		const calls: KillCall[] = [];
		oldGuardShape(calls)(BRIDGE_REAL_PGID, "SIGKILL");
		const oldWouldKill =
			calls.length === 1 && calls[0].target === -BRIDGE_REAL_PGID;
		check(
			"MUTATION: pre-fix (pid/ppid-only) guard WOULD signal the Bridge group",
			oldWouldKill,
			"→ confirms the new own-pgid guard is load-bearing",
		);
	}

	// 6. Sanity: settle-window env knob (E) default + override.
	{
		const def = codexDaemonExitWaitMs({} as NodeJS.ProcessEnv);
		const overridden = codexDaemonExitWaitMs({
			FLYWHEEL_CODEX_DAEMON_EXIT_WAIT_MS: "15000",
		} as unknown as NodeJS.ProcessEnv);
		const badFallback = codexDaemonExitWaitMs({
			FLYWHEEL_CODEX_DAEMON_EXIT_WAIT_MS: "garbage",
		} as unknown as NodeJS.ProcessEnv);
		check(
			"E: settle default 10s, env override honored, bad value falls back to 10s",
			def === 10_000 && overridden === 15_000 && badFallback === 10_000,
			`def=${def} override=${overridden} bad=${badFallback}`,
		);
	}

	console.log(`\nRESULT: ${pass ? "PASS ✅" : "FAIL ❌"}`);
	process.exit(pass ? 0 : 1);
}

run();
