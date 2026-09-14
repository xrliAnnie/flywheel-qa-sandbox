/** Narrow Vercel account API used by report hosting rotation and usage checks. */
export class SecretRedactor {
	private readonly secrets = new Map<string, string>();
	add(value: string | undefined, name = "credential"): void {
		if (value) this.secrets.set(value, name);
	}
	redact(text: string): string {
		let result = text;
		for (const [value, name] of [...this.secrets].sort(
			(a, b) => b[0].length - a[0].length,
		)) {
			result = result.split(value).join(`<redacted:${name}>`);
		}
		return result
			.replace(/vercel_blob_rw_[A-Za-z0-9_]+/g, "<redacted:blob>")
			.replace(/Bearer\s+\S+/gi, "Bearer <redacted>")
			.replace(/"value"\s*:\s*"[^"]*"/g, '"value":"<redacted>"');
	}
}
export class VercelApiError extends Error {
	constructor(
		readonly status: number,
		readonly endpoint: string,
		readonly bodySnippet: string,
		readonly storeIdPresent = /"(?:storeId|id)"\s*:\s*"[^"]+"/.test(
			bodySnippet,
		),
	) {
		super(
			`Vercel API ${endpoint} failed (${status}): ${bodySnippet}${status === 403 ? " — token must be a Full Account token for this Hobby team" : ""}`,
		);
		this.name = "VercelApiError";
	}
}
export class EnvNotDecryptable extends Error {
	constructor(
		readonly status: number,
		readonly envId: string,
	) {
		super(
			`project credential cannot be decrypted (status=${status}, envId=${envId})`,
		);
		this.name = "EnvNotDecryptable";
	}
}
export class StoreNotPrivate extends Error {
	constructor() {
		super("created Blob store is not private");
		this.name = "StoreNotPrivate";
	}
}
export function normalizeStoreId(id: string): string {
	const normalized = id.replace(/^store_/i, "").toLowerCase();
	if (!/^[a-z0-9]+$/.test(normalized))
		throw new Error("invalid Blob store identity");
	return normalized;
}
export function apiStoreId(id: string): string {
	const suffix = id.replace(/^store_/i, "");
	if (!/^[A-Za-z0-9]+$/.test(suffix))
		throw new Error("invalid Blob store identity");
	return `store_${suffix}`;
}
type JsonObject = Record<string, unknown>;
function object(value: unknown): JsonObject {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("invalid Vercel API response shape");
	return value as JsonObject;
}
function nonempty(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}
export interface VercelStoreDetails {
	id: string;
	apiId?: string;
	name: string;
	access: string;
	size: number;
	count: number;
	status: string;
	usageQuotaExceeded: boolean;
	projectsMetadata: Array<{ projectId: string }>;
}
export interface ProjectBlobEnv {
	storeApiId?: string;
	envId: string;
	type: string;
	storeId?: string;
}
export interface VercelHostingApiOptions {
	token: string;
	fetchImpl?: typeof fetch;
	redactor: SecretRedactor;
}
export class VercelHostingApi {
	private readonly fetchImpl: typeof fetch;
	constructor(private readonly options: VercelHostingApiOptions) {
		if (!options.token.trim())
			throw new Error("Vercel account credential missing");
		options.redactor.add(options.token, "account");
		this.fetchImpl = options.fetchImpl ?? fetch;
	}
	private async request(
		endpoint: string,
		method = "GET",
		body?: unknown,
	): Promise<Response> {
		try {
			return await this.fetchImpl(`https://api.vercel.com${endpoint}`, {
				method,
				headers: {
					Authorization: `Bearer ${this.options.token}`,
					...(body === undefined ? {} : { "Content-Type": "application/json" }),
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
				signal: AbortSignal.timeout(30_000),
			});
		} catch (error) {
			throw new Error(
				this.options.redactor.redact(
					`Vercel API ${endpoint} request failed: ${error instanceof Error ? error.message : "transport failure"}`,
				),
			);
		}
	}
	private async json(
		endpoint: string,
		method = "GET",
		body?: unknown,
	): Promise<unknown> {
		const response = await this.request(endpoint, method, body);
		if (!response.ok) {
			const text = await response.text().catch(() => "unreadable response");
			throw new VercelApiError(
				response.status,
				endpoint,
				this.options.redactor.redact(text).slice(0, 500),
				/"(?:storeId|id)"\s*:\s*"[^"]+"/.test(text),
			);
		}
		try {
			return await response.json();
		} catch {
			throw new Error(`invalid Vercel API response shape: ${endpoint}`);
		}
	}
	private project(value: unknown): { id: string; name: string } {
		const data = object(value);
		if (!nonempty(data.id) || !nonempty(data.name))
			throw new Error("invalid project response shape");
		return { id: data.id, name: data.name };
	}
	async getProject(name: string): Promise<{ id: string; name: string } | null> {
		try {
			return this.project(
				await this.json(`/v9/projects/${encodeURIComponent(name)}`),
			);
		} catch (error) {
			if (error instanceof VercelApiError && error.status === 404) return null;
			throw error;
		}
	}
	async createProject(name: string): Promise<{ id: string; name: string }> {
		return this.project(
			await this.json("/v11/projects", "POST", { name, framework: null }),
		);
	}
	async createPrivateBlobStore(input: {
		name: string;
		region?: string;
	}): Promise<string> {
		const response = object(
			await this.json("/v1/storage/stores/blob", "POST", {
				...input,
				access: "private",
			}),
		);
		const store = object(response.store);
		if (!nonempty(store.id))
			throw new Error("invalid store creation response shape");
		const id = apiStoreId(store.id);
		if (store.access !== "private") {
			await this.deleteBlobStore(id);
			throw new StoreNotPrivate();
		}
		return id;
	}
	async deleteBlobStore(id: string): Promise<void> {
		const endpoint = `/v1/storage/stores/blob/${apiStoreId(id)}`;
		const response = await this.request(endpoint, "DELETE");
		if (!response.ok)
			throw new VercelApiError(
				response.status,
				endpoint,
				this.options.redactor.redact(await response.text()).slice(0, 500),
			);
	}
	async connectStore(input: {
		storeId: string;
		projectId: string;
	}): Promise<void> {
		await this.json(
			`/v1/storage/stores/${apiStoreId(input.storeId)}/connections`,
			"POST",
			{
				projectId: input.projectId,
				envVarEnvironments: ["production", "preview", "development"],
				type: "integration",
			},
		);
	}
	async findProjectBlobEnv(
		projectId: string,
	): Promise<ProjectBlobEnv | undefined> {
		const data = object(
			await this.json(`/v10/projects/${encodeURIComponent(projectId)}/env`),
		);
		if (!Array.isArray(data.envs))
			throw new Error("invalid project environment response shape");
		const matches = data.envs
			.map(object)
			.filter(
				(env) =>
					env.key === "BLOB_READ_WRITE_TOKEN" &&
					(Array.isArray(env.target)
						? env.target.includes("production")
						: env.target === "production"),
			);
		if (matches.length === 0) return undefined;
		if (matches.length !== 1)
			throw new Error("ambiguous production Blob environment");
		const env = matches[0]!;
		if (!nonempty(env.id) || !nonempty(env.type))
			throw new Error("invalid project Blob environment shape");
		const hint =
			env.contentHint == null ? undefined : object(env.contentHint).storeId;
		if (hint !== undefined && !nonempty(hint))
			throw new Error("invalid project Blob store hint");
		return {
			envId: env.id,
			type: env.type,
			...(typeof hint === "string"
				? { storeId: normalizeStoreId(hint), storeApiId: apiStoreId(hint) }
				: {}),
		};
	}
	async decryptProjectEnv(projectId: string, envId: string): Promise<string> {
		const endpoint = `/v9/projects/${encodeURIComponent(projectId)}/env/${encodeURIComponent(envId)}?decrypt=true`;
		let response: Response;
		try {
			response = await this.request(endpoint);
		} catch {
			throw new EnvNotDecryptable(0, envId);
		}
		if (!response.ok) throw new EnvNotDecryptable(response.status, envId);
		let data: JsonObject;
		try {
			data = object(await response.json());
		} catch {
			throw new EnvNotDecryptable(response.status, envId);
		}
		if (typeof data.value === "string")
			this.options.redactor.add(data.value, "blob");
		if (
			data.decrypted === false ||
			data.type === "sensitive" ||
			!nonempty(data.value)
		)
			throw new EnvNotDecryptable(response.status, envId);
		return data.value;
	}
	async getStore(id: string): Promise<VercelStoreDetails> {
		const data = object(
			await this.json(`/v1/storage/stores/${apiStoreId(id)}`),
		);
		const store = object(data.store);
		const fields = ["id", "name", "access", "status"] as const;
		if (
			fields.some((key) => !nonempty(store[key])) ||
			!Number.isSafeInteger(store.size) ||
			(store.size as number) < 0 ||
			!Number.isSafeInteger(store.count) ||
			(store.count as number) < 0 ||
			typeof store.usageQuotaExceeded !== "boolean" ||
			!Array.isArray(store.projectsMetadata)
		) {
			throw new Error("invalid store details response shape");
		}
		const projectsMetadata = store.projectsMetadata.map((value) => {
			const project = object(value);
			if (!nonempty(project.projectId))
				throw new Error("invalid store project metadata shape");
			return { projectId: project.projectId };
		});
		const result = {
			id: normalizeStoreId(store.id as string),
			apiId: apiStoreId(store.id as string),
			name: store.name as string,
			access: store.access as string,
			size: store.size as number,
			count: store.count as number,
			status: store.status as string,
			usageQuotaExceeded: store.usageQuotaExceeded,
			projectsMetadata,
		};
		if (result.id !== normalizeStoreId(id))
			throw new Error("store response identity mismatch");
		return result;
	}
}
