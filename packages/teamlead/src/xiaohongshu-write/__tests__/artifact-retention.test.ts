import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { XhsFrozenArtifactStore } from "../artifacts.js";
import { contentDigest } from "../canonical.js";
import { freezeWrite } from "../contracts.js";
import { XhsWriteStore } from "../store.js";
import { fixture, NOW } from "./store-fixture.js";

const day = 86400_000;
const roots: string[] = [];
const stores: XhsWriteStore[] = [];
afterEach(() => {
	for (const store of stores.splice(0)) store.close();
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
async function setup() {
	const root = mkdtempSync(join(tmpdir(), "xhs-retention-"));
	roots.push(root);
	const mediaRoot = join(root, "media");
	mkdirSync(mediaRoot, { mode: 0o700 });
	const path = join(root, "ledger.db");
	const store = new XhsWriteStore(path, {
		initialize: true,
		providerGeneration: "generation-a",
	});
	stores.push(store);
	store.setDispatchEnabled(true, NOW);
	const media = new XhsFrozenArtifactStore(mediaRoot, store, {
		attachmentLimit: 1024,
		validate: async () => {},
	});
	const bytes = Buffer.from("89504e470d0a1a0a0000000049454e44ae426082", "hex");
	const artifact = await media.import(
		"project-a",
		"image/png",
		(async function* () {
			yield bytes;
		})(),
		NOW,
	);
	const seed = fixture();
	const frozen = freezeWrite(
		{
			...seed.frozen,
			proposalId: randomUUID(),
			operationId: "xiaohongshu.publish_content",
			target: null,
			payload: { title: "标题", content: "正文" },
			media: [artifact],
		},
		NOW,
	);
	const identity = seed.identity;
	const receiptId = randomUUID();
	const decision = {
		...seed.decision,
		receiptId,
		proposalId: frozen.proposalId,
		contentDigest: contentDigest(frozen),
	};
	const request = {
		...seed.request,
		receiptId,
		proposalId: frozen.proposalId,
		contentDigest: contentDigest(frozen),
	};
	seed.close();
	const prepare = (expiresAt = NOW + day) =>
		store.prepare({ frozen, prepareRequestId: "prepare", expiresAt }, NOW);
	const approve = () => {
		prepare();
		store.delivered(
			frozen.proposalId,
			{
				cardId: "card-a",
				previewDigest: "d".repeat(64),
				challenge: "ABCDEFGH",
				guildId: "guild-a",
				channelId: "channel-a",
			},
			NOW,
		);
		store.recordDecision(decision);
	};
	return {
		store,
		media,
		artifact,
		mediaRoot,
		frozen,
		identity,
		request,
		path,
		prepare,
		approve,
	};
}
it("retains orphan media seven days and releases its file/catalog at the boundary", async () => {
	const f = await setup();
	expect(f.media.collect(NOW + 7 * day - 1)).toBe(0);
	expect(f.media.collect(NOW + 7 * day)).toBe(1);
	expect(readdirSync(f.mediaRoot)).toEqual([]);
	expect(f.store.artifact(f.artifact.artifactId, "project-a")).toBeNull();
});
it("protects pending references and keeps terminal media for seven more days", async () => {
	const f = await setup();
	f.prepare(NOW + 20 * day);
	expect(f.media.collect(NOW + 8 * day)).toBe(0);
	f.store.cancel(f.frozen.proposalId, f.identity, NOW + 8 * day);
	expect(f.media.collect(NOW + 15 * day - 1)).toBe(0);
	expect(f.media.collect(NOW + 15 * day)).toBe(1);
	expect(f.store.status(f.frozen.proposalId, f.identity)?.state).toBe(
		"revoked",
	);
});
it("holds unknown media thirty days while preserving consumed decisions and attempts forever", async () => {
	const f = await setup();
	f.approve();
	const claim = f.store.claim(f.request, NOW + 3000);
	if (claim.kind !== "claimed") throw Error("missing claim");
	f.store.finish(claim.attemptId, "unknown", NOW + 4000);
	expect(f.media.collect(NOW + 4000 + 30 * day - 1)).toBe(0);
	expect(f.media.collect(NOW + 4000 + 30 * day)).toBe(1);
	expect(f.store.claim(f.request, NOW + 31 * day).kind).toBe("existing");
	const db = new Database(f.path, { readonly: true });
	try {
		expect(
			db.prepare("SELECT COUNT(*) AS n FROM xhs_write_decision").get(),
		).toEqual({ n: 1 });
		expect(
			db.prepare("SELECT COUNT(*) AS n FROM xhs_write_attempt").get(),
		).toEqual({ n: 1 });
		expect(
			db.prepare("SELECT frozen_json FROM xhs_write_proposal").get(),
		).toEqual({ frozen_json: expect.stringContaining(f.artifact.sha256) });
	} finally {
		db.close();
	}
});
it("never collects an in-flight attempt just because its approval has expired", async () => {
	const f = await setup();
	f.approve();
	f.store.claim(f.request, NOW + 3000);
	expect(f.media.collect(NOW + 90 * day)).toBe(0);
});

it("retains shared media until every proposal reference reaches its retention boundary", async () => {
	const f = await setup();
	f.prepare();
	f.store.cancel(f.frozen.proposalId, f.identity, NOW + 1000);
	const second = { ...f.frozen, proposalId: randomUUID() };
	f.store.prepare(
		{ frozen: second, prepareRequestId: "second", expiresAt: NOW + 9 * day },
		NOW + 8 * day,
	);
	expect(f.media.collect(NOW + 8.5 * day)).toBe(0);
	f.store.cancel(second.proposalId, f.identity, NOW + 9 * day);
	expect(f.media.collect(NOW + 16 * day)).toBe(1);
});
it("counts the seven-day retention from the successful attempt result", async () => {
	const f = await setup();
	f.approve();
	const claim = f.store.claim(f.request, NOW + 3000);
	if (claim.kind !== "claimed") throw Error("missing claim");
	f.store.finish(claim.attemptId, "succeeded", NOW + 5000);
	expect(f.media.collect(NOW + 7 * day + 4999)).toBe(0);
	expect(f.media.collect(NOW + 7 * day + 5000)).toBe(1);
	expect(f.store.status(f.frozen.proposalId, f.identity)?.attempt?.state).toBe(
		"succeeded",
	);
});
