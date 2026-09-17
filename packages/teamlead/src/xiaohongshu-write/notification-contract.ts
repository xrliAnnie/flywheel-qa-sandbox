import { z } from "zod";

const eventId = z
	.string()
	.regex(
		/^xhs-(approved|rejected|revoked|expired|delivery_delayed):[0-9a-f-]{36}$/,
	);
export const notificationInputs = {
	notifications: z.object({}).strict(),
	notification_ack: z.object({ eventId }).strict(),
};
export const notificationResponses = {
	notifications: z
		.object({
			events: z
				.array(
					z
						.object({
							eventId,
							eventKind: z.enum([
								"approved",
								"rejected",
								"revoked",
								"expired",
								"delivery_delayed",
							]),
							receiptId: z.string().uuid().nullable(),
							proposalId: z.string().uuid(),
							contentDigest: z.string().regex(/^[a-f0-9]{64}$/),
							expiry: z
								.number()
								.int()
								.nonnegative()
								.max(Number.MAX_SAFE_INTEGER),
						})
						.strict(),
				)
				.max(100),
		})
		.strict(),
	notification_ack: z.object({ acknowledged: z.literal(true) }).strict(),
};
