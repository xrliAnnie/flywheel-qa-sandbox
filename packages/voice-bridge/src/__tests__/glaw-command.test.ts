/**
 * FLY-545 PR-2 P7′ — /glaw command face: founder-only, busy guard, lead
 * resolution, kickoff issue (no issue = no meeting), receipt with Join link
 * button + real founder ping, MOVE_MEMBERS, onMeet handoff.
 */
import { describe, expect, it, vi } from "vitest";
import type {
	GlawInteractionLike,
	GlawUserLike,
} from "../huddle/GlawCommand.js";
import { GlawCommand } from "../huddle/GlawCommand.js";

const FOUNDER = "annie-1";

function makeInteraction(over: {
	invokerId?: string;
	users?: Record<string, GlawUserLike | null>;
}) {
	const replies: Array<Record<string, unknown>> = [];
	const edits: Array<Record<string, unknown>> = [];
	/** ordered trace — the 3s-window contract is about ORDER (defer first). */
	const events: string[] = [];
	const interaction: GlawInteractionLike = {
		commandName: "glaw",
		channelId: "chan-origin",
		user: { id: over.invokerId ?? FOUNDER },
		options: {
			getUser: (name: string) => over.users?.[name] ?? null,
		},
		reply: async (payload) => {
			events.push("reply");
			replies.push(payload as Record<string, unknown>);
		},
		deferReply: async () => {
			events.push("defer");
		},
		editReply: async (payload) => {
			events.push("edit");
			edits.push(payload as Record<string, unknown>);
		},
	};
	return { interaction, replies, edits, events };
}

const tadashiUser: GlawUserLike = {
	id: "bot-tadashi",
	bot: true,
	username: "tadashi",
	displayName: "Tadashi",
};
const hiroUser: GlawUserLike = {
	id: "bot-hiro",
	bot: true,
	username: "hiro",
	displayName: "Hiro",
};

function makeCommand(
	over: Partial<ConstructorParameters<typeof GlawCommand>[0]> = {},
) {
	const onMeet = vi.fn();
	const createIssue = vi.fn(async () => ({
		id: "uuid-9",
		identifier: "FLY-1234",
		url: "https://linear/FLY-1234",
	}));
	const cmd = new GlawCommand({
		commandName: "glaw",
		guildId: "g-1",
		voiceChannelId: "vc-1",
		founderUserId: FOUNDER,
		moveMembers: false,
		linear: { createIssue },
		resolveLead: (userId) =>
			userId === "bot-tadashi"
				? { leadId: "flywheel-eng-lead" }
				: userId === "bot-hiro"
					? { leadId: "joycon-lead" }
					: undefined,
		isBusy: () => false,
		onMeet,
		now: () => new Date(2026, 6, 7, 15, 0),
		...over,
	});
	return { cmd, onMeet, createIssue };
}

describe("command definition", () => {
	it("declares the configurable name + 3 user options (first required)", () => {
		const { cmd } = makeCommand();
		const def = cmd.commandDefinition() as {
			name: string;
			options: Array<{ type: number; name: string; required: boolean }>;
		};
		expect(def.name).toBe("glaw");
		expect(def.options.map((o) => [o.name, o.type, o.required])).toEqual([
			["lead", 6, true],
			["lead2", 6, false],
			["lead3", 6, false],
		]);
	});
});

describe("guards", () => {
	it("rejects a non-founder invoker", async () => {
		const { cmd, onMeet } = makeCommand();
		const { interaction, replies } = makeInteraction({
			invokerId: "stranger",
			users: { lead: tadashiUser },
		});
		await cmd.handleInteraction(interaction);
		expect(String(replies[0]?.content)).toContain("founder");
		expect(replies[0]?.ephemeral).toBe(true);
		expect(onMeet).not.toHaveBeenCalled();
	});

	it("rejects when a meeting is already running (v1 = one at a time)", async () => {
		const { cmd, onMeet } = makeCommand({ isBusy: () => true });
		const { interaction, replies } = makeInteraction({
			users: { lead: tadashiUser },
		});
		await cmd.handleInteraction(interaction);
		expect(String(replies[0]?.content)).toContain("进行中");
		expect(onMeet).not.toHaveBeenCalled();
	});

	it("rejects mentions that are not configured huddle Leads", async () => {
		const { cmd, onMeet } = makeCommand();
		const { interaction, replies } = makeInteraction({
			users: {
				lead: tadashiUser,
				lead2: { id: "someone", bot: false, username: "rando" },
			},
		});
		await cmd.handleInteraction(interaction);
		expect(String(replies[0]?.content)).toContain("rando");
		expect(onMeet).not.toHaveBeenCalled();
	});

	it("ignores foreign commands entirely", async () => {
		const { cmd } = makeCommand();
		const { interaction, replies } = makeInteraction({});
		await cmd.handleInteraction({ ...interaction, commandName: "other" });
		expect(replies).toHaveLength(0);
	});
});

describe("happy path", () => {
	it("defers FIRST (3s window), creates the kickoff issue, edits in the receipt, hands off", async () => {
		const { cmd, onMeet, createIssue } = makeCommand();
		const { interaction, replies, edits, events } = makeInteraction({
			users: { lead: tadashiUser, lead2: hiroUser },
		});
		await cmd.handleInteraction(interaction);

		// the ack must land before the slow Bridge→Linear round trip; the
		// receipt rides editReply on the deferred token (approved plan a).
		expect(events).toEqual(["defer", "edit"]);
		expect(replies).toHaveLength(0);
		expect(createIssue).toHaveBeenCalledWith({
			title: "2026-07-07 15:00 · huddle(Annie, Tadashi, Hiro)",
			description: expect.stringContaining("主持/记录: Tadashi"),
		});
		const receipt = edits[0] as {
			content: string;
			components: Array<{ components: Array<Record<string, unknown>> }>;
			allowedMentions: { users: string[] };
		};
		expect(receipt.content).toContain("FLY-1234");
		expect(receipt.content).toContain(`<@${FOUNDER}>`);
		expect(receipt.allowedMentions.users).toEqual([FOUNDER]);
		expect(receipt.components[0]?.components[0]).toMatchObject({
			style: 5,
			url: "https://discord.com/channels/g-1/vc-1",
		});
		expect(onMeet).toHaveBeenCalledWith({
			issue: {
				id: "uuid-9",
				identifier: "FLY-1234",
				url: "https://linear/FLY-1234",
			},
			participants: [
				{
					leadId: "flywheel-eng-lead",
					userId: "bot-tadashi",
					displayName: "Tadashi",
				},
				{ leadId: "joycon-lead", userId: "bot-hiro", displayName: "Hiro" },
			],
			hostLeadId: "flywheel-eng-lead",
			initiatorChannelId: "chan-origin",
		});
	});

	it("dedupes the same Lead named twice", async () => {
		const { cmd, createIssue } = makeCommand();
		const { interaction } = makeInteraction({
			users: { lead: tadashiUser, lead2: tadashiUser },
		});
		await cmd.handleInteraction(interaction);
		expect(createIssue).toHaveBeenCalledWith(
			expect.objectContaining({
				title: "2026-07-07 15:00 · huddle(Annie, Tadashi)",
			}),
		);
	});

	it("zero-taps the founder into the VC when moveMembers is on", async () => {
		const moveFounderToVc = vi.fn(async () => "moved" as const);
		const { cmd } = makeCommand({ moveMembers: true, moveFounderToVc });
		const { interaction, edits } = makeInteraction({
			users: { lead: tadashiUser },
		});
		await cmd.handleInteraction(interaction);
		expect(moveFounderToVc).toHaveBeenCalledOnce();
		expect(String(edits[0]?.content)).toContain("挪进");
	});
});

describe("kickoff issue failure — no issue, no meeting", () => {
	it("edits the failure onto the deferred ack and never calls onMeet", async () => {
		const { cmd, onMeet } = makeCommand({
			linear: {
				createIssue: async () => {
					throw new Error("bridge unreachable");
				},
			},
		});
		const { interaction, edits, events } = makeInteraction({
			users: { lead: tadashiUser },
		});
		await cmd.handleInteraction(interaction);
		expect(events).toEqual(["defer", "edit"]);
		expect(String(edits[0]?.content)).toContain("立项 issue 建不出来");
		expect(onMeet).not.toHaveBeenCalled();
	});
});
