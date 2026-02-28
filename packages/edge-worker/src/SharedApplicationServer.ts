import type { IncomingMessage, ServerResponse } from "node:http";
import { createLogger, type ILogger } from "flywheel-core";
import Fastify, { type FastifyInstance } from "fastify";

/**
 * OAuth callback state for tracking flows
 */
export interface OAuthCallback {
	resolve: (credentials: {
		linearToken: string;
		linearWorkspaceId: string;
		linearWorkspaceName: string;
	}) => void;
	reject: (error: Error) => void;
	id: string;
}

/**
 * Approval callback state for tracking approval workflows
 */
export interface ApprovalCallback {
	resolve: (approved: boolean, feedback?: string) => void;
	reject: (error: Error) => void;
	sessionId: string;
	createdAt: number;
}

/**
 * Shared application server that handles both webhooks and OAuth callbacks on a single port
 * Consolidates functionality from SharedWebhookServer and CLI OAuth server
 */
export class SharedApplicationServer {
	private app: FastifyInstance | null = null;
	private webhookHandlers = new Map<
		string,
		{
			secret: string;
			handler: (body: string, signature: string, timestamp?: string) => boolean;
		}
	>();
	// Legacy handlers for direct Linear webhook registration (deprecated)
	private linearWebhookHandlers = new Map<
		string,
		(req: IncomingMessage, res: ServerResponse) => Promise<void>
	>();
	private oauthCallbacks = new Map<string, OAuthCallback>();
	private pendingApprovals = new Map<string, ApprovalCallback>();
	private port: number;
	private host: string;
	private isListening = false;
	// TODO: CloudflareTunnelClient removed in Phase 1 (package deleted)
	private tunnelClient: any | null = null;
	private skipTunnel: boolean;
	private logger: ILogger;

	constructor(
		port: number = 3456,
		host: string = "localhost",
		skipTunnel: boolean = false,
		logger?: ILogger,
	) {
		this.port = port;
		this.host = host;
		this.skipTunnel = skipTunnel;
		this.logger =
			logger ?? createLogger({ component: "SharedApplicationServer" });
	}

	/**
	 * Initialize the Fastify app instance (must be called before registering routes)
	 */
	initializeFastify(): void {
		if (this.app) {
			return; // Already initialized
		}

		this.app = Fastify({
			logger: false,
		});
	}

	/**
	 * Start the shared application server
	 */
	async start(): Promise<void> {
		if (this.isListening) {
			return; // Already listening
		}

		// Initialize Fastify if not already done
		this.initializeFastify();

		try {
			await this.app!.listen({
				port: this.port,
				host: this.host,
			});

			this.isListening = true;
			this.logger.info(
				`Shared application server listening on http://${this.host}:${this.port}`,
			);

			// Start Cloudflare tunnel if CLOUDFLARE_TOKEN is set and tunnel is not skipped
			if (!this.skipTunnel && process.env.CLOUDFLARE_TOKEN) {
				await this.startCloudflareTunnel(process.env.CLOUDFLARE_TOKEN);
			}
		} catch (error) {
			this.isListening = false;
			throw error;
		}
	}

	/**
	 * Start Cloudflare tunnel and wait for 4 'connected' events
	 * TODO: CloudflareTunnelClient removed in Phase 1 (package deleted)
	 */
	private async startCloudflareTunnel(_cloudflareToken: string): Promise<void> {
		throw new Error(
			"CloudflareTunnelClient has been removed. Cloudflare tunnel is not supported in Phase 1.",
		);
	}

	/**
	 * Stop the shared application server
	 */
	async stop(): Promise<void> {
		// Reject all pending approvals before shutdown
		for (const [sessionId, approval] of this.pendingApprovals) {
			approval.reject(new Error("Server shutting down"));
			this.logger.debug(
				`Rejected pending approval for session ${sessionId} due to shutdown`,
			);
		}
		this.pendingApprovals.clear();

		// Stop Cloudflare tunnel if running
		if (this.tunnelClient) {
			this.tunnelClient.disconnect();
			this.tunnelClient = null;
			this.logger.info("Cloudflare tunnel stopped");
		}

		if (this.app && this.isListening) {
			await this.app.close();
			this.isListening = false;
			this.logger.info("Shared application server stopped");
		}
	}

	/**
	 * Get the port number the server is listening on
	 */
	getPort(): number {
		return this.port;
	}

	/**
	 * Get the Fastify instance for registering routes
	 * Initializes Fastify if not already done
	 */
	getFastifyInstance(): FastifyInstance {
		this.initializeFastify();
		return this.app!;
	}

	/**
	 * Register a webhook handler for a specific token (LEGACY - deprecated)
	 * Supports two signatures:
	 * 1. For ndjson-client: (token, secret, handler)
	 * 2. For legacy direct registration: (token, handler) where handler takes (req, res)
	 *
	 * NOTE: New code should use LinearEventTransport which registers routes directly with Fastify
	 */
	registerWebhookHandler(
		token: string,
		secretOrHandler:
			| string
			| ((req: IncomingMessage, res: ServerResponse) => Promise<void>),
		handler?: (body: string, signature: string, timestamp?: string) => boolean,
	): void {
		if (typeof secretOrHandler === "string" && handler) {
			// ndjson-client style registration
			this.webhookHandlers.set(token, { secret: secretOrHandler, handler });
			this.logger.debug(
				`Registered webhook handler (proxy-style) for token ending in ...${token.slice(-4)}`,
			);
		} else if (typeof secretOrHandler === "function") {
			// Legacy direct registration
			this.linearWebhookHandlers.set(token, secretOrHandler);
			this.logger.debug(
				`Registered webhook handler (legacy direct-style) for token ending in ...${token.slice(-4)}`,
			);
		} else {
			throw new Error("Invalid webhook handler registration parameters");
		}
	}

	/**
	 * Unregister a webhook handler
	 */
	unregisterWebhookHandler(token: string): void {
		const hadProxyHandler = this.webhookHandlers.delete(token);
		const hadDirectHandler = this.linearWebhookHandlers.delete(token);
		if (hadProxyHandler || hadDirectHandler) {
			this.logger.debug(
				`Unregistered webhook handler for token ending in ...${token.slice(-4)}`,
			);
		}
	}

	/**
	 * Start OAuth flow and return promise that resolves when callback is received
	 */
	async startOAuthFlow(proxyUrl: string): Promise<{
		linearToken: string;
		linearWorkspaceId: string;
		linearWorkspaceName: string;
	}> {
		return new Promise<{
			linearToken: string;
			linearWorkspaceId: string;
			linearWorkspaceName: string;
		}>((resolve, reject) => {
			// Generate unique ID for this flow
			const flowId = Date.now().toString();

			// Store callback for this flow
			this.oauthCallbacks.set(flowId, { resolve, reject, id: flowId });

			// Check if we should use direct Linear OAuth (when self-hosting)
			const isExternalHost =
				process.env.CYRUS_HOST_EXTERNAL?.toLowerCase().trim() === "true";
			const useDirectOAuth = isExternalHost && process.env.LINEAR_CLIENT_ID;

			const callbackBaseUrl = `http://${this.host}:${this.port}`;
			let authUrl: string;

			if (useDirectOAuth) {
				// Use local OAuth authorize endpoint
				authUrl = `${callbackBaseUrl}/oauth/authorize?callback=${encodeURIComponent(`${callbackBaseUrl}/callback`)}`;
				this.logger.info(`Using direct OAuth mode (CYRUS_HOST_EXTERNAL=true)`);
			} else {
				// Use proxy OAuth endpoint
				authUrl = `${proxyUrl}/oauth/authorize?callback=${encodeURIComponent(`${callbackBaseUrl}/callback`)}`;
			}

			this.logger.info(`Opening your browser to authorize with Linear...`);
			this.logger.info(`If the browser doesn't open, visit: ${authUrl}`);

			// Timeout after 5 minutes
			setTimeout(
				() => {
					if (this.oauthCallbacks.has(flowId)) {
						this.oauthCallbacks.delete(flowId);
						reject(new Error("OAuth timeout"));
					}
				},
				5 * 60 * 1000,
			);
		});
	}

	/**
	 * Get the webhook URL
	 */
	getWebhookUrl(): string {
		return `http://${this.host}:${this.port}/webhook`;
	}

	/**
	 * Get the OAuth callback URL for registration with proxy
	 */
	getOAuthCallbackUrl(): string {
		return `http://${this.host}:${this.port}/callback`;
	}

	/**
	 * Register an approval request and get approval URL
	 */
	registerApprovalRequest(sessionId: string): {
		promise: Promise<{ approved: boolean; feedback?: string }>;
		url: string;
	} {
		// Clean up expired approvals (older than 30 minutes)
		const now = Date.now();
		for (const [key, approval] of this.pendingApprovals) {
			if (now - approval.createdAt > 30 * 60 * 1000) {
				approval.reject(new Error("Approval request expired"));
				this.pendingApprovals.delete(key);
			}
		}

		// Create promise for this approval request
		const promise = new Promise<{ approved: boolean; feedback?: string }>(
			(resolve, reject) => {
				this.pendingApprovals.set(sessionId, {
					resolve: (approved, feedback) => resolve({ approved, feedback }),
					reject,
					sessionId,
					createdAt: now,
				});
			},
		);

		// Generate approval URL
		const url = `http://${this.host}:${this.port}/approval?session=${encodeURIComponent(sessionId)}`;

		this.logger.debug(
			`Registered approval request for session ${sessionId}: ${url}`,
		);

		return { promise, url };
	}
}
