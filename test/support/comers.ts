import { createHash, generateKeyPairSync, randomUUID, sign, type KeyObject } from 'node:crypto';

/**
 * A contract stub of the public Comers API, the delivery signer, and the
 * slices of n8n's hook and webhook contexts the node uses. Written from the
 * published contract, never from the node's own code, so the tests fail if the
 * node drifts from it.
 */

export const ORIGIN = 'https://comers.example.test';
export const WEBHOOK_URL = 'https://n8n.example.test/webhook/8f7c1c1e-5d0b-4f0e-9d3a-2d1f1d0c9a11/webhook';
export const CLIENT_ID = 'abcdefghijklmnopqrstuvwxyz234567';
/** A fixture generated for these tests; it has never belonged to a Comers integration. */
export const CLIENT_MATERIAL = 'n8n-test-client-material-0123456789abcdef';
export const ORGANIZATION_ID = '0199c3f0-1a2b-7c3d-8e4f-00000000000a';
export const SCOPE = 'comers.core.events.subscriptions.manage-own';
export const JWKS_PATH = '/core/api/v1/event-delivery-keys';

/** Parameters as n8n stores them after selecting catalog options. */
export const selectedEvents = (...values: string[]) => ({ events: { event: values.map((event) => ({ event })) } });
export const productionState = (state: Record<string, unknown>): Record<string, unknown> =>
	(state.production ?? {}) as Record<string, unknown>;

export interface SigningKey {
	kid: string;
	privateKey: KeyObject;
	jwk: Record<string, unknown>;
}

export const newSigningKey = (version: number): SigningKey => {
	const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
	const { x, y } = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
	const thumbprint = createHash('sha256')
		.update(`{"crv":"P-256","kty":"EC","x":"${x}","y":"${y}"}`)
		.digest('base64url');
	const kid = `v${version}.${thumbprint}`;

	return {
		kid,
		privateKey,
		jwk: { kty: 'EC', crv: 'P-256', x, y, kid, alg: 'ES256', use: 'sig', key_ops: ['verify'] },
	};
};

const b64 = (value: unknown): string =>
	Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');

export const envelope = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
	specVersion: 'comers.v1',
	eventId: '0199c3f0-1a2b-7c3d-8e4f-000000000001',
	eventKey: 'comers.core.support.case.opened',
	eventVersion: 1,
	sequence: '9007199254740993',
	occurredAt: '2026-09-22T07:05:30.000Z',
	producer: 'comers-core-support',
	scope: { organizationId: ORGANIZATION_ID, sellerId: null, sellerStoreId: null },
	subject: { type: 'support_case', id: '0199c3f0-1a2b-7c3d-8e4f-00000000000b' },
	correlationId: null,
	data: { priority: 'high' },
	...overrides,
});

/** A delivery as Core Events signs it: flattened JWS over the event and its binding. */
export const signedDelivery = ({
	key,
	subscriptionId,
	event = envelope(),
	timestamp = Math.floor(Date.now() / 1000),
	header,
	signWith,
}: {
	key: SigningKey;
	subscriptionId: string;
	event?: Record<string, unknown>;
	timestamp?: number;
	header?: Record<string, unknown>;
	signWith?: KeyObject;
}): string => {
	const protectedHeader = b64(header ?? { typ: 'comers-delivery+jws', alg: 'ES256', kid: key.kid });
	const payload = b64({
		event,
		delivery: {
			subscriptionId,
			deliveryId: '0199c3f0-1a2b-7c3d-8e4f-000000000003',
			deliveryAttempt: 1,
			timestamp,
		},
	});
	const signature = sign('sha256', Buffer.from(`${protectedHeader}.${payload}`), {
		key: signWith ?? key.privateKey,
		dsaEncoding: 'ieee-p1363',
	}).toString('base64url');

	return JSON.stringify({ protected: protectedHeader, payload, signature });
};

interface StubSubscription {
	subscriptionId: string;
	name: string;
	targetUrl: string;
	signatureProfile: string;
	state: string;
	stateReason: null;
	format: 'comers.v1';
	events: Array<{ eventKey: string; eventVersion: number }>;
	createdAt: string;
	updatedAt: string;
}

export interface RecordedRequest {
	method: string;
	path: string;
	authorization?: string;
	basicAuth?: { username: string; password: string };
	body?: unknown;
}

interface HttpOptions {
	method?: string;
	url: string;
	headers?: Record<string, unknown>;
	body?: unknown;
	auth?: { username: string; password: string };
}

/** The public Comers API, as the M5/M6/M7A contracts define it. */
export class ComersStub {
	scopes = [SCOPE];
	keys: SigningKey[] = [newSigningKey(1)];
	jwksCacheControl = 'public, max-age=300';
	readonly subscriptions = new Map<string, StubSubscription>();
	readonly requests: RecordedRequest[] = [];
	private readonly issued = new Set<string>();
	/** The next request to this path answers with this status instead. */
	failOnce: Record<string, number> = {};
	/** Creates the subscription, then loses the answer (a timeout on the way back). */
	loseNextCreateResponse = false;
	/** Every page of the subscription list points to one more. */
	endlessList = false;

	/** Invalidates every token issued so far, as a key rotation or revocation would. */
	revokeTokens(): void {
		this.issued.clear();
	}

	jwksRequests(): number {
		return this.requests.filter((request) => request.path === JWKS_PATH).length;
	}

	handle(options: HttpOptions): { statusCode: number; body: unknown; headers: Record<string, string> } {
		const url = new URL(options.url);
		const method = (options.method ?? 'GET').toUpperCase();
		const authorization = options.headers?.authorization as string | undefined;
		this.requests.push({
			method,
			path: url.pathname,
			authorization,
			basicAuth: options.auth,
			body: options.body,
		});

		const answer = (statusCode: number, body?: unknown, headers: Record<string, string> = {}) => ({
			statusCode,
			body,
			headers,
		});
		const failure = this.failOnce[`${method} ${url.pathname}`];

		if (failure !== undefined) {
			delete this.failOnce[`${method} ${url.pathname}`];
			return answer(failure, { statusCode: failure, code: 'STUB_FAILURE' });
		}

		if (url.origin !== ORIGIN) return answer(404);

		if (url.pathname === '/core/oauth2/token' && method === 'POST') {
			if (options.auth?.username !== CLIENT_ID || options.auth?.password !== CLIENT_MATERIAL) {
				return answer(401, { error: 'invalid_client' });
			}
			const requested = new URLSearchParams(String(options.body)).get('scope') ?? '';
			if (!requested.split(' ').every((scope) => this.scopes.includes(scope))) {
				return answer(400, { error: 'invalid_scope' });
			}
			const token = `stub-access-token-${randomUUID()}`;
			this.issued.add(token);
			return answer(200, { access_token: token, token_type: 'Bearer', expires_in: 300, scope: requested });
		}

		if (url.pathname === JWKS_PATH && method === 'GET') {
			return answer(
				200,
				JSON.stringify({ keys: this.keys.map((key) => key.jwk) }),
				{ 'cache-control': this.jwksCacheControl, etag: '"stub"' },
			);
		}

		const bearer = authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined;
		if (bearer === undefined || !this.issued.has(bearer)) return answer(401, { code: 'invalid_token' });

		if (url.pathname === '/core/api/v1/integrations/me' && method === 'GET') {
			return answer(200, {
				principalId: '0199c3f0-1a2b-7c3d-8e4f-0000000000aa',
				principalType: 'integration',
				organizationId: ORGANIZATION_ID,
				clientId: CLIENT_ID,
				scopes: this.scopes,
			});
		}

		const base = '/core/api/v1/event-subscriptions';
		if (url.pathname === base && method === 'POST') {
			const body = options.body as Record<string, unknown>;
			if (body.signatureProfile !== 'jws-es256-v1') return answer(400, { details: { reason: 'invalid_request' } });
			const subscription: StubSubscription = {
				subscriptionId: randomUUID(),
				name: String(body.name),
				targetUrl: String(body.targetUrl),
				signatureProfile: 'jws-es256-v1',
				state: 'active',
				stateReason: null,
				format: 'comers.v1',
				events: body.events as StubSubscription['events'],
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			};
			this.subscriptions.set(subscription.subscriptionId, subscription);
			if (this.loseNextCreateResponse) {
				this.loseNextCreateResponse = false;
				throw new Error('socket hang up');
			}
			return answer(201, {
				signatureProfile: 'jws-es256-v1',
				subscription,
				verification: { jwksUri: `${ORIGIN}${JWKS_PATH}`, algorithm: 'ES256', type: 'comers-delivery+jws' },
			});
		}

		if (url.pathname === base && method === 'GET') {
			const includeArchived = url.searchParams.get('includeArchived') === 'true';
			return answer(200, {
				items: [...this.subscriptions.values()].filter(
					(subscription) => includeArchived || subscription.state !== 'archived',
				),
				nextCursor: this.endlessList ? randomUUID() : null,
			});
		}

		const id = url.pathname.startsWith(`${base}/`) ? url.pathname.slice(base.length + 1) : undefined;
		const subscription = id === undefined ? undefined : this.subscriptions.get(id);
		if (subscription === undefined) return answer(404, { code: 'NOT_FOUND' });

		if (method === 'GET') return answer(200, subscription);
		if (method === 'PATCH') {
			Object.assign(subscription, options.body as object);
			return answer(200, subscription);
		}
		if (method === 'DELETE') {
			subscription.state = 'archived';
			return answer(204);
		}

		return answer(405);
	}
}

/** What n8n passes to httpRequestWithAuthentication for `comersApi`: basic auth from the credential. */
const withCredentialAuth = (options: HttpOptions, credentials: Record<string, string>): HttpOptions => ({
	...options,
	auth: { username: credentials.clientId, password: credentials.clientSecret },
});

export const credentials = (overrides: Record<string, string> = {}): Record<string, string> => ({
	baseUrl: ORIGIN,
	clientId: CLIENT_ID,
	clientSecret: CLIENT_MATERIAL,
	...overrides,
});

const helpers = (stub: ComersStub, creds: Record<string, string>) => ({
	httpRequest: async (options: HttpOptions) => stub.handle(options),
	httpRequestWithAuthentication: async (_type: string, options: HttpOptions) =>
		stub.handle(withCredentialAuth(options, creds)),
});

export interface HookOptions {
	stub: ComersStub;
	staticData?: Record<string, unknown>;
	creds?: Record<string, string>;
	mode?: string;
	parameters?: Record<string, unknown>;
	workflowId?: string;
	nodeId?: string;
}

export const hookContext = ({
	stub,
	staticData = {},
	creds = credentials(),
	mode = 'trigger',
	parameters = selectedEvents('comers.core.support.case.opened@1'),
	workflowId = 'wf-7Qx2',
	nodeId = '6f1c2d3e-0000-4000-8000-000000000001',
}: HookOptions) => ({
	staticData,
	context: {
		getWorkflowStaticData: () => staticData,
		getCredentials: async () => creds,
		getNode: () => ({ id: nodeId, name: 'Comers Trigger', type: 'comersTrigger', typeVersion: 1, parameters: {} }),
		getWorkflow: () => ({ id: workflowId, name: 'Orders', active: true }),
		getNodeParameter: (name: string, fallback?: unknown) => parameters[name] ?? fallback,
		getNodeWebhookUrl: () => mode === 'manual' ? WEBHOOK_URL.replace('/webhook/', '/webhook-test/') : WEBHOOK_URL,
		getMode: () => mode,
		helpers: helpers(stub, creds),
	},
});

export const webhookContext = ({
	stub,
	staticData,
	body,
	creds = credentials(),
}: {
	stub: ComersStub;
	staticData: Record<string, unknown>;
	body: string;
	creds?: Record<string, string>;
}) => {
	const reply: { status?: number; body?: string } = {};
	const logs: Array<{ level: string; message: string; meta: unknown }> = [];

	return {
		reply,
		logs,
		context: {
			getWorkflowStaticData: () => staticData,
			getCredentials: async () => creds,
			getNode: () => ({ id: 'n', name: 'Comers Trigger', type: 'comersTrigger', typeVersion: 1, parameters: {} }),
			getRequestObject: () => ({ rawBody: Buffer.from(body, 'utf8'), readRawBody: async () => undefined }),
			getResponseObject: () => ({
				writeHead: (status: number) => {
					reply.status = status;
				},
				end: (text: string) => {
					reply.body = text;
				},
			}),
			logger: {
				warn: (message: string, meta: unknown) => logs.push({ level: 'warn', message, meta }),
				error: (message: string, meta: unknown) => logs.push({ level: 'error', message, meta }),
			},
			helpers: helpers(stub, creds),
		},
	};
};
