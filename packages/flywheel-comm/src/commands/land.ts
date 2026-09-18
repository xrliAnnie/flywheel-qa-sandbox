import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { isAbsolute, join, normalize } from "node:path";
import {
	authorizeLeadWrite,
	type LeadWriteAuthorization,
} from "../lead-lease.js";

interface HttpResponse {
	ok: boolean;
	status: number;
	json(): Promise<unknown>;
}

interface LandCommandDeps {
	env?: Record<string, string | undefined>;
	httpJson?: (
		url: string,
		init: { method: string; headers: Record<string, string>; body: string },
	) => Promise<HttpResponse>;
	log?: (message: string) => void;
	errorLog?: (message: string) => void;
	requestId?: () => string;
	authorizeLead?: (
		leadId: string,
		env: Record<string, string | undefined>,
	) => LeadWriteAuthorization;
	peerJson?: (
		socketPath: string,
		request: Record<string, unknown>,
	) => Promise<unknown>;
}

const USAGE =
	"usage: flywheel-comm land reclose --operation <full-id> --expected-generation <n> --expected-head <sha> --reason <text> [--request-id <uuid>] [--bridge-url <url>]";

async function requestPeerJson(
	socketPath: string,
	request: Record<string, unknown>,
): Promise<unknown> {
	if (
		!isAbsolute(socketPath) ||
		normalize(socketPath) !== socketPath ||
		socketPath.includes("\0") ||
		Buffer.byteLength(socketPath) > 100
	) {
		throw new Error("peer_socket_invalid");
	}
	const frame = `${JSON.stringify(request)}\n`;
	if (Buffer.byteLength(frame) > 65_536) throw new Error("request_too_large");
	return await new Promise((resolve, reject) => {
		const socket = createConnection(socketPath);
		const chunks: Buffer[] = [];
		let size = 0;
		let settled = false;
		const finish = (error?: Error, value?: unknown) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			if (error) reject(error);
			else resolve(value);
		};
		const timer = setTimeout(
			() => finish(new Error("peer_response_timeout")),
			31_000,
		);
		socket.once("connect", () => socket.write(frame));
		socket.once("error", () => finish(new Error("peer_connection_failed")));
		socket.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > 65_536) {
				finish(new Error("peer_response_too_large"));
				return;
			}
			chunks.push(Buffer.from(chunk));
		});
		socket.once("end", () => {
			try {
				const bytes = Buffer.concat(chunks, size);
				const newline = bytes.indexOf(10);
				if (
					newline < 0 ||
					bytes
						.subarray(newline + 1)
						.toString("utf8")
						.trim()
				) {
					throw new Error("peer_response_invalid");
				}
				finish(
					undefined,
					JSON.parse(bytes.subarray(0, newline).toString("utf8")),
				);
			} catch {
				finish(new Error("peer_response_invalid"));
			}
		});
	});
}

function option(args: string[], name: string): string | undefined {
	const index = args.indexOf(name);
	return index >= 0 && index + 1 < args.length ? args[index + 1] : undefined;
}

export async function runLandCommand(
	args: string[],
	deps: LandCommandDeps = {},
): Promise<number> {
	const env = deps.env ?? process.env;
	const log = deps.log ?? ((message: string) => console.log(message));
	const errorLog =
		deps.errorLog ?? ((message: string) => console.error(message));
	const operationId = option(args, "--operation")?.trim();
	const generationText = option(args, "--expected-generation")?.trim();
	const expectedResumeGeneration = Number(generationText);
	const expectedApprovedHead = option(args, "--expected-head")
		?.trim()
		.toLowerCase();
	const reason = option(args, "--reason")?.trim();
	const requestId = (
		option(args, "--request-id") ??
		deps.requestId?.() ??
		randomUUID()
	)
		.trim()
		.toLowerCase();
	const token = env.TEAMLEAD_API_TOKEN?.trim();
	const projectName = (
		env.FLYWHEEL_PROJECT_NAME ??
		env.PROJECT_NAME ??
		""
	).trim();
	const leadId = (env.FLYWHEEL_LEAD_ID ?? env.LEAD_ID ?? "").trim();
	if (
		args[0] !== "reclose" ||
		!operationId ||
		!generationText ||
		!Number.isSafeInteger(expectedResumeGeneration) ||
		expectedResumeGeneration < 0 ||
		!/^[0-9a-f]{40}$/.test(expectedApprovedHead ?? "") ||
		!reason ||
		reason.length > 500 ||
		!projectName ||
		!leadId ||
		!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
			requestId,
		)
	) {
		errorLog(USAGE);
		return 1;
	}
	let authorization: LeadWriteAuthorization;
	try {
		authorization = deps.authorizeLead
			? deps.authorizeLead(leadId, env)
			: authorizeLeadWrite({ claimedLeadId: leadId, env });
	} catch (error) {
		errorLog(
			`land reclose: Lead authorization failed: ${error instanceof Error ? error.message : String(error)}`,
		);
		return 1;
	}
	if (!authorization.identityDigest) {
		errorLog("land reclose: Lead identity digest unavailable");
		return 1;
	}
	if (!authorization.carrierClaim) {
		const socketPath =
			env.FLYWHEEL_RECLOSE_PEER_SOCKET?.trim() ||
			join(env.HOME ?? homedir(), ".flywheel", "reclose-peer", "bridge.sock");
		const peerJson = deps.peerJson ?? requestPeerJson;
		try {
			const raw = await peerJson(socketPath, {
				schemaVersion: 1,
				method: "land.reclose",
				operationId,
				expectedResumeGeneration,
				expectedApprovedHead,
				reason,
				requestId,
				projectName,
				leadId,
			});
			const response = raw as {
				requestId?: unknown;
				ok?: unknown;
				operation?: unknown;
				error?: unknown;
			};
			if (response.requestId !== requestId || response.ok !== true) {
				errorLog(
					`land reclose: native peer refused request: ${typeof response.error === "string" ? response.error : "peer_response_invalid"}`,
				);
				return 1;
			}
			log(JSON.stringify(response.operation ?? response));
			return 0;
		} catch (error) {
			errorLog(
				`land reclose: native peer unavailable at ${socketPath}: ${(error as Error).message}`,
			);
			return 1;
		}
	}
	const activationId = env.FLYWHEEL_LEAD_CAPABILITY_ACTIVATION?.trim();
	if (!token || !activationId) {
		errorLog(
			"land reclose: Codex carrier requires TEAMLEAD_API_TOKEN and FLYWHEEL_LEAD_CAPABILITY_ACTIVATION",
		);
		return 1;
	}
	const bridgeUrl = (
		option(args, "--bridge-url") ??
		env.FLYWHEEL_BRIDGE_URL ??
		env.BRIDGE_URL ??
		"http://127.0.0.1:9876"
	).replace(/\/+$/, "");
	const httpJson =
		deps.httpJson ??
		((url: string, init: Parameters<typeof fetch>[1]) =>
			fetch(url, init) as unknown as Promise<HttpResponse>);
	try {
		const response = await httpJson(
			`${bridgeUrl}/api/lifecycle/land/${encodeURIComponent(operationId)}/resume`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${token}`,
					Origin: bridgeUrl,
					"Content-Type": "application/json",
					"X-Flywheel-Lead-Context": Buffer.from(
						JSON.stringify({
							projectName,
							leadId,
							identityDigest: authorization.identityDigest,
							carrierClaim: authorization.carrierClaim,
							activationId,
						}),
					).toString("base64"),
				},
				body: JSON.stringify({
					mode: "closeout_only",
					expectedResumeGeneration,
					expectedApprovedHead,
					reason,
					requestId,
				}),
			},
		);
		const body = await response.json().catch(() => ({}));
		log(JSON.stringify(body));
		return response.ok ? 0 : 1;
	} catch (error) {
		errorLog(
			`land reclose: cannot reach Bridge at ${bridgeUrl}: ${(error as Error).message}`,
		);
		return 1;
	}
}
