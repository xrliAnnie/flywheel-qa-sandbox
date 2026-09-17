import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { signDispatchPermit } from "../permit.js";

const vector = JSON.parse(
	readFileSync(
		new URL("./fixtures/xhs-permit-v1.json", import.meta.url),
		"utf8",
	),
);
const {
	purpose: _purpose,
	issuer: _issuer,
	issuedAt: _issued,
	expiresAt: _expires,
	...identity
} = vector.permit;
const input = {
	...identity,
	approvalExpiresAt: vector.approvalExpiresAt,
	leaseExpiresAt: vector.leaseExpiresAt,
};
const key = Buffer.from(vector.keyHex, "hex");
it("matches the independent Python HMAC vector shared with the Go provider", () => {
	expect(signDispatchPermit(input, key, vector.now)).toEqual({
		permitJson: vector.canonical,
		signature: vector.signature,
	});
});
it.each(["approvalExpiresAt", "leaseExpiresAt"])(
	"never extends %s",
	(field) => {
		expect(() =>
			signDispatchPermit({ ...input, [field]: vector.now }, key, vector.now),
		).toThrow("write_permit_invalid");
		const result = signDispatchPermit(
			{ ...input, [field]: vector.now + 1000 },
			key,
			vector.now,
		);
		expect(JSON.parse(result.permitJson).expiresAt).toBe(vector.now + 1000);
	},
);
it("caps dispatch to sixty seconds even when approval and lease last longer", () => {
	const result = signDispatchPermit(
		{
			...input,
			approvalExpiresAt: vector.now + 120000,
			leaseExpiresAt: vector.now + 120000,
		},
		key,
		vector.now,
	);
	expect(JSON.parse(result.permitJson).expiresAt).toBe(vector.now + 60000);
});
it.each([
	{ purpose: "ship" },
	{ accountEpoch: 0.5 },
	{ accountUserId: "\ud800" },
	{ unknown: true },
])("rejects malformed authority input %j", (change) => {
	expect(() =>
		signDispatchPermit({ ...input, ...change }, key, vector.now),
	).toThrow("write_permit_invalid");
});
it("refuses undersized or substituted non-byte keys", () => {
	expect(() => signDispatchPermit(input, Buffer.alloc(16), vector.now)).toThrow(
		"write_permit_invalid",
	);
	expect(() =>
		signDispatchPermit(input, "secret" as unknown as Buffer, vector.now),
	).toThrow("write_permit_invalid");
});
