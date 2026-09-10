import { AwsClient } from "aws4fetch";
import { isPayloadSemver, payloadObjectKey } from "./manifest.mjs";

export function createSignGet(env) {
	if (
		!/^[a-f0-9]{32}$/.test(env.FW_R2_ACCOUNT_ID ?? "") ||
		env.FW_R2_BUCKET !== "flywheel-payloads" ||
		!env.FW_R2_ACCESS_KEY_ID ||
		!env.FW_R2_SECRET_ACCESS_KEY
	) {
		throw new Error("download signing unavailable");
	}
	const client = new AwsClient({
		accessKeyId: env.FW_R2_ACCESS_KEY_ID,
		secretAccessKey: env.FW_R2_SECRET_ACCESS_KEY,
		service: "s3",
		region: "auto",
	});
	return async ({ objectKey, issuedAt, expiresIn }) => {
		const match = /^payloads\/([^/]+)\/([a-f0-9]{64})\.tgz$/.exec(objectKey);
		if (
			!match ||
			!isPayloadSemver(match[1]) ||
			payloadObjectKey(match[1], match[2]) !== objectKey ||
			!Number.isInteger(expiresIn) ||
			expiresIn < 1 ||
			expiresIn > 60 ||
			!Number.isFinite(issuedAt) ||
			issuedAt % 1000 !== 0
		) {
			throw new Error("invalid download signing input");
		}
		const url = new URL(
			`https://${env.FW_R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.FW_R2_BUCKET}/${objectKey}`,
		);
		url.searchParams.set("X-Amz-Expires", String(expiresIn));
		url.searchParams.set("response-cache-control", "private, no-store");
		const signed = await client.sign(url, {
			method: "GET",
			aws: {
				signQuery: true,
				datetime: new Date(issuedAt).toISOString().replace(/[:-]|\.\d{3}/g, ""),
			},
		});
		return signed.url;
	};
}
