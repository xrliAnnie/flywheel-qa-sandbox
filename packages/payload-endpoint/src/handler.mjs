// FLY-1062 PR3 · the gated distribution endpoint — pure request handler.
//
// handleRequest(request, {bucket, secrets, now, log}) is the SINGLE trusted
// write choke point for the distribution bucket (plan §0): customer reads go
// through entitlement views, every manifest change goes through one
// etag-CAS'd POST with full-invariant validation + capability diff
// classification, payload objects are immutable-once-written, and cleanup is
// guarded by the tombstone protocol. Deployed as a Cloudflare Worker
// (worker.mjs) and tested hermetically in node — same bytes both places.
//
// Security posture:
//   • customer auth failures are byte-identical 401s (no enumeration);
//   • payload 404s are byte-identical whether the version is unknown,
//     quarantined, expired, or out-of-entitlement;
//   • keys / key hashes / capability tokens never reach a log line or an
//     error body (log() receives route TEMPLATES, never raw paths).

import { normalizeEtag } from "./etag.mjs";
import {
	ENTITLEMENT_POINTER,
	isPayloadSemver,
	keyObjectKey,
	latestSet,
	MANIFEST_KEY,
	POINTER_CAPABILITY,
	payloadObjectKey,
	RETENTION_WINDOW_MS,
} from "./manifest.mjs";
import { applyTransition, capabilityAllows } from "./transitions.mjs";
import { isEmptyInitialManifest, validateManifest } from "./validator.mjs";
import { manifestView, visibleEntries } from "./views.mjs";

const enc = new TextEncoder();
const BETA_CAPABILITY = POINTER_CAPABILITY[ENTITLEMENT_POINTER.internal];
const RELEASE_CAPABILITY = POINTER_CAPABILITY[ENTITLEMENT_POINTER.customer];

async function sha256Hex(text) {
	const digest = await crypto.subtle.digest("SHA-256", enc.encode(text));
	return [...new Uint8Array(digest)]
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

// constant-time hex comparison (we compare HASHES of tokens, so a timing
// leak would reveal nothing usable anyway — belt and braces).
function ctEqualHex(a, b) {
	if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length)
		return false;
	let r = 0;
	for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return r === 0;
}

function bearer(request) {
	const h = request.headers.get("authorization") || "";
	const m = /^Bearer\s+(.+)$/.exec(h);
	return m ? m[1] : null;
}

function json(status, body, headers = {}) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json", ...headers },
	});
}

// byte-identical rejection shapes (anti-enumeration)
const customer401 = () => json(401, { error: "invalid or revoked key" });
const uniform404 = () => json(404, { error: "not found" });
const downloadUnavailable = () => json(503, { error: "download unavailable" });

async function readManifest(bucket) {
	const obj = await bucket.get(MANIFEST_KEY);
	if (!obj) return null;
	return { manifest: await obj.json(), etag: obj.etag, httpEtag: obj.httpEtag };
}

// capability <request, secrets> → "beta-publish" | "customer-release" |
// "ops-admin" | null. Worker secrets hold sha256(token) per capability.
async function capabilityOf(request, secrets) {
	const token = bearer(request);
	if (!token) return null;
	const presented = await sha256Hex(token);
	const table = [
		[BETA_CAPABILITY, secrets.betaPublishTokenSha256],
		[RELEASE_CAPABILITY, secrets.customerReleaseTokenSha256],
		["ops-admin", secrets.opsAdminTokenSha256],
		["cleanup", secrets.cleanupTokenSha256],
	];
	const hashes = table
		.map(([, hash]) => (typeof hash === "string" ? hash.toLowerCase() : ""))
		.filter(Boolean);
	if (new Set(hashes).size !== hashes.length) return "invalid-configuration";
	for (const [cap, hash] of table) {
		if (
			typeof hash === "string" &&
			hash &&
			ctEqualHex(presented, hash.toLowerCase())
		)
			return cap;
	}
	return null;
}

async function customerAuth(request, bucket) {
	const key = bearer(request);
	if (!key || enc.encode(key).byteLength > 512) return null;
	let rec;
	try {
		const obj = await bucket.get(keyObjectKey(await sha256Hex(key)));
		if (!obj) return null;
		rec = await obj.json();
	} catch {
		return null;
	}
	if (rec?.revoked !== false) return null;
	if (rec.entitlement !== "customer" && rec.entitlement !== "internal")
		return null;
	return rec;
}

// live claim: a reserved/prepared releaseOps record whose objectKey is
// EXACTLY this key (Codex R6: any live claim keeps the object — an abandoned
// claim's key may have been taken over by a new releaseId).
function hasLiveClaim(manifest, objectKey) {
	return Object.values(manifest.releaseOps ?? {}).some(
		(op) =>
			op &&
			(op.state === "reserved" || op.state === "prepared") &&
			op.objectKey === objectKey,
	);
}

export async function handleRequest(request, deps) {
	const { bucket, secrets, now } = deps;
	const requestStartedAt = now().getTime();
	const log = deps.log ?? (() => {});
	const url = new URL(request.url);
	const path = url.pathname;
	const method = request.method;

	const respond = (route, res) => {
		if (!path.startsWith("/admin/"))
			res.headers.set("Cache-Control", "private, no-store");
		log(`${method} ${route} ${res.status}`);
		return res;
	};

	try {
		// ── customer surface ─────────────────────────────────────────────────
		if (method === "GET" && path === "/manifest") {
			const rec = await customerAuth(request, bucket);
			if (!rec) return respond("/manifest", customer401());
			const cur = await readManifest(bucket);
			if (!cur)
				return respond("/manifest", json(503, { error: "not activated" }));
			if (validateManifest(cur.manifest).length)
				return respond("/manifest", downloadUnavailable());
			const view = manifestView(
				cur.manifest,
				rec.entitlement,
				requestStartedAt,
			);
			if (view.empty)
				return respond(
					"/manifest",
					json(503, {
						error:
							view.reason === "paused"
								? "no-release-available"
								: "not activated",
					}),
				);
			return respond("/manifest", json(200, view.view));
		}

		if (method === "GET" && /^\/payload\/[^/]+$/.test(path)) {
			const rec = await customerAuth(request, bucket);
			if (!rec) return respond("/payload/:ver", customer401());
			const cur = await readManifest(bucket);
			if (!cur || validateManifest(cur.manifest).length)
				return respond("/payload/:ver", downloadUnavailable());
			let ver;
			try {
				ver = decodeURIComponent(path.slice("/payload/".length));
			} catch {
				return respond("/payload/:ver", uniform404());
			}
			if (!isPayloadSemver(ver)) return respond("/payload/:ver", uniform404());
			// fetch THROUGH the visible set (Codex R1#3) — never by URL-derived
			// object path; out-of-set = the same 404 bytes as unknown.
			const entry = visibleEntries(
				cur.manifest,
				rec.entitlement,
				requestStartedAt,
			).get(ver);
			if (!entry) return respond("/payload/:ver", uniform404());
			if (deps.delivery?.mode === "presigned") {
				if (typeof deps.delivery.signGet !== "function")
					return respond("/payload/:ver", downloadUnavailable());
				const head = await bucket.head(entry.key);
				if (
					!head ||
					head.size !== entry.size ||
					head.customMetadata?.sha256 !== entry.sha256
				)
					return respond("/payload/:ver", uniform404());
				const issuedAt = Math.floor(requestStartedAt / 1000) * 1000;
				const expiresIn = latestSet(cur.manifest).has(ver)
					? 60
					: Math.min(
							60,
							Math.floor(
								(Date.parse(entry.retentionSince) +
									RETENTION_WINDOW_MS[entry.channel] -
									issuedAt) /
									1000,
							),
						);
				if (expiresIn <= 0) return respond("/payload/:ver", uniform404());
				const expiresAt = issuedAt + expiresIn * 1000;
				if (now().getTime() >= expiresAt)
					return respond("/payload/:ver", downloadUnavailable());
				const location = await deps.delivery.signGet({
					objectKey: entry.key,
					issuedAt,
					expiresIn,
				});
				if (now().getTime() >= expiresAt)
					return respond("/payload/:ver", downloadUnavailable());
				return respond(
					"/payload/:ver",
					new Response(null, {
						status: 302,
						headers: {
							Location: location,
							"Cache-Control": "private, no-store",
							"Referrer-Policy": "no-referrer",
						},
					}),
				);
			}
			if (deps.delivery?.mode !== "stream")
				return respond("/payload/:ver", downloadUnavailable());
			const obj = await bucket.get(entry.key);
			if (!obj) return respond("/payload/:ver", uniform404());
			return respond(
				"/payload/:ver",
				new Response(obj.body, {
					status: 200,
					headers: { "content-type": "application/octet-stream" },
				}),
			);
		}

		// ── admin surface ────────────────────────────────────────────────────
		if (path.startsWith("/admin/")) {
			const cap = await capabilityOf(request, secrets);
			if (cap === "invalid-configuration")
				return respond(
					"/admin/*",
					json(503, { error: "capability configuration invalid" }),
				);
			if (!cap)
				return respond("/admin/*", json(401, { error: "unauthorized" }));

			if (method === "GET" && path === "/admin/manifest") {
				const cur = await readManifest(bucket);
				if (!cur)
					return respond(
						"/admin/manifest",
						json(404, { error: "no manifest yet" }),
					);
				return respond(
					"/admin/manifest",
					json(200, cur.manifest, { etag: cur.httpEtag ?? `"${cur.etag}"` }),
				);
			}

			if (method === "POST" && path === "/admin/manifest") {
				const route = "/admin/manifest";
				let body;
				try {
					body = await request.json();
				} catch {
					return respond(
						route,
						json(400, { error: "body must be JSON {baseEtag, manifest}" }),
					);
				}
				if (!body || typeof body !== "object" || !("manifest" in body)) {
					return respond(
						route,
						json(400, { error: "body must be JSON {baseEtag, manifest}" }),
					);
				}
				const cur = await readManifest(bucket);
				if (!cur) {
					if (cap === "cleanup")
						return respond(route, json(403, { error: "forbidden" }));
					// conditional create (plan §B0-7): base must be null and the
					// initial state exactly the empty shape.
					if (body.baseEtag !== null) {
						return respond(
							route,
							json(412, { error: "no manifest exists; baseEtag must be null" }),
						);
					}
					if (!isEmptyInitialManifest(body.manifest)) {
						return respond(
							route,
							json(422, {
								error:
									"initial manifest must be the empty shape (dual null channels)",
							}),
						);
					}
					const created = await bucket.put(
						MANIFEST_KEY,
						JSON.stringify(body.manifest),
						{
							onlyIf: { etagDoesNotMatch: "*" },
						},
					);
					if (!created)
						return respond(route, json(412, { error: "etag mismatch" }));
					return respond(
						route,
						json(200, { ok: true, etag: created.httpEtag }),
					);
				}
				let baseEtag = null;
				if (body.baseEtag !== null) {
					try {
						baseEtag = normalizeEtag(body.baseEtag);
					} catch {
						return respond(route, json(400, { error: "bad baseEtag" }));
					}
				}
				if (baseEtag !== cur.etag) {
					return respond(route, json(412, { error: "etag mismatch" }));
				}
				const {
					manifest: stamped,
					ops,
					errs,
				} = applyTransition(cur.manifest, body.manifest, now);
				if (errs.length) {
					return respond(
						route,
						json(422, { error: "illegal transition", violations: errs }),
					);
				}
				const refused = ops.filter((op) => !capabilityAllows(cap, op));
				if (refused.length) {
					return respond(
						route,
						json(403, {
							error: "capability does not allow this diff",
							refused: refused.map((op) => op.type),
						}),
					);
				}
				const violations = validateManifest(stamped);
				if (violations.length) {
					return respond(
						route,
						json(422, { error: "validation failed", violations }),
					);
				}
				// commit hard gate (plan §B0-2 invariant 6): a NEW version entry's
				// object must exist with byte-matching identity metadata.
				for (const op of ops) {
					if (op.type !== "addVersion") continue;
					const entry = stamped.versions[op.ver];
					const head = await bucket.head(entry.key);
					if (
						!head ||
						head.size !== entry.size ||
						head.customMetadata?.sha256 !== entry.sha256
					) {
						return respond(
							route,
							json(409, {
								error: `commit refused: object for ${op.ver} missing or metadata mismatch`,
							}),
						);
					}
				}
				const put = await bucket.put(MANIFEST_KEY, JSON.stringify(stamped), {
					onlyIf: { etagMatches: cur.etag },
				});
				if (!put) return respond(route, json(412, { error: "etag mismatch" }));
				return respond(route, json(200, { ok: true, etag: put.httpEtag }));
			}

			const payloadMatch = /^\/admin\/payload\/([^/]+)\/([0-9a-f]{64})$/.exec(
				path,
			);
			if (payloadMatch) {
				const route = "/admin/payload/:ver/:sha";
				const ver = decodeURIComponent(payloadMatch[1]);
				const sha = payloadMatch[2];
				if (!isPayloadSemver(ver)) {
					return respond(route, json(400, { error: "bad version" }));
				}
				const objectKey = payloadObjectKey(ver, sha);

				if (method === "GET") {
					if (cap !== BETA_CAPABILITY && cap !== RELEASE_CAPABILITY) {
						return respond(route, json(403, { error: "forbidden" }));
					}
					const obj = await bucket.get(objectKey);
					if (!obj) return respond(route, json(404, { error: "not found" }));
					return respond(
						route,
						new Response(obj.body, {
							status: 200,
							headers: { "content-type": "application/octet-stream" },
						}),
					);
				}

				if (method === "PUT") {
					if (cap !== BETA_CAPABILITY && cap !== RELEASE_CAPABILITY) {
						return respond(route, json(403, { error: "forbidden" }));
					}
					const cur = await readManifest(bucket);
					if (!cur)
						return respond(
							route,
							json(409, { error: "no manifest — nothing reserved" }),
						);
					if ((cur.manifest.tombstones ?? []).includes(objectKey)) {
						return respond(
							route,
							json(409, { error: "conflict: object key is tombstoned" }),
						);
					}
					// durable-claim gate (Codex R4#2): the tuple must already be
					// registered on a reserved/prepared op — every staging object is
					// discoverable from the manifest BEFORE its first byte lands.
					if (!hasLiveClaim(cur.manifest, objectKey)) {
						return respond(
							route,
							json(409, { error: "no live claim for this object" }),
						);
					}
					if (await bucket.head(objectKey)) {
						return respond(
							route,
							json(409, { error: "object already exists (immutable)" }),
						);
					}
					let put;
					try {
						put = await bucket.put(objectKey, request.body, {
							sha256: sha,
							onlyIf: { etagDoesNotMatch: "*" },
							customMetadata: { sha256: sha, ver },
							httpMetadata: { cacheControl: "private, no-store" },
						});
					} catch {
						return respond(
							route,
							json(400, { error: "payload sha256 mismatch" }),
						);
					}
					if (!put) {
						return respond(
							route,
							json(409, { error: "object already exists (immutable)" }),
						);
					}
					// A claim may have committed while PUT returned. Only tombstone
					// sweep deletes: a post-check read cannot guard a later delete.
					const after = await readManifest(bucket);
					const tombstoned = (after?.manifest.tombstones ?? []).includes(
						objectKey,
					);
					if (
						!after ||
						tombstoned ||
						(!hasLiveClaim(after.manifest, objectKey) &&
							!Object.values(after.manifest.versions).some(
								(entry) =>
									entry.key === objectKey && entry.status !== "expired",
							))
					) {
						return respond(
							route,
							json(409, { error: "claim lost during upload" }),
						);
					}
					return respond(route, json(200, { ok: true }));
				}

				if (method === "DELETE") {
					if (cap !== "ops-admin" && cap !== "cleanup")
						return respond(route, json(403, { error: "forbidden" }));
					const cur = await readManifest(bucket);
					// two-step delete (Codex R4#1): the tombstone CAS is the guard —
					// physical deletion is only reachable for tombstoned keys.
					if (!cur || !(cur.manifest.tombstones ?? []).includes(objectKey)) {
						return respond(
							route,
							json(409, { error: "refused: key not tombstoned" }),
						);
					}
					await bucket.delete(objectKey);
					return respond(route, json(200, { ok: true }));
				}
			}

			const keyMatch = /^\/admin\/key\/([0-9a-f]{64})(\/revoke)?$/.exec(path);
			if (keyMatch) {
				const route = keyMatch[2]
					? "/admin/key/:sha/revoke"
					: "/admin/key/:sha";
				if (cap !== "ops-admin")
					return respond(route, json(403, { error: "forbidden" }));
				const objectKey = keyObjectKey(keyMatch[1]);

				if (method === "PUT" && !keyMatch[2]) {
					let body;
					try {
						const reader = request.body?.getReader();
						const bytes = new Uint8Array(4096);
						let size = 0;
						if (reader) {
							try {
								while (true) {
									const { done, value } = await reader.read();
									if (done) break;
									if (size + value.byteLength > bytes.length) {
										void reader.cancel().catch(() => {});
										return respond(
											route,
											json(413, { error: "key record too large" }),
										);
									}
									bytes.set(value, size);
									size += value.byteLength;
								}
							} finally {
								reader.releaseLock();
							}
						}
						body = JSON.parse(
							new TextDecoder().decode(bytes.subarray(0, size)),
						);
					} catch {
						return respond(
							route,
							json(400, { error: "body must be a JSON key record" }),
						);
					}
					if (
						!body ||
						typeof body.customerId !== "string" ||
						!body.customerId.trim() ||
						body.customerId.length > 128 ||
						(body.entitlement !== "customer" &&
							body.entitlement !== "internal") ||
						body.revoked !== false ||
						(body.note !== undefined &&
							(typeof body.note !== "string" || body.note.length > 512)) ||
						Object.keys(body).some(
							(key) =>
								!["customerId", "entitlement", "revoked", "note"].includes(key),
						)
					) {
						return respond(
							route,
							json(400, {
								error:
									"key record must be {customerId, entitlement, revoked:false}",
							}),
						);
					}
					// pre-activation guard (plan §B0-4): no key issuance while the
					// entitlement's channel has no published pointer.
					const cur = await readManifest(bucket);
					const pointer = ENTITLEMENT_POINTER[body.entitlement];
					if (!cur || cur.manifest.channels?.[pointer]?.latest == null) {
						return respond(
							route,
							json(409, {
								error:
									"refused: entitlement channel has no published release yet",
							}),
						);
					}
					let existing = await bucket.get(objectKey);
					if (!existing) {
						const created = await bucket.put(
							objectKey,
							JSON.stringify({
								customerId: body.customerId,
								entitlement: body.entitlement,
								revoked: false,
								createdAt: now().toISOString(),
								note: body.note ?? "",
							}),
							{ onlyIf: { etagDoesNotMatch: "*" } },
						);
						if (created) return respond(route, json(200, { ok: true }));
						existing = await bucket.get(objectKey);
					}
					let prev;
					try {
						prev = await existing?.json();
					} catch {
						return respond(
							route,
							json(409, { error: "key record unreadable" }),
						);
					}
					if (
						prev?.revoked === false &&
						prev.customerId === body.customerId &&
						prev.entitlement === body.entitlement &&
						(prev.note ?? "") === (body.note ?? "")
					) {
						return respond(route, json(200, { ok: true }));
					}
					return respond(route, json(409, { error: "key already exists" }));
				}

				if (method === "POST" && keyMatch[2]) {
					const existing = await bucket.get(objectKey);
					if (!existing)
						return respond(route, json(404, { error: "no such key" }));
					let rec;
					try {
						rec = await existing.json();
					} catch {
						return respond(
							route,
							json(409, { error: "key record unreadable" }),
						);
					}
					if (
						!rec ||
						typeof rec.customerId !== "string" ||
						!rec.customerId.trim() ||
						(rec.entitlement !== "customer" &&
							rec.entitlement !== "internal") ||
						typeof rec.revoked !== "boolean"
					) {
						return respond(
							route,
							json(409, { error: "key record unreadable" }),
						);
					}
					if (rec.revoked === true)
						return respond(route, json(200, { ok: true }));
					rec.revoked = true;
					await bucket.put(objectKey, JSON.stringify(rec));
					return respond(route, json(200, { ok: true }));
				}
			}

			return respond("/admin/*", uniform404());
		}

		return respond(path.startsWith("/admin") ? "/admin/*" : "/*", uniform404());
	} catch {
		if (path === "/manifest" || path.startsWith("/payload/")) {
			return respond(
				path === "/manifest" ? "/manifest" : "/payload/:ver",
				downloadUnavailable(),
			);
		}
		// never leak internals — a handler bug surfaces as an opaque 500.
		return json(500, { error: "internal error" });
	}
}
