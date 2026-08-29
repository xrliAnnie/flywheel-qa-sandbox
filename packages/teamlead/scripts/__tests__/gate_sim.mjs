#!/usr/bin/env node
// QA · FLY-944 — a FAITHFUL, auditable mirror of the Discord plugin gate()
// decision for a TOP-LEVEL guild message (not a DM, not a roundtable topic
// thread). It exists so the QA harness can assert deliver/drop at the SAME
// ordering the real plugin uses — the whole point of the bug is that the
// per-group `allowFrom` gate runs BEFORE the mention gate.
//
// Mirrors: claude-plugins-official/external_plugins/discord/server.ts gate()
//   line 720  const policy = access.groups[channelId]
//   line 721  if (!policy) return { action: 'drop' }
//   line 722  const groupAllowFrom = policy.allowFrom ?? []
//   line 723  const requireMention = policy.requireMention ?? true   // missing → true
//   line 724  if (groupAllowFrom.length > 0 && !groupAllowFrom.includes(senderId))
//   line 725      return { action: 'drop' }                          // ★ sender gate, pre-mention
//   line 784  if (requireMention && !(await isMentioned(...)))       // mention gate
//   line 788      return { action: 'drop' }
//   line 790  return { action: 'deliver' }
//
// isMentioned (server.ts:793): a REAL <@id> mention returns true regardless of
// the per-group name patterns (line 794). A no-@ message only matches on a bare
// NAME pattern — and the core/roundtable target state uses empty per-group
// patterns (id-only) or the plugin's mention discipline, so a no-@ message is
// NOT mentioned. We model that with the explicit `hasAtMention` argument.
//
// The FLY-314 roundtable-TOPIC-THREAD branch (server.ts:727-771) is deliberately
// OUT OF SCOPE here: this harness feeds top-level channel messages, which is
// exactly where Annie's observations ①②③ and the FSM incident occurred.
//
// Usage: node gate_sim.mjs <access-file> <channelId> <senderId> <hasAtMention 0|1>

import { readFileSync } from "node:fs";

const [, , accessFile, channelId, senderId, hasAtMentionArg] = process.argv;
if (!accessFile || !channelId || !senderId || hasAtMentionArg === undefined) {
	process.stderr.write(
		"usage: gate_sim.mjs <access-file> <channel> <sender> <0|1>\n",
	);
	process.exit(2);
}
const hasAtMention = hasAtMentionArg === "1";

const access = JSON.parse(readFileSync(accessFile, "utf8"));

function gate() {
	// A top-level channel message from a registered bot / the founder. DM policy,
	// self-message, and bot-intake filtering happen earlier in the real plugin and
	// are not part of the allowFrom-vs-mention ordering this harness verifies.
	const policy = access.groups?.[channelId];
	if (!policy) return "drop"; // line 721 — channel not subscribed
	const groupAllowFrom = policy.allowFrom ?? []; // line 722
	const requireMention = policy.requireMention ?? true; // line 723 — missing defaults true
	// ★ line 724-725 — the sender whitelist is checked BEFORE the mention gate.
	if (groupAllowFrom.length > 0 && !groupAllowFrom.includes(senderId)) {
		return "drop";
	}
	// line 784-788 — mention discipline. A real <@id> mention → isMentioned true.
	const isMentioned = hasAtMention;
	if (requireMention && !isMentioned) return "drop";
	return "deliver"; // line 790
}

process.stdout.write(gate());
