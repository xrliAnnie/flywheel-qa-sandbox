import { execFile, spawn } from "node:child_process";
import {
	accessSync,
	closeSync,
	constants,
	existsSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import {
	deployArguments,
	drillArguments,
	parseRoomDeploy,
	parseRoomDrill,
	QaRoomError,
} from "./qa-room-contract.js";
import type { QaRoom, QaRoomOperation } from "./qa-room-store.js";

export interface RoomInfo {
	slot: number;
	port: number;
	bridgeUrl: string;
	slotDir: string;
	projectName: string;
	[key: string]: unknown;
}
export interface RoomJobReceipt {
	operation_id: string;
	phase_reached: string;
	exit_code: number;
	finished_at: string;
	evidence_copy?: "ok" | "failed" | "empty";
	failure_reason?: string;
}
export interface RoomJobObservation {
	alive: boolean;
	phase?: string;
	receipt?: RoomJobReceipt;
}
export interface QaRoomRuntime {
	occupied(slot: number): boolean;
	claim(room: QaRoom, slots: number[]): boolean;
	release(room: QaRoom, slots: number[]): number[];
	start(room: QaRoom, op: QaRoomOperation): number;
	drillPhaseBound(room: QaRoom): number;
	observe(op: QaRoomOperation): Promise<RoomJobObservation>;
	terminate(op: QaRoomOperation): Promise<void>;
	verifyDeploy(room: QaRoom, op: QaRoomOperation): Promise<RoomInfo>;
	residue(
		room: QaRoom,
		slots: number[],
	): Promise<{ ok: boolean; details: string[] }>;
	removeSource(room: QaRoom): Promise<void>;
	evidence(op: QaRoomOperation): string | null;
	logTail(op: QaRoomOperation): string[];
}
export function driverPhaseBound(source: string): number {
	const waits = source
		.split("\n")
		.filter((line) => line.includes("await waitFor(")).length;
	if (!waits) throw new QaRoomError("driver_shape_unknown");
	return waits + 1;
}
export function minimalRoomEnvironment(
	ambient: NodeJS.ProcessEnv,
	toolDirs: string[],
	room: QaRoom,
	test: Record<string, unknown>,
): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {
		HOME: ambient.HOME,
		USER: ambient.USER,
		LOGNAME: ambient.LOGNAME,
		SHELL: "/bin/bash",
		LANG: "en_US.UTF-8",
		LC_ALL: "en_US.UTF-8",
		TMPDIR: "/tmp/",
		PATH: [
			...new Set([...toolDirs, "/usr/bin", "/bin", "/usr/sbin", "/sbin"]),
		].join(":"),
		FLYWHEEL_QA_ROOM_ID: room.room_id,
		FLYWHEEL_QA_ROOM_CLAIM: room.claim_token,
	};
	for (const [key, values] of Object.entries({
		TEST_REPLY_BY_ISSUE: ["0", "1"],
		TEST_BRIDGE_DEPT_SCOPE_REJECT: ["on", "off"],
		TEST_CODEX_LEAD_OUTBOUND_MODE: ["direct", "bridge"],
	})) {
		if (typeof test[key] === "string" && values.includes(test[key]))
			env[key] = test[key];
	}
	return env;
}
function present(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}
function read(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}
function readJson(path: string): Record<string, unknown> | undefined {
	try {
		const value = JSON.parse(read(path) ?? "null");
		return value !== null && typeof value === "object" && !Array.isArray(value)
			? value
			: undefined;
	} catch {
		return undefined;
	}
}
function toolDirectories(env: NodeJS.ProcessEnv): string[] {
	return ["node", "pnpm", "git", "jq", "tmux", "python3", "gh", "sqlite3"]
		.map((tool) => {
			const path = (env.PATH ?? "")
				.split(":")
				.filter(Boolean)
				.map((dir) => join(dir, tool))
				.find((file) => {
					try {
						accessSync(file, constants.X_OK);
						return true;
					} catch {
						return false;
					}
				});
			return path ? dirname(path) : undefined;
		})
		.filter((value): value is string => value !== undefined);
}
export function parseRoomOutput(stdout: string, slot: number): RoomInfo {
	const lines = stdout.trimEnd().split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		if (!lines[i]?.startsWith("{")) continue;
		try {
			const value = JSON.parse(lines.slice(i).join("\n"));
			if (
				value === null ||
				typeof value !== "object" ||
				value.slot !== slot ||
				!Number.isInteger(value.port) ||
				value.port < 1 ||
				value.port > 65535 ||
				(value.bridgeUrl !== `http://127.0.0.1:${value.port}` &&
					value.bridgeUrl !== `http://localhost:${value.port}`) ||
				value.slotDir !== `/tmp/flywheel-test-slot-${slot}` ||
				typeof value.projectName !== "string" ||
				!/^[A-Za-z0-9._-]+$/.test(value.projectName) ||
				[".", ".."].includes(value.projectName)
			)
				throw new Error();
			return value as RoomInfo;
		} catch {
			/* Earlier line may begin the complete final object. */
		}
	}
	throw new QaRoomError("invalid_room_json");
}
interface LocalOptions {
	repoRoot: string;
	lockRoot?: string;
	evidenceRoot?: string;
	env?: NodeJS.ProcessEnv;
	exec?: (command: string, args: string[]) => Promise<string>;
	fetch?: typeof fetch;
	signal?: (pid: number, signal: NodeJS.Signals) => void;
	sleep?: (ms: number) => Promise<void>;
}
export class LocalQaRoomRuntime implements QaRoomRuntime {
	private readonly exec: (command: string, args: string[]) => Promise<string>;
	private readonly ambient: NodeJS.ProcessEnv;
	private readonly toolDirs: string[];
	constructor(private readonly options: LocalOptions) {
		this.ambient = options.env ?? process.env;
		this.toolDirs = toolDirectories(this.ambient);
		this.exec =
			options.exec ??
			(async (command, args) =>
				(
					await promisify(execFile)(command, args, {
						timeout: 15_000,
						maxBuffer: 8 * 1024 * 1024,
						encoding: "utf8",
					})
				).stdout);
	}
	private lock(slot: number) {
		return join(
			this.options.lockRoot ?? "/tmp",
			`flywheel-test-slot-${slot}.lock`,
		);
	}
	private slots(room: QaRoom, slots: number[]) {
		return [
			room.slot,
			...slots.filter((slot) => slot !== room.slot).sort((a, b) => a - b),
		];
	}
	private own(room: QaRoom, slot: number, slots?: number[]): boolean {
		const lock = this.lock(slot);
		const file = join(lock, "service-claim");
		if (
			!present(lock) ||
			lstatSync(lock).isSymbolicLink() ||
			!present(file) ||
			!lstatSync(file).isFile() ||
			lstatSync(file).isSymbolicLink()
		)
			return false;
		const claim = readJson(file);
		return (
			claim?.room_id === room.room_id &&
			claim.claim_token === room.claim_token &&
			(!slots ||
				JSON.stringify(claim.slots) === JSON.stringify(this.slots(room, slots)))
		);
	}
	occupied(slot: number) {
		return present(this.lock(slot));
	}
	claim(room: QaRoom, slots: number[]): boolean {
		try {
			for (const slot of [...slots].sort((a, b) => a - b)) {
				if (this.occupied(slot)) {
					if (this.own(room, slot, slots)) continue;
					throw new Error("slot_taken");
				}
				mkdirSync(this.lock(slot), { mode: 0o700 });
				writeFileSync(
					join(this.lock(slot), "service-claim"),
					`${JSON.stringify({ room_id: room.room_id, claim_token: room.claim_token, slots: this.slots(room, slots) })}\n`,
					{ mode: 0o600, flag: "wx" },
				);
				writeFileSync(join(this.lock(slot), "pid"), "claiming\n", {
					mode: 0o600,
					flag: "wx",
				});
			}
			return true;
		} catch {
			// Only claims bearing our immutable token can be removed. A crash
			// before publishing the token remains occupied for manual diagnosis.
			for (const slot of slots)
				if (this.own(room, slot))
					rmSync(this.lock(slot), { recursive: true, force: true });
			return false;
		}
	}
	release(room: QaRoom, slots: number[]): number[] {
		const conflicts: number[] = [];
		for (const slot of slots) {
			if (!this.occupied(slot)) continue;
			if (!this.own(room, slot)) {
				conflicts.push(slot);
				continue;
			}
			try {
				rmSync(this.lock(slot), { recursive: true });
			} catch {
				conflicts.push(slot);
			}
		}
		return conflicts;
	}
	drillPhaseBound(room: QaRoom): number {
		try {
			return driverPhaseBound(
				readFileSync(
					join(room.src_dir, "scripts/qa-529-generalized-e2e.mjs"),
					"utf8",
				),
			);
		} catch {
			throw new QaRoomError("driver_shape_unknown");
		}
	}
	start(room: QaRoom, op: QaRoomOperation): number {
		mkdirSync(op.operation_dir, { recursive: true, mode: 0o700 });
		const request = JSON.parse(room.request_json);
		const args = [
			join(this.options.repoRoot, "scripts/lib/qa-room-job.sh"),
			op.kind,
			op.operation_dir,
		];
		if (op.kind === "deploy")
			args.push(
				room.head,
				room.src_dir,
				this.options.repoRoot,
				"--",
				...deployArguments(
					parseRoomDeploy(request, Number.MAX_SAFE_INTEGER),
					room.slot,
				),
			);
		else if (op.kind === "drill") {
			args.push(
				room.src_dir,
				`/tmp/flywheel-test-slot-${room.slot}`,
				"--",
				...drillArguments(
					parseRoomDrill(JSON.parse(op.request_json)),
					room.slot,
				),
			);
		} else {
			const info = room.deploy_json
				? JSON.parse(room.deploy_json)
				: {
						slot: room.slot,
						slotDir: `/tmp/flywheel-test-slot-${room.slot}`,
						projectName: `test-slot-${room.slot}`,
					};
			writeFileSync(join(op.operation_dir, "room.json"), JSON.stringify(info), {
				mode: 0o600,
			});
			args.push(
				room.src_dir,
				String(room.slot),
				this.options.evidenceRoot ??
					join(this.ambient.HOME ?? "", ".flywheel/qa-evidence/rooms"),
			);
			if (JSON.parse(op.request_json).skip_snapshot)
				args.push("--skip-snapshot");
		}
		const output = openSync(join(op.operation_dir, "stdout"), "a", 0o600);
		let error: number | undefined;
		try {
			error = openSync(join(op.operation_dir, "stderr"), "a", 0o600);
			const child = spawn("/bin/bash", args, {
				detached: true,
				stdio: ["ignore", output, error],
				env: minimalRoomEnvironment(
					this.ambient,
					this.toolDirs,
					room,
					request.env ?? {},
				),
			});
			child.once("error", () => {
				/* Missing owner/receipt is reconciled as interrupted. */
			});
			if (child.pid === undefined) throw new QaRoomError("spawn_failed");
			child.unref();
			return child.pid;
		} finally {
			closeSync(output);
			if (error !== undefined) closeSync(error);
		}
	}
	async observe(op: QaRoomOperation): Promise<RoomJobObservation> {
		const raw = readJson(join(op.operation_dir, "receipt.json"));
		const receipt =
			raw &&
			typeof raw.operation_id === "string" &&
			typeof raw.phase_reached === "string" &&
			Number.isInteger(raw.exit_code) &&
			typeof raw.finished_at === "string"
				? (raw as unknown as RoomJobReceipt)
				: undefined;
		const phase = read(join(op.operation_dir, "phase"))?.trim();
		const owner = readJson(join(op.operation_dir, "owner.json"));
		const processes = await this.processes();
		let alive = false;
		if (
			owner?.operation_id === op.operation_id &&
			Number.isInteger(owner.pid) &&
			Number(owner.pid) > 0 &&
			typeof owner.lstart === "string"
		) {
			alive = processes.some(
				(p) =>
					p.pid === owner.pid &&
					p.started === this.started(owner.lstart as string),
			);
		} else {
			// Covers a Bridge death between spawn and owner publication without
			// repeating the operation. Observation errors propagate; not evidence of death.
			alive = processes.some((p) => this.jobCommand(p.command, op));
		}
		// A dead wrapper does not prove that its detached job group is gone.
		const groupId =
			owner?.operation_id === op.operation_id ? Number(owner.pid) : op.pid;
		if (!alive && groupId && !processes.some((p) => p.pid === groupId))
			alive = processes.some((p) => p.group === groupId);
		return { alive, phase, receipt };
	}
	private started(value: string): string {
		return value.trim().replace(/\s+/g, " ");
	}
	private jobCommand(command: string, op: QaRoomOperation): boolean {
		const args = command.split(/\s+/);
		return (
			args.some((arg) => arg.endsWith("/qa-room-job.sh")) &&
			args.includes(op.operation_dir)
		);
	}
	private async processes() {
		// Listing the table succeeds even if a selected PID has exited. Errors
		// remain observation failures rather than being mistaken for death.
		const output = await this.exec("ps", [
			"-axo",
			"pid=,pgid=,lstart=,command=",
		]);
		return output
			.split("\n")
			.filter((line) => line.trim())
			.map((line) => {
				const match =
					/^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d+)\s+(.*)$/.exec(
						line,
					);
				if (!match) throw new QaRoomError("process_observation_invalid");
				return {
					pid: Number(match[1]),
					group: Number(match[2]),
					started: this.started(match[3]!),
					command: match[4]!,
				};
			});
	}
	async terminate(op: QaRoomOperation): Promise<void> {
		let pid = op.pid;
		const owner = readJson(join(op.operation_dir, "owner.json"));
		if (
			owner?.operation_id === op.operation_id &&
			Number.isInteger(owner.pid) &&
			Number(owner.pid) > 0
		)
			pid = Number(owner.pid);
		if (!pid || pid <= 0) throw new QaRoomError("job_owner_missing");
		const before = await this.processes();
		const current = before.find((p) => p.pid === pid);
		if (!current) {
			if (before.some((p) => p.group === pid))
				throw new QaRoomError("job_group_residual");
			return;
		}
		const matches =
			owner?.operation_id === op.operation_id &&
			typeof owner.lstart === "string"
				? current.started === this.started(owner.lstart)
				: this.jobCommand(current.command, op);
		if (!matches || current.group !== pid)
			throw new QaRoomError("job_owner_changed");
		const group = before.filter((p) => p.group === pid);
		const signal =
			this.options.signal ??
			((target: number, kind: NodeJS.Signals) => {
				try {
					process.kill(target, kind);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
				}
			});
		signal(-pid, "SIGTERM");
		await (
			this.options.sleep ??
			((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
		)(10_000);
		const after = await this.processes();
		// The wrapper may exit on TERM while build children remain. Escalate
		// only while an observed member still anchors the original group.
		if (
			after.some(
				(p) =>
					p.group === pid &&
					group.some((old) => old.pid === p.pid && old.started === p.started),
			)
		) {
			signal(-pid, "SIGKILL");
			const remaining = await this.processes();
			const newLeader = remaining.find((p) => p.pid === pid);
			const reused = newLeader && newLeader.started !== current.started;
			if (!reused && remaining.some((p) => p.group === pid))
				throw new QaRoomError("job_group_residual");
		} else if (
			!after.some((p) => p.pid === pid) &&
			after.some((p) => p.group === pid)
		) {
			throw new QaRoomError("job_group_residual");
		}
	}
	async verifyDeploy(room: QaRoom, op: QaRoomOperation): Promise<RoomInfo> {
		const info = parseRoomOutput(
			read(join(op.operation_dir, "stdout")) ?? "",
			room.slot,
		);
		let response: Response;
		try {
			response = await (this.options.fetch ?? fetch)(
				`${info.bridgeUrl}/health`,
				{ signal: AbortSignal.timeout(5000) },
			);
		} catch {
			throw new QaRoomError("health_unavailable");
		}
		if (!response.ok) throw new QaRoomError("health_unavailable");
		const health = (await response.json()) as Record<string, unknown>;
		const request = JSON.parse(room.request_json);
		if (
			health.buildSha !== room.head ||
			(request.generalized &&
				(health.buildMode !== "built" || health.artifactBuildSha !== room.head))
		)
			throw new QaRoomError("build_sha_mismatch");
		return info;
	}
	async residue(
		room: QaRoom,
		slots: number[],
	): Promise<{ ok: boolean; details: string[] }> {
		const details: string[] = [];
		for (const slot of slots) {
			if (
				!this.own(room, slot, slots) ||
				read(join(this.lock(slot), "pid"))?.trim() !== "service-cleaned"
			)
				details.push(`claim_not_cleaned:${slot}`);
			if (present(`/tmp/flywheel-test-slot-${slot}`))
				details.push(`slot_directory:${slot}`);
		}
		const [launchd, processes] = await Promise.all([
			this.exec("launchctl", ["list"]),
			this.exec("ps", ["-axo", "pid=,command="]),
		]);
		for (const line of launchd.split("\n"))
			if (
				slots.some((slot) =>
					line
						.trim()
						.split(/\s+/)
						.at(-1)
						?.startsWith(`com.flywheel.qa.lead.slot-${slot}.`),
				)
			)
				details.push(`launchd:${line.trim()}`);
		for (const line of processes.split("\n"))
			if (
				slots.some((slot) =>
					new RegExp(`/tmp/flywheel-test-slot-${slot}(?:[/\\s]|$)`).test(line),
				)
			)
				details.push(`process:${line.trim()}`);
		return { ok: details.length === 0, details };
	}
	async removeSource(room: QaRoom): Promise<void> {
		if (existsSync(room.src_dir))
			await this.exec("git", [
				"-C",
				this.options.repoRoot,
				"worktree",
				"remove",
				"--force",
				room.src_dir,
			]);
		await this.exec("git", ["-C", this.options.repoRoot, "worktree", "prune"]);
	}
	evidence(op: QaRoomOperation): string | null {
		return read(join(op.operation_dir, "evidence-dir"))?.trim() || null;
	}
	logTail(op: QaRoomOperation): string[] {
		const stderr = (read(join(op.operation_dir, "stderr")) ?? "").split("\n");
		const lines = (
			op.kind === "drill"
				? [
						...(read(join(op.operation_dir, "stdout")) ?? "")
							.split("\n")
							.filter((line) => line.startsWith("[qa529]")),
						...stderr.filter(Boolean),
					]
				: stderr.filter((line) =>
						/^\[(test-deploy|test-teardown|qa-room-job)\]/.test(line),
					)
		).slice(-40);
		while (Buffer.byteLength(lines.join("\n")) > 8192) lines.shift();
		return lines;
	}
}
