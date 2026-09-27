import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type BodyObservation,
	resolveDaemonSocketPath,
} from "flywheel-claude-runner";
import { CommDB } from "flywheel-comm/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StateStore } from "../../StateStore.js";
import {
	buildCodexTerminalBodyAlert,
	createBridgeCodexTerminalSweep,
	createRolloutTokenObserver,
	unlinkOwnCodexSocket,
} from "../codex-terminal-sweep-runtime.js";

vi.mock("flywheel-claude-runner", async (importOriginal) => ({
	...(await importOriginal<typeof import("flywheel-claude-runner")>()),
	captureCodexProcessSnapshot: vi.fn(async () => ""),
}));

const THREAD = "019a0000-aaaa-bbbb-cccc-00000000abcd";

function usage(at: string, total: number): string {
	return `${JSON.stringify({
		timestamp: at,
		type: "event_msg",
		payload: {
			type: "token_count",
			info: {
				total_token_usage: {
					input_tokens: total,
					cached_input_tokens: 0,
					output_tokens: 0,
					reasoning_output_tokens: 0,
					total_tokens: total,
				},
			},
		},
	})}\n`;
}

describe("FLY-2903 terminal sweep runtime wiring", () => {
	let root: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "fly2903-sweep-rt-"));
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
		rmSync(root, { recursive: true, force: true });
	});

	it("wires body proof, current activation and every TURN alias into the production stop guard", async () => {
		vi.stubEnv("FLYWHEEL_COMM_ROOT", root);
		const store = await StateStore.create(":memory:");
		const comm = new CommDB(join(root, "fixture", "comm.db"));
		try {
			store.upsertSession({
				execution_id: "exec-live",
				issue_id: "internal-issue",
				project_name: "fixture",
				status: "running",
				adapter_type: "codex-tmux",
			});
			store.forceStatus("exec-live", "completed", "", "fixture");
			const stop = vi.fn(async () => "stopped" as const);
			let valid = true;
			const observation: BodyObservation = {
				identity: {
					executionId: "exec-live",
					activationId: null,
					generation: 1,
					lifecycleRevision: store.getSession("exec-live")!.lifecycle_revision,
					adapter: "codex-tmux",
				},
				ownerToken: "owner",
				spawnEpoch: 1,
				bindingDigest: "a".repeat(64),
				verdict: "alive",
				observedAt: new Date().toISOString(),
				expiresAt: new Date(Date.now() + 10000).toISOString(),
				reason: "fixture_body",
			};
			const bodyObserver = {
				observe: vi.fn(async () => observation),
				isCurrent: () => valid,
			};
			const make = () =>
				createBridgeCodexTerminalSweep({
					store,
					owners: { ownershipState: () => "active", requestStop: stop },
					bodyObserver,
					reapEnabled: () => true,
					alertSink: {
						current: { alert: vi.fn(async () => ({ kind: "sent" }) as never) },
					},
				});
			comm.grantTurn("FLY-2919", "exec-live", "implement", Date.now());
			const sweep = make();
			await sweep.tick();
			await sweep.tick();
			expect(stop).not.toHaveBeenCalled();
			expect(bodyObserver.observe).toHaveBeenCalledTimes(2);
			comm.deleteTurnIfCurrent(
				"FLY-2919",
				"exec-live",
				comm.getTurn("FLY-2919")!.epoch,
			);
			const activation = vi
				.spyOn(store, "listWorkflowActivationsForActor")
				.mockReturnValue([{ activation_id: "newer-activation" }] as never);
			await sweep.tick();
			expect(stop).not.toHaveBeenCalled();
			expect(store.codexTerminalClose.get("exec-live")?.state).toBe(
				"probe_unknown",
			);
			activation.mockRestore();
			valid = false;
			await sweep.tick();
			expect(stop).not.toHaveBeenCalled();
			valid = true;
			await sweep.tick();
			await sweep.tick();
			expect(stop).toHaveBeenCalledOnce();
		} finally {
			comm.close();
			store.close();
		}
	});

	it.each(["only_binding", "newer_binding", "same_timestamp"] as const)(
		"terminal-run identity fence: %s",
		async (mode) => {
			const store = await StateStore.create(":memory:");
			try {
				store.upsertSession({
					execution_id: "exec-terminal",
					issue_id: "issue",
					project_name: "fixture",
					status: "running",
					adapter_type: "codex-tmux",
				});
				store.forceStatus("exec-terminal", "completed", "", "fixture");
				const first = {
					activation_id: "activation-original",
					execution_id: "exec-terminal",
					run_id: "ended-run",
					node_id: "implement",
					attempt: 1,
					mode: "spawn" as const,
					rework_request_id: null,
					bound_at: "2026-09-26T01:00:00Z",
				};
				vi.spyOn(store, "listWorkflowActivationsForActor").mockReturnValue(
					mode === "only_binding"
						? [first]
						: [
								first,
								{
									...first,
									activation_id: "activation-new",
									bound_at:
										mode === "same_timestamp"
											? first.bound_at
											: "2026-09-26T02:00:00Z",
								},
							],
				);
				// An ended run need not qualify for the active recovery selector.
				vi.spyOn(store, "resolveCurrentWorkflowActivation").mockReturnValue({
					kind: "ambiguous",
					activationIds: [],
				});
				const observation: BodyObservation = {
					identity: {
						executionId: "exec-terminal",
						activationId: first.activation_id,
						generation: 1,
						lifecycleRevision:
							store.getSession("exec-terminal")!.lifecycle_revision,
						adapter: "codex-tmux",
					},
					ownerToken: "owner",
					spawnEpoch: 1,
					bindingDigest: "a".repeat(64),
					verdict: "dead",
					observedAt: new Date().toISOString(),
					expiresAt: new Date(Date.now() + 10000).toISOString(),
					reason: "fixture_body",
				};
				const sweep = createBridgeCodexTerminalSweep({
					store,
					owners: { ownershipState: () => "none", requestStop: vi.fn() },
					bodyObserver: {
						observe: async () => observation,
						isCurrent: () => true,
					},
					reapEnabled: () => false,
					alertSink: {},
					env: { FLYWHEEL_CODEX_DAEMON_SOCKET_ROOT: join(root, "sockets") },
				});
				await sweep.tick();
				expect(store.codexTerminalClose.get("exec-terminal")?.state).toBe(
					mode === "only_binding" ? "closed" : "probe_unknown",
				);
			} finally {
				store.close();
			}
		},
	);

	it("builds a bounded plain-text severe alert with a deterministic event id", () => {
		const alert = buildCodexTerminalBodyAlert({
			executionId: "0123456789abcdef",
			issueIdentifier: "FLY-2903<script>",
			projectName: "flywheel",
			sessionStatus: "completed",
			terminalAt: "2026-09-25 10:00:00",
			state: "alive_residual",
			tokensAfterTerminal: 1234,
			action: "reap:residual",
			alertKey: "alive_residual:3",
		});
		expect(alert).toMatchObject({
			projectName: "machine",
			eventType: "codex_terminal_body_alive",
			severity: "severe",
		});
		expect(alert.eventId).toMatch(
			/^codex_terminal_body_alive:0123456789abcdef:alive_residual:[0-9a-f]{24}$/,
		);
		expect(alert.body).toBe(
			"issue=FLY-2903_script_ exec=01234567 status=completed terminalAt=2026-09-25_10:00:00 state=alive_residual tokensAfterTerminal=1234 action=reap:residual",
		);
		expect(
			buildCodexTerminalBodyAlert({
				executionId: "0123456789abcdef",
				issueIdentifier: null,
				projectName: null,
				sessionStatus: "completed",
				terminalAt: null,
				state: "alive_residual",
				tokensAfterTerminal: null,
				action: "none",
				alertKey: "alive_residual:u",
			}).body,
		).toContain("tokensAfterTerminal=unknown");
		// A new token order of magnitude is a new episode.
		expect(
			buildCodexTerminalBodyAlert({
				executionId: "0123456789abcdef",
				issueIdentifier: null,
				projectName: null,
				sessionStatus: "completed",
				terminalAt: null,
				state: "alive_residual",
				tokensAfterTerminal: 99_999,
				action: "none",
				alertKey: "alive_residual:5",
			}).eventId,
		).not.toBe(alert.eventId);
	});

	it("unlinks only this execution's own socket path, and never a link's target", () => {
		const env = { FLYWHEEL_CODEX_DAEMON_SOCKET_ROOT: join(root, "sock") };
		mkdirSync(env.FLYWHEEL_CODEX_DAEMON_SOCKET_ROOT, { recursive: true });
		const own = resolveDaemonSocketPath("exec-u", env);
		const target = join(root, "target.sock");
		writeFileSync(target, "");
		symlinkSync(target, own);
		unlinkOwnCodexSocket("exec-u", env);
		expect(existsSync(own)).toBe(false);
		expect(lstatSync(target).isFile()).toBe(true);
		// A regular file at our path is not ours to delete.
		writeFileSync(own, "not a socket");
		unlinkOwnCodexSocket("exec-u", env);
		expect(existsSync(own)).toBe(true);
		// Missing path is a no-op.
		unlinkOwnCodexSocket("exec-missing", env);
	});

	it("token observer: resolves once, reads from terminal+2min, and re-resolves a vanished cached path", () => {
		const home = join(root, "agents", "flywheel", "qa");
		const sessions = join(home, "sessions");
		mkdirSync(sessions, { recursive: true });
		const rollout = join(sessions, `rollout-${THREAD}.jsonl`);
		writeFileSync(
			rollout,
			usage("2026-09-25T10:01:00.000Z", 100) +
				usage("2026-09-25T10:30:00.000Z", 700),
		);
		const observe = createRolloutTokenObserver({
			codexHomesRoot: () => root,
			latestCursor: () => ({
				source_locator: rollout,
				native_session_id: THREAD,
			}),
			readThreadId: () => undefined,
		});
		const session = {
			execution_id: "exec-t",
			issue_id: "i",
			project_name: "flywheel",
			status: "completed",
			adapter_type: "codex-tmux",
			terminal_at: "2026-09-25 10:00:00",
		};
		const first = observe({
			executionId: "exec-t",
			session,
			row: undefined,
			processHomes: [],
		});
		expect(first).toMatchObject({
			rolloutPath: rollout,
			read: { tokensAtTerminal: 100, tokensAfterTerminal: 600, complete: true },
		});

		const archivedDir = join(home, "archived_sessions");
		mkdirSync(archivedDir, { recursive: true });
		const archived = join(archivedDir, `rollout-${THREAD}.jsonl`);
		writeFileSync(archived, usage("2026-09-25T10:01:00.000Z", 100));
		rmSync(rollout);
		const row = {
			rollout_path: rollout,
			rollout_offset: first.read!.offset,
			rollout_last_total: 700,
			tokens_at_terminal: 100,
			tokens_after_terminal: 600,
		} as Parameters<typeof observe>[0]["row"];
		const moved = observe({
			executionId: "exec-t",
			session,
			row,
			processHomes: [],
		});
		expect(moved).toMatchObject({
			rolloutPath: archived,
			read: { tokensAtTerminal: 100, tokensAfterTerminal: 0 },
		});
	});

	it("token observer without a terminal time reports the path but no tokens", () => {
		const observe = createRolloutTokenObserver({
			codexHomesRoot: () => root,
			latestCursor: () => undefined,
			readThreadId: () => undefined,
		});
		expect(
			observe({
				executionId: "exec-x",
				session: {
					execution_id: "exec-x",
					issue_id: "i",
					project_name: "p",
					status: "completed",
					terminal_at: null,
				},
				row: undefined,
				processHomes: [],
			}),
		).toEqual({ rolloutPath: null });
	});
});
