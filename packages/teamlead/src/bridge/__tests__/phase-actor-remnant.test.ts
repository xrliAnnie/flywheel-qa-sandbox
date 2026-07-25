import { deriveRunnerMailboxIdentity } from "flywheel-agent-team-transport";
import { describe, expect, it, vi } from "vitest";
import {
	type ActorRemnantDeps,
	parseRunnerWindowInventory,
	probeActorProcessRemnant,
} from "../phase-actor-remnant.js";
import type { PhaseSession } from "../phase-orchestrator.js";

const EXEC_ID = "0555207c-2010-407d-9f41-8097a0711423";

function makeSession(overrides: Partial<PhaseSession> = {}): PhaseSession {
	return {
		execution_id: EXEC_ID,
		issue_id: "FLY-1150",
		project_name: "flywheel",
		status: "terminated",
		...overrides,
	};
}

/** All-attributed inventory: every LIVE runner/cmux window carries some OTHER
 * execution's marker — the precondition for a sound `none`. */
const OTHERS_ONLY = async () => [
	{
		windowId: "@1",
		marker: "aaaaaaaa-1111-2222-3333-444444444444",
		hasLivePane: true,
	},
	{
		windowId: "@2",
		marker: "bbbbbbbb-1111-2222-3333-444444444444",
		hasLivePane: true,
	},
];

function claudeDeps(overrides: ActorRemnantDeps = {}): ActorRemnantDeps {
	return {
		listProcessCommands: vi.fn(async () => "tmux -L default\nnode tool.js"),
		listRunnerWindowInventory: vi.fn(OTHERS_ONLY),
		...overrides,
	};
}

describe("probeActorProcessRemnant (claude family)", () => {
	it("finds a live runner whose argv carries the spawn identity (drift-guarded needle)", async () => {
		// The needle is derived by the SAME helper the spawn side uses — build
		// the fixture line with that helper so a derivation drift breaks here.
		const { agentName } = deriveRunnerMailboxIdentity(EXEC_ID, "any-lead");
		const snapshot = [
			"/usr/bin/ps -axww -o command=",
			`claude --agent-id ${agentName}@flywheel-eng-lead --agent-name ${agentName} --permission-mode bypassPermissions`,
			"tmux -L default",
		].join("\n");
		await expect(
			probeActorProcessRemnant(
				makeSession(),
				claudeDeps({ listProcessCommands: vi.fn(async () => snapshot) }),
			),
		).resolves.toBe("found");
	});

	it.each([undefined, "claude-tmux"])(
		"returns none for adapter_type=%s only when zero argv hits AND every live window is attributed elsewhere",
		async (adapter_type) => {
			await expect(
				probeActorProcessRemnant(makeSession({ adapter_type }), claudeDeps()),
			).resolves.toBe("none");
		},
	);

	it("finds the actor when a LIVE window still claims this execution's marker (incl. a cmux sole holder)", async () => {
		await expect(
			probeActorProcessRemnant(
				makeSession(),
				claudeDeps({
					listRunnerWindowInventory: vi.fn(async () => [
						{ windowId: "@7", marker: EXEC_ID, hasLivePane: true },
					]),
				}),
			),
		).resolves.toBe("found");
	});

	it("holds (indeterminate) on an UNMARKED live window — the R2 HIGH-2 / R3 HIGH-2 identity-less actor, cmux sole holder included", async () => {
		// commdb rollback / missing leadId / transport failure legally spawn a
		// runner with neither Agent Team argv flags nor (best-effort) marker;
		// after the base runner-* session dies, a cmux-* linked view can be the
		// window's sole holder. The dep-level inventory covers both shapes.
		await expect(
			probeActorProcessRemnant(
				makeSession(),
				claudeDeps({
					listRunnerWindowInventory: vi.fn(async () => [
						{
							windowId: "@1",
							marker: "aaaaaaaa-1111-2222-3333-444444444444",
							hasLivePane: true,
						},
						{ windowId: "@9", marker: "", hasLivePane: true },
					]),
				}),
			),
		).resolves.toBe("indeterminate");
	});

	it("ignores dead-pin windows entirely (R3 MED-1: a remain-on-exit husk must not globally veto)", async () => {
		await expect(
			probeActorProcessRemnant(
				makeSession(),
				claudeDeps({
					listRunnerWindowInventory: vi.fn(async () => [
						{
							windowId: "@1",
							marker: "aaaaaaaa-1111-2222-3333-444444444444",
							hasLivePane: true,
						},
						// unrelated pre-marker dead husk — all panes dead, no marker
						{ windowId: "@9", marker: "", hasLivePane: false },
						// our own dead husk — process dead, cannot write
						{ windowId: "@11", marker: EXEC_ID, hasLivePane: false },
					]),
				}),
			),
		).resolves.toBe("none");
	});

	it("returns indeterminate when the window inventory errors", async () => {
		await expect(
			probeActorProcessRemnant(
				makeSession(),
				claudeDeps({
					listRunnerWindowInventory: vi.fn(async () => {
						throw new Error("tmux gone");
					}),
				}),
			),
		).resolves.toBe("indeterminate");
	});

	it("returns indeterminate when the ps snapshot errors", async () => {
		await expect(
			probeActorProcessRemnant(
				makeSession(),
				claudeDeps({
					listProcessCommands: vi.fn(async () => {
						throw new Error("ps timeout");
					}),
				}),
			),
		).resolves.toBe("indeterminate");
	});

	it("returns indeterminate on an empty ps snapshot", async () => {
		await expect(
			probeActorProcessRemnant(
				makeSession(),
				claudeDeps({ listProcessCommands: vi.fn(async () => "   \n") }),
			),
		).resolves.toBe("indeterminate");
	});

	it("returns indeterminate for a short execution id (needle would be junk)", async () => {
		await expect(
			probeActorProcessRemnant(
				makeSession({ execution_id: "abc" }),
				claudeDeps(),
			),
		).resolves.toBe("indeterminate");
	});
});

describe("parseRunnerWindowInventory (owner-aware raw parser, R4 HIGH-1/2)", () => {
	const RAW = [
		// base runner session — counts directly (live, marker present)
		"runner-flywheel\t@10\t0\taaaaaaaa-1111-2222-3333-444444444444\t",
		// normal live Lead cmux view — owner is the LEAD session → EXCLUDED
		// (a bare cmux-* prefix would let this permanently veto the self-heal)
		"cmux-flywheel-flywheel-cos-lead\t@20\t0\t\tflywheel",
		// runner-owned canonical cmux view, sole holder, UNMARKED live actor
		"cmux-FLY-9999-implement\t@30\t0\t\trunner-flywheel",
		// runner-owned keeper escrow sole holder, marked elsewhere
		"fwkeeper-abc\t@40\t0\tbbbbbbbb-1111-2222-3333-444444444444\trunner-flywheel",
		// runner-owned stage, all panes dead — folded but not live
		"fwstage-xyz\t@50\t1\t\trunner-flywheel",
		// unrelated user session — excluded
		"my-personal\t@60\t0\t\t",
	].join("\n");

	it("excludes lead-owned views, keeps base + runner-owned cmux/fwstage/fwkeeper, folds by window", () => {
		const entries = parseRunnerWindowInventory(RAW);
		const ids = entries.map((e) => e.windowId).sort();
		expect(ids).toEqual(["@10", "@30", "@40", "@50"]);
		expect(entries.find((e) => e.windowId === "@30")).toMatchObject({
			marker: "",
			hasLivePane: true,
		});
		expect(entries.find((e) => e.windowId === "@50")).toMatchObject({
			hasLivePane: false,
		});
	});

	it("a lead cmux view does not veto none, while a runner-owned unmarked sole holder does", async () => {
		const leadOnly = parseRunnerWindowInventory(
			[
				"runner-flywheel\t@10\t0\taaaaaaaa-1111-2222-3333-444444444444\t",
				"cmux-flywheel-flywheel-cos-lead\t@20\t0\t\tflywheel",
			].join("\n"),
		);
		await expect(
			probeActorProcessRemnant(
				makeSession(),
				claudeDeps({
					listRunnerWindowInventory: vi.fn(async () => leadOnly),
				}),
			),
		).resolves.toBe("none");

		const withSoleHolder = parseRunnerWindowInventory(RAW);
		await expect(
			probeActorProcessRemnant(
				makeSession(),
				claudeDeps({
					listRunnerWindowInventory: vi.fn(async () => withSoleHolder),
				}),
			),
		).resolves.toBe("indeterminate");
	});

	it("counts an ownerless GROUPED runner rollback view (STRICT_VIEW=0) as a runner holder — R5 HIGH-1", async () => {
		// The supported grouped rollback creates cmux views with NO
		// @flywheel_cmux_owner; the session group carries the base name.
		const grouped = parseRunnerWindowInventory(
			[
				"runner-flywheel\t@10\t0\taaaaaaaa-1111-2222-3333-444444444444\t\t",
				// ownerless grouped runner sole holder, unmarked + live
				"cmux-FLY-1462-implement\t@80\t0\t\t\trunner-flywheel",
			].join("\n"),
		);
		expect(grouped.map((e) => e.windowId).sort()).toEqual(["@10", "@80"]);
		await expect(
			probeActorProcessRemnant(
				makeSession(),
				claudeDeps({ listRunnerWindowInventory: vi.fn(async () => grouped) }),
			),
		).resolves.toBe("indeterminate");
	});

	it("excludes an ownerless GROUPED lead view (group=flywheel) — no standing veto", () => {
		const entries = parseRunnerWindowInventory(
			[
				"runner-flywheel\t@10\t0\taaaaaaaa-1111-2222-3333-444444444444\t\t",
				"cmux-flywheel\t@90\t0\t\t\tflywheel",
			].join("\n"),
		);
		expect(entries.map((e) => e.windowId)).toEqual(["@10"]);
	});

	it("fails the inventory closed on a managed view with neither owner nor group", async () => {
		expect(() =>
			parseRunnerWindowInventory("cmux-mystery\t@99\t0\t\t\t"),
		).toThrow(/unattributable managed view/);
		await expect(
			probeActorProcessRemnant(
				makeSession(),
				claudeDeps({
					listRunnerWindowInventory: vi.fn(async () =>
						parseRunnerWindowInventory("cmux-mystery\t@99\t0\t\t\t"),
					),
				}),
			),
		).resolves.toBe("indeterminate");
	});

	it("fails the inventory closed on an undecidable pane_dead for an included row", () => {
		expect(() =>
			parseRunnerWindowInventory("runner-flywheel\t@10\tX\t\t\t"),
		).toThrow(/undecidable pane_dead/);
	});

	it("folds duplicate window rows across a base session and its runner-owned view", () => {
		const entries = parseRunnerWindowInventory(
			[
				"runner-flywheel\t@70\t1\tcccccccc-1111-2222-3333-444444444444\t",
				"cmux-FLY-7777-qa\t@70\t0\tcccccccc-1111-2222-3333-444444444444\trunner-flywheel",
			].join("\n"),
		);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			windowId: "@70",
			hasLivePane: true,
			marker: "cccccccc-1111-2222-3333-444444444444",
		});
	});
});

describe("probeActorProcessRemnant (non-claude adapters)", () => {
	it("codex-tmux is an explicit conservative boundary — always indeterminate (R3 HIGH-1 restart-generation race)", async () => {
		// A point-in-time negative snapshot cannot prove the auto-restarting
		// codex daemon runtime will not spawn the next generation right after
		// the probe. Until a durable quiescence fence exists in the adapter
		// runtime, codex rows never authorize an automatic replace.
		const listProcessCommands = vi.fn(async () => "anything");
		await expect(
			probeActorProcessRemnant(makeSession({ adapter_type: "codex-tmux" }), {
				listProcessCommands,
			}),
		).resolves.toBe("indeterminate");
		expect(listProcessCommands).not.toHaveBeenCalled();
	});

	it.each(["antigravity-tmux", "kimi-tmux", "mystery"])(
		"returns indeterminate for adapter_type=%s (no process identity signature)",
		async (adapter_type) => {
			const listProcessCommands = vi.fn(async () => "anything");
			await expect(
				probeActorProcessRemnant(makeSession({ adapter_type }), {
					listProcessCommands,
				}),
			).resolves.toBe("indeterminate");
			expect(listProcessCommands).not.toHaveBeenCalled();
		},
	);
});
