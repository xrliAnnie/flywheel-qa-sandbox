/**
 * GlawCommand (FLY-545 PR-2 P7′) — the /glaw slash-command face on the
 * orchestrator bot (Annie-final naming ①: glaw = Gemini 耳 + Claude 脑;
 * huddle.commandName keeps it configurable, PRD R10).
 *
 * One invocation = one meeting kickoff: resolve the @-named Leads (first
 * named = host, PRD R9), auto-create the kickoff issue (PRD R8 — no issue,
 * no meeting: Linear failure fails the invoke loudly so Annie just retries),
 * answer with a receipt carrying the issue link + a Join LINK button (zero
 * callback/state; desktop = one tap, PRD §12.1), ping the founder for real
 * (allowedMentions), and zero-tap MOVE_MEMBERS when she is already in a VC.
 * Then hand the meeting to the orchestration via onMeet.
 *
 * Only the founder can invoke (a shared-guild slash command is callable by
 * anyone; a stranger must not be able to spin up Lead sessions / issues).
 */
import type { CreatedIssue } from "../linear/BridgeLinearClient.js";

export interface GlawUserLike {
	id: string;
	bot: boolean;
	username: string;
	displayName?: string;
}

/** the narrow slice of a discord.js ChatInputCommandInteraction we consume. */
export interface GlawInteractionLike {
	commandName: string;
	channelId: string;
	user: { id: string };
	options: { getUser(name: string): GlawUserLike | null };
	reply(payload: {
		content: string;
		components?: unknown[];
		allowedMentions?: { users: string[] };
		ephemeral?: boolean;
	}): Promise<unknown>;
	/** ack within Discord's 3s interaction window BEFORE the slow work — the
	 * kickoff issue is a Bridge→Linear round trip that easily exceeds it, and
	 * an expired token turns the receipt into "app not responding" (967 found
	 * the same family on the shared daemon; approved fix plan a). */
	deferReply(): Promise<unknown>;
	editReply(payload: {
		content: string;
		components?: unknown[];
		allowedMentions?: { users: string[] };
	}): Promise<unknown>;
}

export interface GlawParticipant {
	leadId: string;
	userId: string;
	displayName: string;
}

export interface GlawInvocation {
	issue: CreatedIssue;
	participants: GlawParticipant[];
	/** first @-named Lead — host/recorder (PRD R9). */
	hostLeadId: string;
	initiatorChannelId: string;
}

export interface GlawCommandOptions {
	commandName: string;
	guildId: string;
	voiceChannelId: string;
	founderUserId: string;
	moveMembers: boolean;
	linear: {
		createIssue(input: {
			title: string;
			description?: string;
		}): Promise<CreatedIssue>;
	};
	/** map a mentioned bot user id to the configured Lead (undefined = not a
	 * configured huddle Lead). */
	resolveLead: (userId: string) => { leadId: string } | undefined;
	/** true while a meeting is running (v1 concurrency = 1). */
	isBusy: () => boolean;
	/** zero-tap move; only called when moveMembers is on. */
	moveFounderToVc?: () => Promise<"moved" | "not-in-voice" | "failed">;
	onMeet: (invocation: GlawInvocation) => void | Promise<void>;
	now?: () => Date;
	log?: (line: string) => void;
}

const USER_OPTIONS = ["lead", "lead2", "lead3"] as const;

export class GlawCommand {
	constructor(private readonly opts: GlawCommandOptions) {}

	/** guild slash-command spec (registerGuildCommand seam, 967 parity). */
	commandDefinition(): {
		name: string;
		description: string;
		options: readonly unknown[];
	} {
		return {
			name: this.opts.commandName,
			description: "开一场 Huddle:点名 Lead,自动立项,进 #huddle 聊清一件事",
			options: USER_OPTIONS.map((name, i) => ({
				type: 6, // USER
				name,
				description: i === 0 ? "主持 Lead(第一个点名)" : "再拉一个 Lead",
				required: i === 0,
			})),
		};
	}

	async handleInteraction(interaction: GlawInteractionLike): Promise<void> {
		if (interaction.commandName !== this.opts.commandName) return;

		if (interaction.user.id !== this.opts.founderUserId) {
			await interaction.reply({
				content: "只有 founder 能发起 huddle。",
				ephemeral: true,
			});
			return;
		}
		if (this.opts.isBusy()) {
			await interaction.reply({
				content: "有会正在进行中 — #huddle 一次一场,等这场收尾再来。",
				ephemeral: true,
			});
			return;
		}

		const participants: GlawParticipant[] = [];
		const unknown: string[] = [];
		for (const opt of USER_OPTIONS) {
			const user = interaction.options.getUser(opt);
			if (!user) continue;
			const lead = this.opts.resolveLead(user.id);
			if (!lead) {
				unknown.push(user.displayName ?? user.username);
				continue;
			}
			if (participants.some((p) => p.leadId === lead.leadId)) continue;
			participants.push({
				leadId: lead.leadId,
				userId: user.id,
				displayName: user.displayName ?? user.username,
			});
		}
		if (unknown.length > 0) {
			await interaction.reply({
				content: `这些成员不是配置好的 huddle Lead:${unknown.join("、")} — 检查 projects.json 的 leads[]。`,
				ephemeral: true,
			});
			return;
		}
		const host = participants[0];
		if (!host) {
			await interaction.reply({
				content: "至少点名一个 Lead(第一个点名的当主持)。",
				ephemeral: true,
			});
			return;
		}

		const when = this.opts.now?.() ?? new Date();
		const title = `${formatStamp(when)} · huddle(Annie, ${participants
			.map((p) => p.displayName)
			.join(", ")})`;
		const vcUrl = `https://discord.com/channels/${this.opts.guildId}/${this.opts.voiceChannelId}`;

		// guards above answer instantly; everything below crosses process
		// boundaries (Bridge→Linear, MOVE_MEMBERS) and can blow the 3s
		// interaction window — ack FIRST, deliver the receipt via editReply.
		await interaction.deferReply();

		let issue: CreatedIssue;
		try {
			issue = await this.opts.linear.createIssue({
				title,
				description: [
					`Huddle 立项(/${this.opts.commandName} 自动创建)。`,
					`- 参与者: Annie, ${participants.map((p) => p.displayName).join(", ")}`,
					`- 主持/记录: ${host.displayName}(第一个点名,PRD R9)`,
					`- 发起频道: <#${interaction.channelId}>`,
					`- TIV(语音频道文字区): ${vcUrl}`,
					"",
					"聊完后 summary + action items(引用原话)会写进本 issue。",
				].join("\n"),
			});
		} catch (err) {
			this.opts.log?.(
				`[glaw] kickoff issue failed: ${err instanceof Error ? err.message : String(err)}`,
			);
			await interaction.editReply({
				content: "立项 issue 建不出来(Bridge/Linear 出错)— 这场没开始,修好再 /"
					.concat(this.opts.commandName)
					.concat(" 一次。"),
			});
			return;
		}

		let moveNote = "";
		if (this.opts.moveMembers && this.opts.moveFounderToVc) {
			const moved = await this.opts.moveFounderToVc();
			if (moved === "moved") moveNote = "已经把你挪进 #huddle 了。";
		}

		await interaction.editReply({
			content: [
				`<@${this.opts.founderUserId}> huddle 开了:${participants
					.map((p) => p.displayName)
					.join("、")} 正在进 #huddle。`,
				`立项 issue:${issue.identifier} ${issue.url}`,
				moveNote,
			]
				.filter(Boolean)
				.join("\n"),
			components: [
				{
					type: 1, // ACTION_ROW
					components: [
						{ type: 2, style: 5, label: "Join #huddle", url: vcUrl }, // LINK
					],
				},
			],
			allowedMentions: { users: [this.opts.founderUserId] },
		});

		await this.opts.onMeet({
			issue,
			participants,
			hostLeadId: host.leadId,
			initiatorChannelId: interaction.channelId,
		});
	}
}

function formatStamp(d: Date): string {
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
