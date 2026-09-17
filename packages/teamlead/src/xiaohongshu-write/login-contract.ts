import { z } from "zod";

const prefix = "data:image/png;base64,";
const maxBytes = 384 * 1024;
/** Transport framing only. The pinned private Go provider fully decodes and
 * re-encodes the PNG, removes metadata, and rejects trailing bytes. */
export const loginImageSchema = z
	.string()
	.max(prefix.length + 4 * Math.ceil(maxBytes / 3))
	.refine((value) => {
		if (!value.startsWith(prefix)) return false;
		const encoded = value.slice(prefix.length);
		const bytes = Buffer.from(encoded, "base64");
		if (
			bytes.length < 45 ||
			bytes.length > maxBytes ||
			bytes.toString("base64") !== encoded
		)
			return false;
		if (
			bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" ||
			bytes.readUInt32BE(8) !== 13 ||
			bytes.subarray(12, 16).toString("ascii") !== "IHDR"
		)
			return false;
		const width = bytes.readUInt32BE(16),
			height = bytes.readUInt32BE(20);
		return (
			width > 0 &&
			height > 0 &&
			width <= 2048 &&
			height <= 2048 &&
			bytes.subarray(-12).toString("hex") === "0000000049454e44ae426082"
		);
	});
export const loginProjectionSchema = z.discriminatedUnion("loggedIn", [
	z
		.object({
			loggedIn: z.literal(false),
			image: loginImageSchema,
			expiresAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
		})
		.strict(),
	z
		.object({
			loggedIn: z.literal(true),
			image: z.literal(""),
			expiresAt: z.literal(0),
		})
		.strict(),
]);

export const loginReadOperation = z.enum([
	"check_login_status",
	"get_login_qrcode",
]);
export type LoginReadOperation = z.infer<typeof loginReadOperation>;
export const loginStatusSchema = z.object({ loggedIn: z.boolean() }).strict();
