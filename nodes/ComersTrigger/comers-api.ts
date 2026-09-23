import { createHash } from 'node:crypto';

import type { IDataObject, IHookFunctions, ILoadOptionsFunctions, IWebhookFunctions } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

/**
 * The public Comers API, as this node uses it.
 *
 * Every request goes through n8n's own HTTP helpers. The client secret is only
 * applied by n8n itself, to the token request, from the `Comers API`
 * credential. The access token that comes back is kept in this process's
 * memory until shortly before it expires and is never written anywhere — not
 * to static data, not to the workflow, not to an execution. A restart simply
 * fetches a new one.
 */

type Context = IHookFunctions | ILoadOptionsFunctions | IWebhookFunctions;

/** The one scope the trigger needs. */
export const SUBSCRIPTION_SCOPE = 'comers.core.events.subscriptions.manage-own';

/** Where Comers publishes the keys that verify jws-es256-v1 deliveries. */
export const PUBLISHED_JWKS_PATH = '/core/api/v1/event-delivery-keys';

export const SUBSCRIPTIONS_PATH = '/core/api/v1/event-subscriptions';
export const CATALOG_PATH = `${SUBSCRIPTIONS_PATH}/catalog`;

/** What a request to Comers needs, without the secret. */
export interface ComersConnection {
	/** `https://host[:port]`, from the credential. */
	origin: string;
	/** Identifies the cached token for this exact credential; a digest, never the secret. */
	tokenKey: string;
}

/** A node error carrying only a message written here — never a token, secret or response body. */
export const comersError = (context: Context, message: string): NodeOperationError =>
	new NodeOperationError(context.getNode(), message);

const isLocalHost = (hostname: string): boolean =>
	hostname === 'localhost' ||
	hostname === '127.0.0.1' ||
	hostname === '[::1]' ||
	// A single-label name only resolves inside a private network (a container
	// name, a hosts entry), never on the public internet.
	!hostname.includes('.');

/**
 * The credential's Comers URL, reduced to its origin, or why it cannot be used.
 * HTTPS is required, except for a local or single-label host in development.
 */
export const comersOrigin = (baseUrl: unknown): { origin: string } | { problem: string } => {
	let url: URL;

	try {
		url = new URL(String(baseUrl ?? '').trim());
	} catch {
		return { problem: 'The Comers URL in the credential is not a valid URL.' };
	}

	if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
		return { problem: 'The Comers URL must not contain credentials, a query or a fragment.' };
	}

	if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocalHost(url.hostname))) {
		return { problem: 'The Comers URL must use HTTPS.' };
	}

	return { origin: url.origin };
};

/** The only JWKS URI a delivery may be verified against, for this Comers. */
export const deliveryKeysUri = (origin: string): string => `${origin}${PUBLISHED_JWKS_PATH}`;

/** The credential, reduced to what requests need. The only place credentials are read. */
export async function comersConnection(this: Context): Promise<ComersConnection> {
	const credentials = await this.getCredentials<{
		baseUrl: string;
		clientId: string;
		clientSecret: string;
	}>('comersApi');
	const parsed = comersOrigin(credentials.baseUrl);

	if ('problem' in parsed) {
		throw comersError(this, parsed.problem);
	}

	const { origin } = parsed;

	return {
		origin,
		tokenKey: createHash('sha256')
			.update(`${origin}\u0000${credentials.clientId}\u0000${credentials.clientSecret}`)
			.digest('base64url'),
	};
}

const tokens = new Map<string, { value: string; expiresAt: number }>();
const pendingTokens = new Map<string, Promise<string>>();

/** Forgets every cached token. For tests. */
export const clearTokenCache = (): void => {
	tokens.clear();
	pendingTokens.clear();
};

const parseBody = (body: unknown): unknown => {
	if (typeof body !== 'string') return body;

	try {
		return JSON.parse(body) as unknown;
	} catch {
		return undefined;
	}
};

async function requestToken(this: Context, connection: ComersConnection): Promise<string> {
	const response = (await this.helpers.httpRequestWithAuthentication.call(this, 'comersApi', {
		method: 'POST',
		url: `${connection.origin}/core/oauth2/token`,
		headers: {
			'content-type': 'application/x-www-form-urlencoded',
			accept: 'application/json',
		},
		body: `grant_type=client_credentials&scope=${SUBSCRIPTION_SCOPE}`,
		returnFullResponse: true,
		ignoreHttpStatusErrors: true,
		disableFollowRedirect: true,
		json: false,
	})) as { statusCode: number; body: unknown };

	if (response.statusCode === 401) {
		throw comersError(this, 'Comers did not accept the client ID and secret in the credential.');
	}

	const body = parseBody(response.body) as {
		access_token?: unknown;
		expires_in?: unknown;
		error?: unknown;
	};

	if (response.statusCode === 400 && body?.error === 'invalid_scope') {
		throw comersError(this, `The Comers integration is missing the scope ${SUBSCRIPTION_SCOPE}.`);
	}

	if (
		response.statusCode !== 200 ||
		typeof body?.access_token !== 'string' ||
		typeof body.expires_in !== 'number' ||
		!Number.isFinite(body.expires_in) ||
		body.expires_in <= 0
	) {
		throw comersError(this, `Comers did not issue an access token (HTTP ${response.statusCode}).`);
	}

	// Refreshed before it runs out: 30 s early, or a fifth of a short lifetime.
	const marginSeconds = Math.min(30, body.expires_in / 5);

	tokens.set(connection.tokenKey, {
		value: body.access_token,
		expiresAt: Date.now() + (body.expires_in - marginSeconds) * 1000,
	});

	return body.access_token;
}

async function accessToken(this: Context, connection: ComersConnection): Promise<string> {
	const cached = tokens.get(connection.tokenKey);

	if (cached !== undefined && cached.expiresAt > Date.now()) {
		return cached.value;
	}

	let pending = pendingTokens.get(connection.tokenKey);

	if (pending === undefined) {
		pending = requestToken.call(this, connection).finally(() => {
			pendingTokens.delete(connection.tokenKey);
		});
		pendingTokens.set(connection.tokenKey, pending);
	}

	return pending;
}

export interface ComersResponse {
	statusCode: number;
	body: unknown;
}

/**
 * One authenticated request to the public Comers API. A 401 means the cached
 * token is no longer accepted: it is dropped and the request is repeated once
 * with a fresh token, never more.
 */
export async function comersRequest(
	this: Context,
	connection: ComersConnection,
	method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
	path: string,
	body?: IDataObject,
): Promise<ComersResponse> {
	for (let attempt = 0; attempt < 2; attempt += 1) {
		const token = await accessToken.call(this, connection);
		const response = (await this.helpers.httpRequest({
			method,
			url: `${connection.origin}${path}`,
			headers: {
				accept: 'application/json',
				authorization: `Bearer ${token}`,
				...(body === undefined ? {} : { 'content-type': 'application/json' }),
			},
			...(body === undefined ? {} : { body }),
			returnFullResponse: true,
			ignoreHttpStatusErrors: true,
			disableFollowRedirect: true,
			json: true,
		})) as { statusCode: number; body: unknown };

		if (response.statusCode === 401 && attempt === 0) {
			tokens.delete(connection.tokenKey);
			continue;
		}

		return { statusCode: response.statusCode, body: parseBody(response.body) };
	}

	// Unreachable: the second attempt always returns.
	throw comersError(this, 'Comers did not accept a fresh access token.');
}

export interface JwksResponse {
	statusCode: number;
	body: unknown;
	cacheControl: string | undefined;
}

/** The public delivery keys: no credential, no token. */
export async function fetchDeliveryKeys(this: Context, uri: string): Promise<JwksResponse> {
	const response = (await this.helpers.httpRequest({
		method: 'GET',
		url: uri,
		headers: { accept: 'application/jwk-set+json, application/json' },
		returnFullResponse: true,
		ignoreHttpStatusErrors: true,
		disableFollowRedirect: true,
		json: false,
	})) as { statusCode: number; body: unknown; headers: Record<string, unknown> };
	const cacheControl = response.headers?.['cache-control'];

	return {
		statusCode: response.statusCode,
		body: parseBody(
			Buffer.isBuffer(response.body) ? response.body.toString('utf8') : response.body,
		),
		cacheControl: typeof cacheControl === 'string' ? cacheControl : undefined,
	};
}
