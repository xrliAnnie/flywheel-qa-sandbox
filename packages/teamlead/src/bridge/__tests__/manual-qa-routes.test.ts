import { describe, expect, it, vi } from "vitest";
import { ConfirmTokenStore } from "../fleet-admin.js";
import {
	handleManualQaApply,
	handleManualQaStage,
} from "../manual-qa-routes.js";

const HEAD = "a".repeat(40);

describe("manual QA route handlers", () => {
	it("accepts only executionId + prHeadSha and rejects client-supplied executor identity", () => {
		const tokens = new ConfirmTokenStore();
		expect(
			handleManualQaStage(tokens, {
				executionId: "main-1",
				prHeadSha: HEAD,
				executor: "qa-fake",
			}),
		).toMatchObject({ code: 400 });
		expect(
			handleManualQaStage(tokens, {
				executionId: "main-1",
				prHeadSha: HEAD,
				qaExecutionId: "qa-fake",
			}),
		).toMatchObject({ code: 400 });
	});

	it("uses a single-use request-bound token and delegates identity creation to the coordinator", async () => {
		const tokens = new ConfirmTokenStore();
		const input = { executionId: "main-1", prHeadSha: HEAD };
		const staged = handleManualQaStage(tokens, input);
		expect(staged.code).toBe(200);
		const token = (staged.body as { confirmToken: string }).confirmToken;
		const manualSpawnQa = vi.fn(async () => ({
			status: "spawned" as const,
			qaExecutionId: "qa-1",
		}));

		const applied = await handleManualQaApply(
			{ tokens, coordinator: { manualSpawnQa } },
			input,
			token,
		);

		expect(applied).toEqual({
			code: 202,
			body: { status: "spawned", qaExecutionId: "qa-1" },
		});
		expect(manualSpawnQa).toHaveBeenCalledWith("main-1", HEAD);
		await expect(
			handleManualQaApply(
				{ tokens, coordinator: { manualSpawnQa } },
				input,
				token,
			),
		).resolves.toMatchObject({ code: 401 });
	});

	it("fails closed on token/request mismatch and unavailable coordinator", async () => {
		const tokens = new ConfirmTokenStore();
		const staged = handleManualQaStage(tokens, {
			executionId: "main-1",
			prHeadSha: HEAD,
		});
		const token = (staged.body as { confirmToken: string }).confirmToken;
		await expect(
			handleManualQaApply(
				{ tokens, coordinator: undefined },
				{ executionId: "main-2", prHeadSha: HEAD },
				token,
			),
		).resolves.toMatchObject({ code: 401 });

		const staged2 = handleManualQaStage(tokens, {
			executionId: "main-1",
			prHeadSha: HEAD,
		});
		await expect(
			handleManualQaApply(
				{ tokens, coordinator: undefined },
				{ executionId: "main-1", prHeadSha: HEAD },
				(staged2.body as { confirmToken: string }).confirmToken,
			),
		).resolves.toEqual({
			code: 503,
			body: { error: "auto-QA coordinator unavailable" },
		});
	});

	it("maps existing enrollment to an idempotent 409", async () => {
		const tokens = new ConfirmTokenStore();
		const input = { executionId: "main-1", prHeadSha: HEAD };
		const staged = handleManualQaStage(tokens, input);
		const coordinator = {
			manualSpawnQa: vi.fn(async () => ({
				status: "existing" as const,
				recordStatus: "running" as const,
			})),
		};
		await expect(
			handleManualQaApply(
				{ tokens, coordinator },
				input,
				(staged.body as { confirmToken: string }).confirmToken,
			),
		).resolves.toEqual({
			code: 409,
			body: { status: "existing", recordStatus: "running" },
		});
	});
});
