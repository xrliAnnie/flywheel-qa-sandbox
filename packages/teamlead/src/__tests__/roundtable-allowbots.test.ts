import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	findOpenNonRoundtableGroups,
	isRoundtableMember,
	parseRegistry,
	reconcile,
	resolveSelfIdentity,
	unionAllowBots,
} from "../roundtable-allowbots.js";

const ROUNDTABLE = "1512578695468941333";

// --- pure: unionAllowBots ---------------------------------------------------
describe("unionAllowBots", () => {
	it("appends only genuinely-new ids, preserving existing order", () => {
		const r = unionAllowBots(["a", "b"], ["b", "c", "d"]);
		expect(r.allowBots).toEqual(["a", "b", "c", "d"]);
		expect(r.changed).toBe(true);
	});

	it("is a no-op (changed=false) when peers add nothing", () => {
		const r = unionAllowBots(["a", "b", "c"], ["a", "c"]);
		expect(r.allowBots).toEqual(["a", "b", "c"]);
		expect(r.changed).toBe(false);
	});

	it("treats absent existing as empty", () => {
		const r = unionAllowBots(undefined, ["x", "x", "y"]);
		expect(r.allowBots).toEqual(["x", "y"]);
		expect(r.changed).toBe(true);
	});

	it("de-dupes peers among themselves", () => {
		const r = unionAllowBots([], ["p", "p", "q", "q"]);
		expect(r.allowBots).toEqual(["p", "q"]);
	});

	it("treats a corrupt non-array existing as empty (LOW-2, no char-spread)", () => {
		const r = unionAllowBots("abc" as unknown as string[], ["x", "y"]);
		expect(r.allowBots).toEqual(["x", "y"]);
		expect(r.changed).toBe(true);
	});
});

// --- pure: isRoundtableMember ----------------------------------------------
describe("isRoundtableMember", () => {
	it("true when a channel id is in groups", () => {
		expect(
			isRoundtableMember({ groups: { [ROUNDTABLE]: {} } }, [ROUNDTABLE]),
		).toBe(true);
	});
	it("false when no configured channel is in groups", () => {
		expect(isRoundtableMember({ groups: { "999": {} } }, [ROUNDTABLE])).toBe(
			false,
		);
	});
	it("false when groups absent", () => {
		expect(isRoundtableMember({}, [ROUNDTABLE])).toBe(false);
	});
	it("false when no channel ids configured", () => {
		expect(isRoundtableMember({ groups: { [ROUNDTABLE]: {} } }, [])).toBe(
			false,
		);
	});
});

// --- resolveSelfIdentity (mock fetch) --------------------------------------
describe("resolveSelfIdentity", () => {
	const okFetch = (body: unknown): typeof fetch =>
		(async () => ({
			ok: true,
			status: 200,
			json: async () => body,
		})) as unknown as typeof fetch;

	it("maps /users/@me, preferring global_name then username", async () => {
		const id = await resolveSelfIdentity(
			"tok",
			okFetch({ id: "123", username: "raw", global_name: "Nice Name" }),
		);
		expect(id).toEqual({ id: "123", name: "Nice Name" });
	});

	it("falls back to username when global_name absent", async () => {
		const id = await resolveSelfIdentity(
			"tok",
			okFetch({ id: "9", username: "raw" }),
		);
		expect(id.name).toBe("raw");
	});

	it("throws on a non-200 response", async () => {
		const bad = (async () => ({
			ok: false,
			status: 401,
			json: async () => ({}),
		})) as unknown as typeof fetch;
		await expect(resolveSelfIdentity("tok", bad)).rejects.toThrow();
	});

	it("sends the Bot authorization header", async () => {
		let seenAuth = "";
		const spy = (async (
			_url: string,
			init: { headers: Record<string, string> },
		) => {
			seenAuth = init.headers.Authorization;
			return {
				ok: true,
				status: 200,
				json: async () => ({ id: "1", username: "u" }),
			};
		}) as unknown as typeof fetch;
		await resolveSelfIdentity("SECRET", spy);
		expect(seenAuth).toBe("Bot SECRET");
	});

	it("rejects within the timeout when the fetch never resolves (HIGH-1)", async () => {
		const hang = (() => new Promise(() => {})) as unknown as typeof fetch;
		const start = Date.now();
		await expect(resolveSelfIdentity("tok", hang, 30)).rejects.toThrow(
			/timed out/i,
		);
		expect(Date.now() - start).toBeLessThan(2000);
	});
});

// --- findOpenNonRoundtableGroups (advisory, MEDIUM-2) ----------------------
describe("findOpenNonRoundtableGroups", () => {
	it("flags a non-roundtable group with requireMention:false + empty allowFrom", () => {
		const open = findOpenNonRoundtableGroups(
			{
				groups: {
					[ROUNDTABLE]: { requireMention: true },
					core: { requireMention: false, allowFrom: [] },
				},
			},
			[ROUNDTABLE],
		);
		expect(open).toEqual(["core"]);
	});

	it("ignores the roundtable channel itself", () => {
		const open = findOpenNonRoundtableGroups(
			{ groups: { [ROUNDTABLE]: { requireMention: false, allowFrom: [] } } },
			[ROUNDTABLE],
		);
		expect(open).toEqual([]);
	});

	it("ignores groups that requireMention or restrict allowFrom", () => {
		const open = findOpenNonRoundtableGroups(
			{
				groups: {
					a: { requireMention: true },
					b: { requireMention: false, allowFrom: ["someone"] },
					c: {}, // requireMention defaults to true
				},
			},
			[ROUNDTABLE],
		);
		expect(open).toEqual([]);
	});
});

// --- parseRegistry (real temp dir) -----------------------------------------
describe("parseRegistry", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fly282-reg-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("returns [] for a missing dir without throwing", () => {
		expect(parseRegistry(join(dir, "nope"))).toEqual([]);
	});

	it("reads valid entries and skips corrupt / empty / non-json", () => {
		writeFileSync(
			join(dir, "a.json"),
			JSON.stringify({ leadId: "a", botUserId: "1" }),
		);
		writeFileSync(
			join(dir, "b.json"),
			JSON.stringify({ leadId: "b", botUserId: "2" }),
		);
		writeFileSync(join(dir, "bad.json"), "{not json");
		writeFileSync(join(dir, "empty.json"), "");
		writeFileSync(
			join(dir, "ignore.txt"),
			JSON.stringify({ leadId: "c", botUserId: "3" }),
		);
		const ids = parseRegistry(dir)
			.map((e) => e.botUserId)
			.sort();
		expect(ids).toEqual(["1", "2"]);
	});

	it("skips entries missing botUserId", () => {
		writeFileSync(join(dir, "x.json"), JSON.stringify({ leadId: "x" }));
		expect(parseRegistry(dir)).toEqual([]);
	});
});

// --- reconcile (orchestrator) ----------------------------------------------
describe("reconcile", () => {
	let root: string;
	let registryDir: string;
	let accessFile: string;
	const okFetch = (id: string, name = "Bot"): typeof fetch =>
		(async () => ({
			ok: true,
			status: 200,
			json: async () => ({ id, username: name }),
		})) as unknown as typeof fetch;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "fly282-"));
		registryDir = join(root, "registry");
		accessFile = join(root, "access.json");
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	const writeAccess = (a: unknown) =>
		writeFileSync(accessFile, JSON.stringify(a, null, 2));
	const readAccess = () => JSON.parse(readFileSync(accessFile, "utf8"));

	it("no-op when access.json is absent", async () => {
		const r = await reconcile({
			leadId: "x",
			token: "t",
			accessFile,
			registryDir,
			channelIds: [ROUNDTABLE],
			fetchImpl: okFetch("1"),
		});
		expect(r.member).toBe(false);
		expect(r.allowBotsChanged).toBe(false);
	});

	it("no-op (does not touch access.json) when not a roundtable member", async () => {
		writeAccess({
			groups: { "999": { requireMention: true } },
			allowBots: ["keep"],
		});
		const before = readFileSync(accessFile, "utf8");
		const r = await reconcile({
			leadId: "x",
			token: "t",
			accessFile,
			registryDir,
			channelIds: [ROUNDTABLE],
			fetchImpl: okFetch("1"),
		});
		expect(r.member).toBe(false);
		expect(readFileSync(accessFile, "utf8")).toBe(before);
	});

	const seedPeer = (leadId: string, botUserId: string) => {
		mkdirSync(registryDir, { recursive: true });
		writeFileSync(
			join(registryDir, `${leadId}.json`),
			JSON.stringify({ leadId, botUserId }),
		);
	};

	it("publishes own identity and unions registered peer ids into allowBots", async () => {
		seedPeer("peer", "PEER"); // a peer already registered by another lead
		writeAccess({
			groups: { [ROUNDTABLE]: { requireMention: true } },
			allowBots: ["existing"],
		});
		const r = await reconcile({
			leadId: "simba",
			token: "t",
			accessFile,
			registryDir,
			channelIds: [ROUNDTABLE],
			fetchImpl: okFetch("SIMBA"),
			now: () => 1234,
		});
		expect(r.member).toBe(true);
		expect(r.published).toBe(true);
		expect(r.selfId).toBe("SIMBA");
		// registry file written for self
		const self = JSON.parse(
			readFileSync(join(registryDir, "simba.json"), "utf8"),
		);
		expect(self.botUserId).toBe("SIMBA");
		expect(self.updatedAt).toBe(1234);
		// allowBots gained self + peer, kept existing, no duplicates
		const allow = readAccess().allowBots as string[];
		expect(allow).toContain("existing");
		expect(allow).toContain("SIMBA");
		expect(allow).toContain("PEER");
		expect(new Set(allow).size).toBe(allow.length);
	});

	it("consumes an existing peer registered by another lead", async () => {
		seedPeer("cass", "CASS"); // simulating cass's own prior run
		writeAccess({ groups: { [ROUNDTABLE]: {} }, allowBots: [] });
		const r = await reconcile({
			leadId: "simba",
			token: "t",
			accessFile,
			registryDir,
			channelIds: [ROUNDTABLE],
			fetchImpl: okFetch("SIMBA"),
		});
		expect(r.allowBotsChanged).toBe(true);
		expect(readAccess().allowBots).toContain("CASS");
	});

	it("is idempotent — a second run makes no change", async () => {
		writeAccess({ groups: { [ROUNDTABLE]: {} }, allowBots: [] });
		await reconcile({
			leadId: "simba",
			token: "t",
			accessFile,
			registryDir,
			channelIds: [ROUNDTABLE],
			fetchImpl: okFetch("SIMBA"),
		});
		const afterFirst = readFileSync(accessFile, "utf8");
		const r2 = await reconcile({
			leadId: "simba",
			token: "t",
			accessFile,
			registryDir,
			channelIds: [ROUNDTABLE],
			fetchImpl: okFetch("SIMBA"),
		});
		expect(r2.allowBotsChanged).toBe(false);
		expect(readFileSync(accessFile, "utf8")).toBe(afterFirst);
	});

	it("preserves all other access.json fields", async () => {
		writeAccess({
			dmPolicy: "allowlist",
			allowFrom: ["annie"],
			groups: { [ROUNDTABLE]: { requireMention: true } },
			mentionPatterns: ["\\bSimba\\b"],
			allowBots: ["old"],
		});
		await reconcile({
			leadId: "simba",
			token: "t",
			accessFile,
			registryDir,
			channelIds: [ROUNDTABLE],
			fetchImpl: okFetch("SIMBA"),
		});
		const a = readAccess();
		expect(a.dmPolicy).toBe("allowlist");
		expect(a.allowFrom).toEqual(["annie"]);
		expect(a.mentionPatterns).toEqual(["\\bSimba\\b"]);
		expect(a.groups[ROUNDTABLE]).toEqual({ requireMention: true });
	});

	it("still consumes existing peers when own identity resolution fails", async () => {
		seedPeer("peer", "PEER");
		writeAccess({ groups: { [ROUNDTABLE]: {} }, allowBots: [] });
		const failFetch = (async () => ({
			ok: false,
			status: 500,
			json: async () => ({}),
		})) as unknown as typeof fetch;
		const r = await reconcile({
			leadId: "simba",
			token: "t",
			accessFile,
			registryDir,
			channelIds: [ROUNDTABLE],
			fetchImpl: failFetch,
		});
		expect(r.published).toBe(false);
		expect(readAccess().allowBots).toContain("PEER");
	});

	it("writes access.json with 0600 permissions", async () => {
		writeAccess({ groups: { [ROUNDTABLE]: {} }, allowBots: [] });
		await reconcile({
			leadId: "simba",
			token: "t",
			accessFile,
			registryDir,
			channelIds: [ROUNDTABLE],
			fetchImpl: okFetch("SIMBA"),
		});
		const mode = statSync(accessFile).mode & 0o777;
		expect(mode).toBe(0o600);
	});

	it("does not hang when identity resolution stalls; still consumes peers (HIGH-1)", async () => {
		seedPeer("peer", "PEER");
		writeAccess({ groups: { [ROUNDTABLE]: {} }, allowBots: [] });
		const hang = (() => new Promise(() => {})) as unknown as typeof fetch;
		const start = Date.now();
		const r = await reconcile({
			leadId: "simba",
			token: "t",
			accessFile,
			registryDir,
			channelIds: [ROUNDTABLE],
			fetchImpl: hang,
			identityTimeoutMs: 30,
		});
		expect(Date.now() - start).toBeLessThan(2000);
		expect(r.published).toBe(false);
		expect(readAccess().allowBots).toContain("PEER");
	});

	it("repairs a corrupt non-array allowBots to a clean array (LOW-2)", async () => {
		seedPeer("peer", "PEER");
		writeAccess({ groups: { [ROUNDTABLE]: {} }, allowBots: "corrupt" });
		const r = await reconcile({
			leadId: "simba",
			token: "t",
			accessFile,
			registryDir,
			channelIds: [ROUNDTABLE],
			fetchImpl: okFetch("SIMBA"),
		});
		expect(r.allowBotsChanged).toBe(true);
		const allow = readAccess().allowBots;
		expect(Array.isArray(allow)).toBe(true);
		expect(allow).toContain("PEER");
		// no character-spread of the corrupt "corrupt" string
		expect(allow).not.toContain("c");
	});

	it("reports open non-roundtable groups as an advisory (MEDIUM-2)", async () => {
		writeAccess({
			groups: {
				[ROUNDTABLE]: { requireMention: true },
				core: { requireMention: false, allowFrom: [] },
			},
			allowBots: [],
		});
		const r = await reconcile({
			leadId: "simba",
			token: "t",
			accessFile,
			registryDir,
			channelIds: [ROUNDTABLE],
			fetchImpl: okFetch("SIMBA"),
		});
		expect(r.openNonRoundtableGroups).toEqual(["core"]);
	});
});
