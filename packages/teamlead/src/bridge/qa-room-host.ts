import { readFileSync } from "node:fs";
import { cpus, homedir, loadavg } from "node:os";
import { join } from "node:path";
import { isOperationalTerminalStatus } from "../operational-terminal-status.js";
import type { StateStore } from "../StateStore.js";
import { LocalQaRoomRuntime } from "./qa-room-runtime.js";
import { QaRoomService } from "./qa-room-service.js";

export function qaRoomServiceEnabled(
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	if (env.FLYWHEEL_QA_ROOM_SERVICE !== undefined)
		return env.FLYWHEEL_QA_ROOM_SERVICE === "on";
	return !env.FLYWHEEL_ISOLATION_ROOT;
}
export function createLocalQaRoomService(
	store: StateStore,
	repoRoot: string,
	env: NodeJS.ProcessEnv = process.env,
): QaRoomService {
	const home = env.HOME || homedir();
	let slotCount = 0;
	try {
		const config = JSON.parse(
			readFileSync(join(home, ".flywheel/test-slots.json"), "utf8"),
		);
		if (Array.isArray(config.slots)) slotCount = config.slots.length;
	} catch {
		/* Missing configuration admits no deployments. */
	}
	const perCore = Number(env.FLYWHEEL_RUNNER_LOAD_PER_CORE ?? 8);
	return new QaRoomService({
		store: store.qaRooms,
		runtime: new LocalQaRoomRuntime({ repoRoot, env }),
		stateRoot: join(home, ".flywheel/state/qa-rooms"),
		slotCount,
		now: Date.now,
		load: () => loadavg()[0] ?? 0,
		threshold: () =>
			(Number.isFinite(perCore) && perCore > 0 ? perCore : 8) *
			Math.max(1, cpus().length),
		ownerTerminal: (key) => {
			if (!key.startsWith("runner:")) return false;
			const session = store.getSession(key.slice(7));
			return (
				!!session &&
				(isOperationalTerminalStatus(session.status) || !!session.terminal_at)
			);
		},
		enabled: () => qaRoomServiceEnabled(env),
		onError: (reason) => console.error(`[qa-rooms] ${reason}`),
	});
}
