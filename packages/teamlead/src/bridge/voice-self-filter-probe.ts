import { randomBytes } from "node:crypto";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveCodexLeadInboxSocketPath } from "../lead-backends/codex/CodexLeadInboxSocket.js";
import { effectiveLeadBackend } from "../lead-backends/lead-backend.js";
import type { LeadConfig } from "../ProjectConfig.js";
import {
	makeVoiceSelfFilterRequest,
	VOICE_SELF_FILTER_MAX_BYTES,
	type VoiceSelfFilterResponse,
	verifyVoiceSelfFilterResponse,
} from "../voice-self-filter-contract.js";
import { resolveCodexLeadStateDir } from "./lead-inbox-runtime.js";

export async function probeVoiceSelfFilterSocket(args: {
	socketPath: string;
	leadId: string;
	expectedBotUserId: string;
	authSecret: string;
	backend: "claude" | "codex";
	timeoutMs?: number;
}): Promise<VoiceSelfFilterResponse> {
	const request = makeVoiceSelfFilterRequest(
		{
			leadId: args.leadId,
			expectedBotUserId: args.expectedBotUserId,
			nonce: randomBytes(32).toString("hex"),
		},
		args.authSecret,
	);
	const wire =
		args.backend === "codex"
			? { ...request, version: 2, contractVersion: 1 }
			: request;
	const payload = `${JSON.stringify(wire)}\n`;
	if (Buffer.byteLength(payload) > VOICE_SELF_FILTER_MAX_BYTES)
		throw new Error("self_filter_request_too_large");
	const raw = await new Promise<string>((resolve, reject) => {
		const socket = createConnection(args.socketPath);
		const chunks: Buffer[] = [];
		let size = 0;
		let settled = false;
		const finish = (error?: Error, result?: string) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			if (error) reject(error);
			else resolve(result!);
		};
		const timer = setTimeout(
			() => finish(new Error("self_filter_timeout")),
			Math.min(args.timeoutMs ?? 2000, 2000),
		);
		socket.once("connect", () => {
			// Bun carriers use newline framing; preserve Codex inbox EOF framing.
			if (args.backend === "claude") socket.write(payload);
			else socket.end(payload);
		});
		socket.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > VOICE_SELF_FILTER_MAX_BYTES) {
				finish(new Error("self_filter_response_too_large"));
				return;
			}
			chunks.push(chunk);
		});
		socket.once("error", () => finish(new Error("self_filter_unreachable")));
		socket.once("end", () =>
			finish(undefined, Buffer.concat(chunks).toString("utf8")),
		);
		socket.once("close", () => {
			if (!settled) finish(new Error("self_filter_closed"));
		});
	});
	try {
		return verifyVoiceSelfFilterResponse(
			JSON.parse(raw),
			request,
			args.authSecret,
		);
	} catch {
		throw new Error("self_filter_unverified");
	}
}

export async function probeVoiceSelfFilter(args: {
	projectName: string;
	lead: LeadConfig;
	token: string;
}): Promise<VoiceSelfFilterResponse> {
	const codex =
		effectiveLeadBackend(args.lead.backend).backend === "codex-app-server";
	return probeVoiceSelfFilterSocket({
		backend: codex ? "codex" : "claude",
		socketPath: codex
			? resolveCodexLeadInboxSocketPath(
					resolveCodexLeadStateDir(args.projectName, args.lead.agentId),
				)
			: join(
					args.lead.discordStateDir ??
						join(
							homedir(),
							".claude",
							"channels",
							`discord-${args.lead.agentId}`,
						),
					"voice-self-filter.sock",
				),
		leadId: args.lead.agentId,
		expectedBotUserId: args.lead.botUserId ?? "",
		authSecret: args.token,
	});
}
