import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonical, contentDigest, parseStrictJson } from "../canonical.js";
import { freezeWrite, validateSchedule } from "../contracts.js";

const now = Date.parse("2026-09-14T20:00:00Z");
function proposal(operationId = "xiaohongshu.publish_content") {
	return {
		schemaVersion: 1,
		purpose: "xiaohongshu_founder_write",
		proposalId: "d95c13f3-0057-4ae7-a654-456eef4ee882",
		requesterUid: 501,
		authorityPolicyVersion: 1,
		projectId: "flywheel",
		leadId: "lead-a",
		operationId,
		account: {
			providerInstanceId: "provider-a",
			accountUserId: "account-a",
			accountEpoch: 1,
			providerGeneration: "generation-a",
		},
		target: operationId.includes("publish")
			? null
			: {
					feedId: "feed-a",
					commentId: operationId.includes("reply") ? "comment-a" : null,
					userId: null,
				},
		payload: operationId.includes("publish")
			? { title: "标题🙂", content: " 精确\r\n文字 é " }
			: operationId.includes("comment")
				? { content: "回复" }
				: {},
		media: operationId.includes("publish")
			? [
					{
						artifactId: "artifact-a",
						sha256: "a".repeat(64),
						sizeBytes: 100,
						mimeType: operationId.includes("video") ? "video/mp4" : "image/png",
					},
				]
			: [],
		upstream: {
			binarySha256: "b".repeat(64),
			toolSchemaDigest: "c".repeat(64),
			guardProtocol: 1,
		},
	};
}

describe("frozen write v1", () => {
	it.each([
		"publish_content",
		"publish_with_video",
		"post_comment_to_feed",
		"reply_comment_in_feed",
		"like_feed",
		"favorite_feed",
	])("normalizes %s with only applicable defaults", (operation) => {
		const frozen = freezeWrite(proposal(`xiaohongshu.${operation}`), now);
		expect(contentDigest(frozen)).toMatch(/^[a-f0-9]{64}$/);
		expect(frozen.payload.tags).toEqual([]);
		expect(frozen.payload.unlike).toBe(
			operation === "like_feed" ? false : null,
		);
		expect(frozen.payload.unfavorite).toBe(
			operation === "favorite_feed" ? false : null,
		);
		expect(frozen.payload.visibility).toBe(
			operation.startsWith("publish") ? "公开可见" : null,
		);
		expect(freezeWrite(frozen, now)).toEqual(frozen);
	});
	it("binds every frozen field, preserving whitespace, Unicode and media order", () => {
		const original = freezeWrite(proposal(), now);
		const mutations: Array<(v: any) => void> = [
			(v) => {
				v.proposalId = "8aca0c62-10f7-480e-833c-f422a828287c";
			},
			(v) => v.requesterUid++,
			(v) => v.authorityPolicyVersion++,
			(v) => {
				v.projectId += "b";
			},
			(v) => {
				v.leadId += "b";
			},
			(v) => {
				v.account.providerInstanceId += "b";
			},
			(v) => {
				v.account.accountUserId += "b";
			},
			(v) => v.account.accountEpoch++,
			(v) => {
				v.account.providerGeneration += "b";
			},
			(v) => {
				v.payload.title += "x";
			},
			(v) => {
				v.payload.content += " ";
			},
			(v) => {
				v.payload.content = v.payload.content.normalize("NFC");
			},
			(v) => {
				v.payload.tags = ["tag"];
			},
			(v) => {
				v.payload.visibility = "仅自己可见";
			},
			(v) => {
				v.payload.scheduleAt = "2026-09-15T01:00:00.000Z";
			},
			(v) => {
				v.payload.isOriginal = true;
			},
			(v) => {
				v.media[0].artifactId += "b";
			},
			(v) => {
				v.media[0].sha256 = "d".repeat(64);
			},
			(v) => v.media[0].sizeBytes++,
			(v) => {
				v.media[0].mimeType = "image/jpeg";
			},
			(v) => {
				v.upstream.binarySha256 = "d".repeat(64);
			},
			(v) => {
				v.upstream.toolSchemaDigest = "e".repeat(64);
			},
		];
		for (const mutate of mutations) {
			const changed = structuredClone(original);
			mutate(changed);
			expect(contentDigest(freezeWrite(changed, now))).not.toBe(
				contentDigest(original),
			);
		}
		const two = structuredClone(original);
		two.media.push({ ...two.media[0], artifactId: "artifact-b" });
		const reversed = structuredClone(two);
		reversed.media.reverse();
		expect(contentDigest(two)).not.toBe(contentDigest(reversed));
		const tags = structuredClone(original);
		tags.payload.tags = ["a", "b"];
		const reversedTags = structuredClone(tags);
		reversedTags.payload.tags.reverse();
		expect(contentDigest(tags)).not.toBe(contentDigest(reversedTags));
	});
	it("binds exact reply target and inverse actions", () => {
		const reply = freezeWrite(
			proposal("xiaohongshu.reply_comment_in_feed"),
			now,
		);
		for (const key of ["feedId", "commentId", "userId"] as const) {
			const changed = structuredClone(reply);
			changed.target![key] = "changed";
			expect(contentDigest(freezeWrite(changed, now))).not.toBe(
				contentDigest(reply),
			);
		}
		for (const [operation, field] of [
			["like_feed", "unlike"],
			["favorite_feed", "unfavorite"],
		] as const) {
			const before = freezeWrite(proposal(`xiaohongshu.${operation}`), now);
			const after = structuredClone(before);
			after.payload[field] = true;
			expect(contentDigest(freezeWrite(after, now))).not.toBe(
				contentDigest(before),
			);
		}
	});
	it.each([
		(v: any) => {
			v.approved = true;
		},
		(v: any) => {
			v.account.xsec_token = "never-accept";
		},
		(v: any) => {
			v.media[0].path = "/tmp/file";
		},
		(v: any) => {
			v.payload.content = "\ud800";
		},
		(v: any) => {
			v.payload.title = "中".repeat(21);
		},
		(v: any) => {
			v.payload.title = "🙂".repeat(11);
		},
		(v: any) => {
			v.payload.content = "a".repeat(16001);
		},
		(v: any) => {
			v.payload.content = "";
		},
		(v: any) => {
			v.payload.tags = Array(101).fill("a");
		},
		(v: any) => {
			v.payload.tags = ["a".repeat(257)];
		},
		(v: any) => {
			v.payload.unlike = false;
		},
		(v: any) => {
			v.media = [];
		},
		(v: any) => {
			v.media = Array(19).fill(v.media[0]);
		},
		(v: any) => {
			v.media[0].mimeType = "video/mp4";
		},
		(v: any) => {
			v.media[0].sizeBytes = Infinity;
		},
		(v: any) => {
			v.account.accountEpoch = -1;
		},
		(v: any) => {
			v.account.accountUserId = "";
		},
		(v: any) => {
			v.upstream.guardProtocol = 2;
		},
		(v: any) => {
			v.operationId = "xiaohongshu.delete_cookies";
		},
	])("rejects malformed or non-applicable frozen fields (%#)", (mutate) => {
		const input = proposal();
		mutate(input);
		expect(() => freezeWrite(input, now)).toThrow();
	});
	it("rejects ambiguous replies and dynamic products", () => {
		const reply = proposal("xiaohongshu.reply_comment_in_feed");
		reply.target!.commentId = null;
		expect(() => freezeWrite(reply, now)).toThrow("target_unbound");
		expect(() =>
			freezeWrite(
				{
					...proposal(),
					payload: { ...proposal().payload, products: ["search result"] },
				},
				now,
			),
		).toThrow("dynamic_target_unbound");
	});
	it("preserves exact text and matches provider UTF-16 title length", () => {
		const input = proposal();
		input.payload.title = "a".repeat(40);
		expect(freezeWrite(input, now).payload.content).toBe(input.payload.content);
		expect(freezeWrite(input, now).payload.title).toHaveLength(40);
		input.payload.title += "a";
		expect(() => freezeWrite(input, now)).toThrow();
	});
	it("requires a timezone, normalizes UTC, and validates both prepare/send windows", () => {
		const input = {
			...proposal(),
			payload: {
				...proposal().payload,
				scheduleAt: "2026-09-14T19:00:00-07:00",
			},
		};
		const frozen = freezeWrite(input, now);
		expect(frozen.payload.scheduleAt).toBe("2026-09-15T02:00:00.000Z");
		expect(() => validateSchedule(frozen, now + 6 * 3600000)).toThrow(
			"schedule_invalid",
		);
		for (const invalid of [
			"2026-09-15T02:00:00",
			"2026-09-14T20:59:59Z",
			"2026-09-29T20:00:00Z",
			"2026-02-30T20:00:00Z",
		]) {
			input.payload.scheduleAt = invalid;
			expect(() => freezeWrite(input, now)).toThrow("schedule_invalid");
		}
	});
});

describe("unambiguous wire encoding", () => {
	it("sorts keys by UTF-16 and preserves array order and strings", () => {
		expect(canonical({ "\ue000": 1, "😀": 2, a: [null, true, "中\r\n"] })).toBe(
			'{"a":[null,true,"中\\r\\n"],"😀":2,"":1}',
		);
		expect(canonical({ z: 1, a: 2 })).toBe(canonical({ a: 2, z: 1 }));
	});
	it.each([
		'{"a":1,"a":2}',
		'{"a":1,"\\u0061":2}',
		'{"x":{"a":1,"a":2}}',
		'{"a":"\\ud800"}',
		'{"a":1e999}',
		'{"a":1.5}',
		"[1,]",
		'{"a":1}x',
		"[".repeat(40) + "0" + "]".repeat(40),
	])("rejects ambiguous JSON %s", (raw) => {
		expect(() => parseStrictJson(raw)).toThrow();
	});
	it.each([
		NaN,
		Infinity,
		undefined,
		0.5,
		"\udfff",
		new Date(),
		{ bad: undefined },
	])("rejects non-wire canonical values (%#)", (value) => {
		expect(() => canonical(value)).toThrow();
	});
	it("accepts safe object keys without prototype mutation", () => {
		const value = parseStrictJson(
			'{"__proto__":{"polluted":true},"quote":"a\\\"b","n":-1}',
		);
		expect(canonical(value)).toBe(
			'{"__proto__":{"polluted":true},"n":-1,"quote":"a\\\"b"}',
		);
		expect(({} as any).polluted).toBeUndefined();
	});
	it("matches shared canonical golden vectors", () => {
		const vectors = JSON.parse(
			readFileSync(
				new URL("../fixtures/canonical-v1.json", import.meta.url),
				"utf8",
			),
		);
		for (const vector of vectors) {
			expect(canonical(vector.input)).toBe(vector.canonical);
			expect(contentDigest(vector.input)).toBe(vector.digest);
		}
	});
});

it("matches provider frozen-write vectors for all six operations", () => {
	const vectors = JSON.parse(
		readFileSync(
			new URL("../fixtures/frozen-v1.json", import.meta.url),
			"utf8",
		),
	);
	expect(vectors).toHaveLength(6);
	for (const vector of vectors) {
		const frozen = freezeWrite(vector.canonical, vector.now);
		expect(canonical(frozen)).toBe(vector.canonical);
		expect(contentDigest(frozen)).toBe(vector.digest);
	}
});
