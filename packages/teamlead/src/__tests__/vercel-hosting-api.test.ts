import { expect, it, vi } from "vitest";
import {
	SecretRedactor,
	VercelHostingApi,
} from "../bridge/vercel-hosting-api.js";

it("uses the private Hobby-account project/store contracts and normalizes store identity", async () => {
	const calls: Array<{
		path: string;
		method: string;
		body: unknown;
		authorization: string | null;
	}> = [];
	const replies = [
		{ status: 404, body: {} },
		{ body: { id: "prj_a", name: "fw-reports-abc123" } },
		{ body: { store: { id: "store_AbC", access: "private" } } },
		{
			body: {
				store: {
					id: "store_AbC",
					name: "fw-reports-abc123-blob",
					access: "private",
					size: 10,
					count: 1,
					status: "available",
					usageQuotaExceeded: false,
					projectsMetadata: [{ projectId: "prj_a" }],
				},
			},
		},
		{ body: {} },
		{
			body: {
				envs: [
					{
						id: "env_a",
						key: "BLOB_READ_WRITE_TOKEN",
						target: ["production"],
						type: "encrypted",
						contentHint: { storeId: "store_AbC" },
					},
				],
			},
		},
		{
			body: {
				value: "vercel_blob_rw_abc_secret",
				decrypted: true,
				type: "encrypted",
			},
		},
	];
	const fetchImpl = vi.fn(
		async (url: string | URL | Request, init?: RequestInit) => {
			calls.push({
				path: new URL(String(url)).pathname + new URL(String(url)).search,
				method: init?.method ?? "GET",
				body: init?.body ? JSON.parse(String(init.body)) : undefined,
				authorization: new Headers(init?.headers).get("authorization"),
			});
			const reply = replies.shift()!;
			return Response.json(reply.body, { status: reply.status ?? 200 });
		},
	);
	const redactor = new SecretRedactor();
	const api = new VercelHostingApi({
		token: "arbitrary-account-secret",
		fetchImpl,
		redactor,
	});
	expect(await api.getProject("fw-reports-abc123")).toBeNull();
	expect(await api.createProject("fw-reports-abc123")).toEqual({
		id: "prj_a",
		name: "fw-reports-abc123",
	});
	expect(
		await api.createPrivateBlobStore({
			name: "fw-reports-abc123-blob",
			region: "iad1",
		}),
	).toBe("store_AbC");
	expect((await api.getStore("store_AbC")).id).toBe("abc");
	await api.connectStore({ storeId: "store_AbC", projectId: "prj_a" });
	expect(await api.findProjectBlobEnv("prj_a")).toEqual({
		envId: "env_a",
		type: "encrypted",
		storeId: "abc",
		storeApiId: "store_AbC",
	});
	expect(await api.decryptProjectEnv("prj_a", "env_a")).toBe(
		"vercel_blob_rw_abc_secret",
	);
	expect(calls.map(({ path, method }) => [path, method])).toEqual([
		["/v9/projects/fw-reports-abc123", "GET"],
		["/v11/projects", "POST"],
		["/v1/storage/stores/blob", "POST"],
		["/v1/storage/stores/store_AbC", "GET"],
		["/v1/storage/stores/store_AbC/connections", "POST"],
		["/v10/projects/prj_a/env", "GET"],
		["/v9/projects/prj_a/env/env_a?decrypt=true", "GET"],
	]);
	expect(calls[1]!.body).toEqual({
		name: "fw-reports-abc123",
		framework: null,
	});
	expect(calls[2]!.body).toEqual({
		name: "fw-reports-abc123-blob",
		region: "iad1",
		access: "private",
	});
	expect(calls[4]!.body).toEqual({
		projectId: "prj_a",
		envVarEnvironments: ["production", "preview", "development"],
		type: "integration",
	});
	expect(
		calls.every(
			(call) => call.authorization === "Bearer arbitrary-account-secret",
		),
	).toBe(true);
	expect(
		redactor.redact("arbitrary-account-secret vercel_blob_rw_abc_secret"),
	).not.toContain("secret");
});

it("fails closed on malformed or mismatched store details", async () => {
	const valid = {
		id: "store_abc",
		name: "reports",
		access: "private",
		size: 0,
		count: 0,
		status: "available",
		usageQuotaExceeded: false,
		projectsMetadata: [],
	};
	for (const key of Object.keys(valid)) {
		const malformed: Record<string, unknown> = { ...valid };
		delete malformed[key];
		const api = new VercelHostingApi({
			token: "account",
			redactor: new SecretRedactor(),
			fetchImpl: vi.fn(async () => Response.json({ store: malformed })),
		});
		await expect(api.getStore("abc")).rejects.toThrow("shape");
	}
	for (const patch of [
		{ size: -1 },
		{ count: 1.5 },
		{ size: "10" },
		{ projectsMetadata: [{}] },
		{ id: "other" },
	]) {
		const api = new VercelHostingApi({
			token: "account",
			redactor: new SecretRedactor(),
			fetchImpl: vi.fn(async () =>
				Response.json({ store: { ...valid, ...patch } }),
			),
		});
		await expect(api.getStore("abc")).rejects.toThrow();
	}
});

it("deletes a just-created public store and refuses it", async () => {
	const fetchImpl = vi
		.fn()
		.mockResolvedValueOnce(
			Response.json({ store: { id: "store_abc", access: "public" } }),
		)
		.mockResolvedValueOnce(new Response(null, { status: 204 }));
	const api = new VercelHostingApi({
		token: "account",
		redactor: new SecretRedactor(),
		fetchImpl,
	});
	await expect(api.createPrivateBlobStore({ name: "reports" })).rejects.toThrow(
		"not private",
	);
	expect(fetchImpl.mock.calls[1]![0]).toBe(
		"https://api.vercel.com/v1/storage/stores/blob/store_abc",
	);
	expect(fetchImpl.mock.calls[1]![1].method).toBe("DELETE");
});

it("redacts arbitrary account credentials, Blob credentials and API value fields", async () => {
	const account = "arbitrary%account+secret";
	const blob = "vercel_blob_rw_abc_secret";
	const redactor = new SecretRedactor();
	redactor.add(blob, "blob");
	const api = new VercelHostingApi({
		token: account,
		redactor,
		fetchImpl: vi.fn(async () =>
			Response.json(
				{
					error: account,
					token: blob,
					value: "unknown-env-secret",
					auth: "Bearer unknown-bearer",
				},
				{ status: 403 },
			),
		),
	});
	let caught: unknown;
	try {
		await api.createProject("reports");
	} catch (error) {
		caught = error;
	}
	const output = String(caught) + JSON.stringify(caught);
	for (const secret of [account, blob, "unknown-env-secret", "unknown-bearer"])
		expect(output).not.toContain(secret);
	expect(output).toContain("Full Account token");
});

it("never includes undecryptable response values or bodies in errors", async () => {
	for (const reply of [
		{ status: 200, body: { type: "sensitive", value: "undisclosed-value" } },
		{ status: 200, body: { decrypted: false, value: "undisclosed-value" } },
		{ status: 403, body: { value: "undisclosed-value" } },
	]) {
		const redactor = new SecretRedactor();
		const api = new VercelHostingApi({
			token: "account",
			redactor,
			fetchImpl: vi.fn(async () =>
				Response.json(reply.body, { status: reply.status }),
			),
		});
		await expect(api.decryptProjectEnv("project", "env")).rejects.toThrow(
			"cannot be decrypted",
		);
		try {
			await api.decryptProjectEnv("project", "env");
		} catch (error) {
			expect(String(error)).not.toContain("undisclosed-value");
		}
		if (reply.status === 200)
			expect(redactor.redact("undisclosed-value")).not.toContain(
				"undisclosed-value",
			);
	}
});

it("preserves creation uncertainty even when an id falls beyond the redacted body snippet", async () => {
	const api = new VercelHostingApi({
		token: "account",
		redactor: new SecretRedactor(),
		fetchImpl: vi.fn(async () =>
			Response.json(
				{ padding: "x".repeat(600), store: { id: "store_abc" } },
				{ status: 409 },
			),
		),
	});
	try {
		await api.createPrivateBlobStore({ name: "reports" });
		throw new Error("expected failure");
	} catch (error) {
		expect(error).toMatchObject({ status: 409, storeIdPresent: true });
	}
});
