import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { normalizeOptionalBearer } from "flywheel-config";

const UUID_V4 =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SNOWFLAKE = /^\d{17,20}$/;
const DISCORD_URL =
	/^https:\/\/discord\.com\/channels\/(\d{17,20})\/(\d{17,20})\/(\d{17,20})$/;
const CLASSES = new Set([
	"pure_docs",
	"config_only",
	"single_point_change",
	"other_code",
]);

export interface ShadowDeclareOptions {
	question?: string;
	declaredClass?: string;
	messageRef?: string;
	declarationId?: string;
	env?: NodeJS.ProcessEnv;
	fetchImpl?: typeof fetch;
	uuid?: () => string;
	stdout?: (message: string) => void;
	stderr?: (message: string) => void;
}

function parseMessageRef(
	value: string | undefined,
): { url: string } | { channelId: string; messageId: string } | undefined {
	const trimmed = value?.trim();
	if (!trimmed) return undefined;
	if (DISCORD_URL.test(trimmed)) return { url: trimmed };
	const parts = trimmed.split("/");
	return parts.length === 2 &&
		SNOWFLAKE.test(parts[0]!) &&
		SNOWFLAKE.test(parts[1]!)
		? { channelId: parts[0]!, messageId: parts[1]! }
		: undefined;
}

/** Exit codes: 0 = created/replayed; 1 = usage/env; 2 = Bridge/network. */
export async function shadowDeclare(
	opts: ShadowDeclareOptions,
): Promise<number> {
	const stdout = opts.stdout ?? console.log;
	const stderr = opts.stderr ?? console.error;
	const declarationId =
		opts.declarationId?.trim() || (opts.uuid ?? randomUUID)();
	stdout(`declaration_id=${declarationId}`);
	const question = opts.question?.trim();
	const declaredClass = opts.declaredClass?.trim();
	const messageRef = parseMessageRef(opts.messageRef);
	if (!question || question.length > 128) {
		stderr(
			"shadow-declare: --question is required and must be at most 128 characters",
		);
		return 1;
	}
	if (!declaredClass || !CLASSES.has(declaredClass)) {
		stderr(
			"shadow-declare: --class must be pure_docs|config_only|single_point_change|other_code",
		);
		return 1;
	}
	if (!messageRef) {
		stderr(
			"shadow-declare: --message-ref must be a Discord message URL or channelId/messageId",
		);
		return 1;
	}
	if (!UUID_V4.test(declarationId)) {
		stderr("shadow-declare: --declaration-id must be a canonical UUID v4");
		return 1;
	}
	const env = opts.env ?? process.env;
	const bridgeUrl = env.FLYWHEEL_BRIDGE_URL?.trim().replace(/\/$/, "");
	const ingestToken = normalizeOptionalBearer(env.FLYWHEEL_INGEST_TOKEN);
	if (!bridgeUrl || !ingestToken) {
		stderr(
			"shadow-declare: FLYWHEEL_BRIDGE_URL and FLYWHEEL_INGEST_TOKEN are required",
		);
		return 1;
	}
	let response: Response;
	let body: { ok?: boolean; status?: string; reason?: string } | undefined;
	try {
		response = await (opts.fetchImpl ?? fetch)(
			`${bridgeUrl}/api/workflow/shadow-declaration`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${ingestToken}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					declaration_id: declarationId,
					question_id: question,
					declared_class: declaredClass,
					message_ref: messageRef,
				}),
			},
		);
		body = (await response.json().catch(() => undefined)) as
			| typeof body
			| undefined;
	} catch (error) {
		stderr(
			`shadow-declare: request failed: ${error instanceof Error ? error.message : String(error)}`,
		);
		return 2;
	}
	if (
		response.ok &&
		body?.ok === true &&
		(body.status === "created" || body.status === "replayed")
	) {
		stdout(
			`shadow-declare: status=${body.status} declaration_id=${declarationId}`,
		);
		return 0;
	}
	stderr(
		`shadow-declare: Bridge rejected (${response.status}): ${body?.reason ?? "unknown"}`,
	);
	return 2;
}

export async function runShadowDeclareCommand(args: string[]): Promise<number> {
	let values: ReturnType<typeof parseArgs>["values"];
	try {
		({ values } = parseArgs({
			args,
			options: {
				question: { type: "string" },
				class: { type: "string" },
				"message-ref": { type: "string" },
				"declaration-id": { type: "string" },
			},
			allowPositionals: false,
		}));
	} catch (error) {
		console.error(
			`shadow-declare: ${error instanceof Error ? error.message : String(error)}`,
		);
		return 1;
	}
	return shadowDeclare({
		question: values.question as string | undefined,
		declaredClass: values.class as string | undefined,
		messageRef: values["message-ref"] as string | undefined,
		declarationId: values["declaration-id"] as string | undefined,
	});
}
