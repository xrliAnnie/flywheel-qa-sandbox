import { describe, expect, it, vi } from "vitest";
import { shadowDeclare } from "../shadow-declare.js";

const DECLARATION = "11111111-1111-4111-8111-111111111111";
const QUESTION = "question-shadow-1";
const CHANNEL = "12345678901234567";
const MESSAGE = "22345678901234567";

function output() {
	return {
		stdout: vi.fn(),
		stderr: vi.fn(),
	};
}

describe("shadow-declare", () => {
	it("returns usage failure when Bridge environment is missing and still prints the declaration id", async () => {
		const io = output();
		const exitCode = await shadowDeclare({
			question: QUESTION,
			declaredClass: "pure_docs",
			messageRef: `${CHANNEL}/${MESSAGE}`,
			env: {},
			uuid: () => DECLARATION,
			...io,
		});
		expect(exitCode).toBe(1);
		expect(io.stdout).toHaveBeenCalledWith(`declaration_id=${DECLARATION}`);
		expect(io.stderr).toHaveBeenCalledWith(
			expect.stringContaining("FLYWHEEL_BRIDGE_URL and FLYWHEEL_INGEST_TOKEN"),
		);
	});

	it("returns Bridge rejection and prints the retry id to stdout", async () => {
		const io = output();
		const fetchImpl = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({ ok: false, reason: "declaration_conflict" }),
				{
					status: 409,
					headers: { "content-type": "application/json" },
				},
			),
		);
		const exitCode = await shadowDeclare({
			question: QUESTION,
			declaredClass: "pure_docs",
			messageRef: `${CHANNEL}/${MESSAGE}`,
			declarationId: DECLARATION,
			env: {
				FLYWHEEL_BRIDGE_URL: "http://127.0.0.1:9876/",
				FLYWHEEL_INGEST_TOKEN: " ingest-token ",
			},
			fetchImpl,
			...io,
		});
		expect(exitCode).toBe(2);
		expect(io.stdout).toHaveBeenCalledWith(`declaration_id=${DECLARATION}`);
		expect(io.stderr).toHaveBeenCalledWith(
			"shadow-declare: Bridge rejected (409): declaration_conflict",
		);
		expect(fetchImpl).toHaveBeenCalledWith(
			"http://127.0.0.1:9876/api/workflow/shadow-declaration",
			expect.objectContaining({
				method: "POST",
				headers: {
					Authorization: "Bearer ingest-token",
					"Content-Type": "application/json",
				},
			}),
		);
	});

	it.each([
		[`${CHANNEL}/${MESSAGE}`, { channelId: CHANNEL, messageId: MESSAGE }],
		[
			`https://discord.com/channels/42345678901234567/${CHANNEL}/${MESSAGE}`,
			{
				url: `https://discord.com/channels/42345678901234567/${CHANNEL}/${MESSAGE}`,
			},
		],
	] as const)(
		"posts %s and accepts created or replayed",
		async (messageRef, expectedRef) => {
			const io = output();
			const fetchImpl = vi.fn().mockResolvedValue(
				new Response(
					JSON.stringify({
						ok: true,
						status: "created",
						declaration: { declaration_id: DECLARATION },
					}),
					{ status: 201, headers: { "content-type": "application/json" } },
				),
			);
			const exitCode = await shadowDeclare({
				question: QUESTION,
				declaredClass: "pure_docs",
				messageRef,
				declarationId: DECLARATION,
				env: {
					FLYWHEEL_BRIDGE_URL: "http://127.0.0.1:9876",
					FLYWHEEL_INGEST_TOKEN: "ingest-token",
				},
				fetchImpl,
				...io,
			});
			expect(exitCode).toBe(0);
			expect(io.stdout).toHaveBeenNthCalledWith(
				1,
				`declaration_id=${DECLARATION}`,
			);
			expect(io.stdout).toHaveBeenNthCalledWith(
				2,
				`shadow-declare: status=created declaration_id=${DECLARATION}`,
			);
			const body = JSON.parse(
				(fetchImpl.mock.calls[0]![1] as RequestInit).body as string,
			);
			expect(body).toEqual({
				declaration_id: DECLARATION,
				question_id: QUESTION,
				declared_class: "pure_docs",
				message_ref: expectedRef,
			});
		},
	);

	it.each([
		[
			{
				question: "",
				declaredClass: "pure_docs",
				messageRef: `${CHANNEL}/${MESSAGE}`,
			},
			"--question",
		],
		[
			{
				question: QUESTION,
				declaredClass: "maybe",
				messageRef: `${CHANNEL}/${MESSAGE}`,
			},
			"--class",
		],
		[
			{ question: QUESTION, declaredClass: "pure_docs", messageRef: "bad" },
			"--message-ref",
		],
		[
			{
				question: QUESTION,
				declaredClass: "pure_docs",
				messageRef: `${CHANNEL}/${MESSAGE}`,
				declarationId: "bad",
			},
			"--declaration-id",
		],
	] as const)(
		"rejects invalid usage without a request",
		async (input, diagnostic) => {
			const io = output();
			const fetchImpl = vi.fn();
			const exitCode = await shadowDeclare({
				...input,
				env: {
					FLYWHEEL_BRIDGE_URL: "http://127.0.0.1:9876",
					FLYWHEEL_INGEST_TOKEN: "ingest-token",
				},
				uuid: () => DECLARATION,
				fetchImpl,
				...io,
			});
			expect(exitCode).toBe(1);
			expect(io.stderr).toHaveBeenCalledWith(
				expect.stringContaining(diagnostic),
			);
			expect(fetchImpl).not.toHaveBeenCalled();
		},
	);
});
