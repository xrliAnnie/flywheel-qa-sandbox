/**
 * FLY-1393 QA — regression for the adjudicated MEDIUM
 * `w1-absent-mapped-to-dead` with a REAL tmux server. Uses the production
 * classifier and drives the REAL reconcileStaleApprovedShip.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
	classifyStaleShipRunnerLiveness,
	reconcileStaleApprovedShip,
} from "../../../../packages/teamlead/src/bridge/stale-approved-ship-reconciler.ts";
import { probeRunnerProcessLiveness } from "../../../../packages/teamlead/src/bridge/tmux-lookup.ts";

const pexec = promisify(execFile);
const SOCK = `/tmp/fly1393-qa-${process.pid}`;
const tmux = (args: string[]) =>
	pexec("tmux", ["-L", SOCK.split("/").pop()!, ...args]);
const realRunner = async (args: string[]) => {
	const { stdout } = await tmux(args);
	return { stdout };
};

async function run() {
	// Isolated tmux server; live window + a remain-on-exit corpse window.
	await tmux(["new-session", "-d", "-s", "s", "-x", "80", "-y", "24"]).catch(
		() => {},
	);
	await tmux(["new-window", "-t", "s:", "-n", "live", "sleep 600"]);
	// Create the pane alive first, then enable remain-on-exit before terminating
	// its shell. Starting directly with `true` races window removal and can turn
	// the intended dead-pin fixture into `absent` before the option is applied.
	await tmux(["new-window", "-d", "-t", "s:", "-n", "corpse", "sleep 600"]);
	await tmux(["set-option", "-w", "-t", "s:corpse", "remain-on-exit", "on"]);
	await tmux(["send-keys", "-t", "s:corpse", "C-c"]);
	await new Promise((r) => setTimeout(r, 700));

	const vLive = await probeRunnerProcessLiveness("s:live", realRunner);
	const vCorpse = await probeRunnerProcessLiveness("s:corpse", realRunner);
	const vAbsent = await probeRunnerProcessLiveness(
		"s:does_not_exist",
		realRunner,
	);

	const mappedLive = classifyStaleShipRunnerLiveness(vLive);
	const mappedCorpse = classifyStaleShipRunnerLiveness(vCorpse);
	const mappedAbsent = classifyStaleShipRunnerLiveness(vAbsent);
	console.log(
		`REAL tmux verdicts: live=${vLive} corpse=${vCorpse} absent=${vAbsent}`,
	);
	console.log(
		`mapped: live=${mappedLive} corpse=${mappedCorpse} absent=${mappedAbsent}`,
	);

	// Drive the REAL reconciler with the production mapping for an ABSENT runner
	// (== a healthy runner whose CommDB tmux_window mapping went stale).
	const deadAlerts: string[] = [];
	const rewoken: string[] = [];
	const diagnoses: string[] = [];
	const session = {
		execution_id: "E-absent",
		issue_id: "FLY-1393",
		project_name: "flywheel",
		review_question_id: "Q1",
		pr_head_sha: "abc",
		status: "approved_to_ship",
		last_activity_at: "2020-01-01 00:00:00",
	} as any;
	const res = await reconcileStaleApprovedShip({
		sessions: [session],
		nowMs: 10_000_000_000_000,
		graceMs: 0,
		backoffMs: 60_000,
		backoff: new Map(),
		deadAlerted: new Set(),
		probe: async () => mappedAbsent,
		reWake: async () => {
			rewoken.push("E-absent");
		},
		alertDead: async () => {
			deadAlerts.push("E-absent");
			return true;
		},
		diagnose: (_session, reason) => {
			diagnoses.push(reason);
		},
	} as any);

	console.log(
		`RECONCILER on absent-runner: deadAlerts=${JSON.stringify(deadAlerts)} rewoken=${JSON.stringify(rewoken)} diagnoses=${JSON.stringify(diagnoses)} res=${JSON.stringify(res)}`,
	);
	const pass =
		mappedLive === "alive" &&
		mappedCorpse === "dead" &&
		mappedAbsent === "indeterminate" &&
		deadAlerts.length === 0 &&
		rewoken.length === 1 &&
		diagnoses.includes("indeterminate");
	console.log(
		pass
			? "PASS: absent is diagnose-only + harmless reWake; only dead_pin declares death"
			: "FAIL: production classifier or real-tmux dead-pin fixture did not meet the four-state contract",
	);

	await tmux(["kill-server"]).catch(() => {});
	process.exit(pass ? 0 : 2);
}
run().catch(async (e) => {
	console.error(e);
	await tmux(["kill-server"]).catch(() => {});
	process.exit(3);
});
