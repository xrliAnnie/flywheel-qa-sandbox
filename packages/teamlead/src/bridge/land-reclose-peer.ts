import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import {
	dirname,
	isAbsolute,
	join,
	normalize,
	parse,
	resolve,
} from "node:path";
import { resolveLeadIdentityRow } from "flywheel-comm/lead-identity";
import {
	LeadLeaseStore,
	validateClaudeLeadLeaseAuthorization,
} from "flywheel-comm/lead-lease";
import type { LandOperationRow, StateStore } from "../StateStore.js";
import type {
	ReclosePeerNativeAdapter,
	ReclosePeerSnapshot,
	RecloseProcessSnapshot,
} from "./reclose-peer-native.js";

const REQUEST_LIMIT = 65_536;
const MAX_CONNECTIONS = 8;
const CONNECTION_TIMEOUT_MS = 30_000;

export interface LandReclosePeerRequest {
	schemaVersion: 1;
	method: "land.reclose";
	operationId: string;
	expectedResumeGeneration: number;
	expectedApprovedHead: string;
	reason: string;
	requestId: string;
	projectName: string;
	leadId: string;
}

export type LandRecloseResult =
	| { ok: true; operation: LandOperationRow; alreadyCompleted?: true }
	| { ok: false; reason: string };

interface VerifiedRecloseActor {
	actor: string;
	assertCurrent(): void;
}

interface ConnectionState {
	handle: number;
	acceptedAt: number;
	processing: boolean;
}

export interface LandReclosePeerServer {
	socketPath: string;
	close(): void;
}

export interface StartLandReclosePeerServerInput {
	adapter: ReclosePeerNativeAdapter;
	socketPath: string;
	store: StateStore;
	resume(input: {
		operationId: string;
		actor: string;
		reason: string;
		mode: "closeout_only";
		expectedResumeGeneration: number;
		expectedApprovedHead: string;
		requestId: string;
		authorityCheck?: () => void | Promise<void>;
	}): Promise<LandRecloseResult>;
	kick(operationId: string): void;
	authorize?: (
		connectionHandle: number,
		request: LandReclosePeerRequest,
		operation: LandOperationRow,
	) => VerifiedRecloseActor;
	now?: () => number;
	pollIntervalMs?: number;
	projectsPath?: string;
	homeDir?: string;
	leaseDbPath?: string;
	runnerRootPids?: () => ReadonlySet<number>;
}

const object = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);

function peerError(error: unknown, fallback: string): string {
	if (object(error) && typeof error.code === "string") return error.code;
	return fallback;
}

export function parseLandReclosePeerRequest(
	value: unknown,
): LandReclosePeerRequest {
	if (
		!object(value) ||
		Object.keys(value).some(
			(key) =>
				![
					"schemaVersion",
					"method",
					"operationId",
					"expectedResumeGeneration",
					"expectedApprovedHead",
					"reason",
					"requestId",
					"projectName",
					"leadId",
				].includes(key),
		) ||
		value.schemaVersion !== 1 ||
		value.method !== "land.reclose" ||
		typeof value.operationId !== "string" ||
		!value.operationId.trim() ||
		value.operationId.length > 512 ||
		!Number.isSafeInteger(value.expectedResumeGeneration) ||
		(value.expectedResumeGeneration as number) < 0 ||
		typeof value.expectedApprovedHead !== "string" ||
		!/^[0-9a-f]{40}$/.test(value.expectedApprovedHead) ||
		typeof value.reason !== "string" ||
		!value.reason.trim() ||
		value.reason.length > 500 ||
		typeof value.requestId !== "string" ||
		!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
			value.requestId,
		) ||
		typeof value.projectName !== "string" ||
		!value.projectName.trim() ||
		value.projectName.length > 128 ||
		typeof value.leadId !== "string" ||
		!value.leadId.trim() ||
		value.leadId.length > 256
	) {
		throw Object.assign(new Error("request_invalid"), {
			code: "request_invalid",
		});
	}
	return {
		...(value as unknown as LandReclosePeerRequest),
		operationId: value.operationId.trim(),
		reason: value.reason.trim(),
		projectName: value.projectName.trim(),
		leadId: value.leadId.trim(),
	};
}

function assertPrivateSocketPath(socketPath: string): void {
	if (
		!isAbsolute(socketPath) ||
		normalize(socketPath) !== socketPath ||
		socketPath.includes("\0") ||
		Buffer.byteLength(socketPath) > 100
	) {
		throw Object.assign(new Error("peer_socket_invalid"), {
			code: "peer_socket_invalid",
		});
	}
	const parent = dirname(socketPath);
	mkdirSync(parent, { recursive: true, mode: 0o700 });
	const root = parse(parent).root;
	let cursor = root;
	for (const segment of parent.slice(root.length).split("/").filter(Boolean)) {
		cursor = join(cursor, segment);
		const stat = lstatSync(cursor);
		if (stat.isSymbolicLink() || !stat.isDirectory()) {
			throw Object.assign(new Error("peer_socket_parent_untrusted"), {
				code: "peer_socket_parent_untrusted",
			});
		}
	}
	const parentStat = lstatSync(parent);
	if (
		realpathSync(parent) !== parent ||
		(process.getuid !== undefined && parentStat.uid !== process.getuid()) ||
		(parentStat.mode & 0o777) !== 0o700
	) {
		throw Object.assign(new Error("peer_socket_parent_untrusted"), {
			code: "peer_socket_parent_untrusted",
		});
	}
}

export function collectVerifiedPeerChain(input: {
	peer: ReclosePeerSnapshot;
	holderPid: number;
	adapter: Pick<ReclosePeerNativeAdapter, "inspectProcess">;
	runnerRootPids: ReadonlySet<number>;
}): RecloseProcessSnapshot[] {
	const chain: RecloseProcessSnapshot[] = [input.peer];
	const seen = new Set<number>();
	let current: RecloseProcessSnapshot = input.peer;
	for (let depth = 0; depth < 64; depth++) {
		if (seen.has(current.pid)) throw Error("peer_ancestry_indeterminate");
		seen.add(current.pid);
		if (input.runnerRootPids.has(current.pid))
			throw Error("runner_peer_forbidden");
		if (current.pid === input.holderPid) return chain;
		if (current.parentPid <= 1) throw Error("peer_ancestry_indeterminate");
		let parent: RecloseProcessSnapshot;
		try {
			parent = input.adapter.inspectProcess(current.parentPid);
		} catch {
			throw Error("peer_ancestry_indeterminate");
		}
		if (parent.uniqueId !== current.parentUniqueId) {
			throw Error("peer_ancestry_indeterminate");
		}
		chain.push(parent);
		current = parent;
	}
	throw Error("peer_ancestry_indeterminate");
}

function defaultRunnerRootPids(): ReadonlySet<number> {
	try {
		const output = execFileSync(
			"tmux",
			[
				"list-panes",
				"-a",
				"-F",
				"#{pane_pid}\t#{session_name}\t#{window_name}",
			],
			{ encoding: "utf8", timeout: 2_000 },
		);
		const pids = new Set<number>();
		for (const line of output.split("\n")) {
			const [pidText, sessionName = "", windowName = ""] = line.split("\t");
			const pid = Number(pidText);
			if (
				Number.isSafeInteger(pid) &&
				pid > 0 &&
				(sessionName.startsWith("runner-") || windowName.startsWith("runner-"))
			) {
				pids.add(pid);
			}
		}
		return pids;
	} catch {
		throw Error("peer_ancestry_indeterminate");
	}
}

function processStartMatches(pid: number, expected: string): boolean {
	try {
		return (
			execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
				encoding: "utf8",
				timeout: 2_000,
			}).trim() === expected.trim()
		);
	} catch {
		return false;
	}
}

function createDefaultAuthorizer(input: StartLandReclosePeerServerInput) {
	const homeDir = resolve(input.homeDir ?? process.env.HOME ?? homedir());
	const projectsPath = resolve(
		input.projectsPath ??
			process.env.FLYWHEEL_PROJECTS_FILE ??
			join(homeDir, ".flywheel", "projects.json"),
	);
	const leaseDbPath = resolve(
		input.leaseDbPath ??
			process.env.FLYWHEEL_LEAD_LEASE_DB ??
			join(homeDir, ".flywheel", "lead-lease.db"),
	);
	return (
		connectionHandle: number,
		request: LandReclosePeerRequest,
		operation: LandOperationRow,
	): VerifiedRecloseActor => {
		if (operation.project_name !== request.projectName) {
			throw Error("peer_scope_mismatch");
		}
		const row = resolveLeadIdentityRow({
			projectsPath,
			homeDir,
			projectName: request.projectName,
			leadId: request.leadId,
		});
		if (row.identity.backend !== "claude-code") {
			throw Error("claude_reclose_peer_transport_required");
		}
		const leaseStore = new LeadLeaseStore(leaseDbPath);
		const lease = (() => {
			try {
				return leaseStore.getLease(row.identity.leadKey);
			} finally {
				leaseStore.close();
			}
		})();
		if (
			!lease ||
			lease.project !== request.projectName ||
			lease.leadId !== request.leadId ||
			lease.identityDigest !== row.identity.identityDigest ||
			!lease.holderPid ||
			!lease.holderStart ||
			lease.generation <= 0
		) {
			throw Error("claude_lease_unverified");
		}
		const authorizationEnv = {
			...process.env,
			HOME: homeDir,
			FLYWHEEL_PROJECTS_FILE: projectsPath,
			FLYWHEEL_PROJECT_NAME: request.projectName,
			FLYWHEEL_LEAD_IDENTITY_DIGEST: row.identity.identityDigest,
			FLYWHEEL_LEAD_LEASE_DB: leaseDbPath,
			FLYWHEEL_LEAD_LEASE_KEY: row.identity.leadKey,
			FLYWHEEL_LEAD_GENERATION: String(lease.generation),
		};
		const validateLease = () => {
			const validated = validateClaudeLeadLeaseAuthorization(
				{ claimedLeadId: request.leadId, env: authorizationEnv },
				{ processAliveWithStart: processStartMatches },
			);
			if (
				!validated.valid ||
				validated.holderPid !== lease.holderPid ||
				validated.holderStart !== lease.holderStart ||
				validated.generation !== lease.generation
			) {
				throw Error("claude_lease_unverified");
			}
			return validated;
		};
		const runnerRoots = input.runnerRootPids ?? defaultRunnerRootPids;
		const observe = () => {
			const validated = validateLease();
			const peer = input.adapter.revalidatePeer(connectionHandle);
			const chain = collectVerifiedPeerChain({
				peer,
				holderPid: validated.holderPid,
				adapter: input.adapter,
				runnerRootPids: runnerRoots(),
			});
			return {
				validated,
				peer,
				chain,
				pin: JSON.stringify({
					leadKey: validated.leadKey,
					generation: validated.generation,
					holderPid: validated.holderPid,
					holderStart: validated.holderStart,
					peer,
					chain,
				}),
			};
		};
		const initial = observe();
		const identityDigest = createHash("sha256")
			.update(
				JSON.stringify([
					initial.pin,
					operation.operation_id,
					operation.issue_id,
					operation.approved_head,
				]),
			)
			.digest("hex");
		return Object.freeze({
			actor: `authenticated-reclose-peer:${identityDigest}`,
			assertCurrent() {
				if (observe().pin !== initial.pin)
					throw Error("peer_authority_changed");
			},
		});
	};
}

export function startLandReclosePeerServer(
	input: StartLandReclosePeerServerInput,
): LandReclosePeerServer {
	assertPrivateSocketPath(input.socketPath);
	const listenerHandle = input.adapter.createListener(input.socketPath);
	const connections = new Map<number, ConnectionState>();
	const now = input.now ?? Date.now;
	const authorize = input.authorize ?? createDefaultAuthorizer(input);
	let closed = false;

	const closeConnection = (handle: number) => {
		connections.delete(handle);
		try {
			input.adapter.close(handle);
		} catch {
			// The native handle may already have been closed during a failed read.
		}
	};
	const respond = (handle: number, body: unknown) => {
		try {
			input.adapter.writeFrame(handle, JSON.stringify(body));
		} catch (error) {
			console.warn(
				`[land-reclose-peer] response write failed: ${peerError(error, "peer_write_failed")}`,
			);
		} finally {
			closeConnection(handle);
		}
	};
	const processRequest = async (state: ConnectionState, frame: string) => {
		state.processing = true;
		let requestId: string | null = null;
		try {
			const request = parseLandReclosePeerRequest(JSON.parse(frame));
			requestId = request.requestId;
			const operation = input.store.getLandOperation(request.operationId);
			if (!operation) throw Error("land_operation_not_found");
			const verified = authorize(state.handle, request, operation);
			verified.assertCurrent();
			const result = await input.resume({
				operationId: request.operationId,
				actor: verified.actor,
				reason: request.reason,
				mode: "closeout_only",
				expectedResumeGeneration: request.expectedResumeGeneration,
				expectedApprovedHead: request.expectedApprovedHead,
				requestId: request.requestId,
				authorityCheck: () => verified.assertCurrent(),
			});
			if (!result.ok) {
				respond(state.handle, {
					requestId,
					ok: false,
					error: result.reason,
				});
				return;
			}
			if (!result.alreadyCompleted) input.kick(request.operationId);
			respond(state.handle, {
				requestId,
				ok: true,
				operation: result.operation,
				...(result.alreadyCompleted ? { already_completed: true } : {}),
			});
		} catch (error) {
			respond(state.handle, {
				requestId,
				ok: false,
				error: peerError(error, "reclose_peer_rejected"),
			});
		}
	};
	const poll = () => {
		if (closed) return;
		try {
			while (connections.size < MAX_CONNECTIONS) {
				const handle = input.adapter.accept(listenerHandle);
				if (handle === null) break;
				connections.set(handle, {
					handle,
					acceptedAt: now(),
					processing: false,
				});
			}
		} catch (error) {
			console.warn(
				`[land-reclose-peer] accept failed: ${peerError(error, "peer_accept_failed")}`,
			);
		}
		for (const state of [...connections.values()]) {
			if (state.processing) continue;
			if (now() - state.acceptedAt > CONNECTION_TIMEOUT_MS) {
				respond(state.handle, {
					requestId: null,
					ok: false,
					error: "broker_connection_timeout",
				});
				continue;
			}
			try {
				const result = input.adapter.readFrame(state.handle, REQUEST_LIMIT);
				if (result.complete) void processRequest(state, result.frame);
			} catch (error) {
				respond(state.handle, {
					requestId: null,
					ok: false,
					error: peerError(error, "request_invalid"),
				});
			}
		}
	};
	const timer = setInterval(poll, input.pollIntervalMs ?? 10);
	timer.unref?.();
	return {
		socketPath: input.socketPath,
		close() {
			if (closed) return;
			closed = true;
			clearInterval(timer);
			for (const handle of [...connections.keys()]) closeConnection(handle);
			input.adapter.close(listenerHandle);
		},
	};
}
