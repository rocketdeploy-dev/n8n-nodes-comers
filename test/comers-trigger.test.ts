import type { IWebhookFunctions } from 'n8n-workflow';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ComersTrigger } from '../nodes/ComersTrigger/ComersTrigger.node';
import { deliveryHeaders, envelopeJson, SIGNING_MATERIAL, sign, signatureHeader } from './helpers';

const NOW = 1788259530;

interface Reply {
	status?: number;
	headers?: Record<string, string>;
	body?: string;
}

/**
 * The smallest slice of n8n's webhook context this node actually touches, so a
 * delivery can be put through the node without an n8n instance behind it.
 */
const context = ({
	body = envelopeJson(),
	headers,
	method = 'POST',
	secret = SIGNING_MATERIAL,
	timestamp = NOW,
	signature,
	credentialError,
	rawBodyPrimed = true,
}: {
	body?: string;
	headers?: Record<string, string | string[] | undefined>;
	method?: string;
	secret?: string;
	timestamp?: number;
	signature?: string;
	credentialError?: Error;
	rawBodyPrimed?: boolean;
} = {}) => {
	const rawBody = Buffer.from(body, 'utf8');
	const reply: Reply = {};
	const logs: Array<{ level: string; message: string; meta: unknown }> = [];
	let rawBodyReads = 0;

	const request = {
		method,
		rawBody: rawBodyPrimed ? rawBody : undefined,
		async readRawBody() {
			rawBodyReads += 1;
			this.rawBody = rawBody;
		},
	} as unknown as { method: string; rawBody: Buffer; readRawBody: () => Promise<void> };

	const allHeaders =
		headers ??
		deliveryHeaders(timestamp, {
			'x-comers-signature': signature ?? signatureHeader(sign(secret, timestamp, rawBody)),
		});

	const fake = {
		getRequestObject: () => request,
		getResponseObject: () => ({
			writeHead(status: number, responseHeaders: Record<string, string>) {
				reply.status = status;
				reply.headers = responseHeaders;
			},
			end(body: string) {
				reply.body = body;
			},
		}),
		getHeaderData: () => allHeaders,
		getCredentials: async () => {
			if (credentialError) throw credentialError;
			return { signingSecret: SIGNING_MATERIAL };
		},
		logger: {
			warn: (message: string, meta: unknown) => logs.push({ level: 'warn', message, meta }),
			error: (message: string, meta: unknown) => logs.push({ level: 'error', message, meta }),
			info: () => {},
			debug: () => {},
		},
	};

	return {
		fake: fake as unknown as IWebhookFunctions,
		reply,
		logs,
		rawBody,
		signatureOffered: allHeaders['x-comers-signature'],
		rawBodyReads: () => rawBodyReads,
	};
};

const node = new ComersTrigger();

beforeEach(() => {
	// The node reads the clock to judge the delivery's timestamp, so the
	// fixtures only line up if the clock is put where they were signed.
	vi.useFakeTimers();
	vi.setSystemTime(NOW * 1000);
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe('a delivery the node accepts', () => {
	it('returns exactly one item', async () => {
		const { fake } = context();

		const result = await node.webhook.call(fake);

		expect(result.workflowData).toHaveLength(1);
		expect(result.workflowData?.[0]).toHaveLength(1);
		expect(result.workflowData?.[0][0].json).toEqual({
			event: JSON.parse(envelopeJson()),
			delivery: {
				subscriptionId: '0199c3f0-1a2b-7c3d-8e4f-000000000002',
				deliveryId: '0199c3f0-1a2b-7c3d-8e4f-000000000003',
				deliveryAttempt: 0,
				timestamp: NOW,
			},
		});
	});

	it('passes the event id through, so the workflow can be idempotent', async () => {
		const { fake } = context();

		const result = await node.webhook.call(fake);

		const item = result.workflowData?.[0][0].json as {
			event: { eventId: string };
			delivery: { deliveryId: string };
		};

		expect(item.event.eventId).toBe('0199c3f0-1a2b-7c3d-8e4f-000000000001');
		expect(item.delivery.deliveryId).toBe('0199c3f0-1a2b-7c3d-8e4f-000000000003');
	});

	it('does not write the response itself, leaving that to n8n', async () => {
		const { fake, reply } = context();

		const result = await node.webhook.call(fake);

		expect(reply.status).toBeUndefined();
		expect(result.noWebhookResponse).toBeUndefined();
	});

	it('reads the raw body itself when n8n has not already', async () => {
		const { fake, rawBodyReads } = context({ rawBodyPrimed: false });

		const result = await node.webhook.call(fake);

		expect(rawBodyReads()).toBe(1);
		expect(result.workflowData).toHaveLength(1);
	});
});

describe('a delivery the node refuses', () => {
	const refusals: Array<[string, Parameters<typeof context>[0], number, string]> = [
		['no signature at all', { headers: deliveryHeaders(NOW) }, 401, 'missing_signature'],
		['a signature from the wrong secret', { secret: 'a-secret-this-node-does-not-hold' }, 401, 'signature_mismatch'],
		['a signature scheme it does not know', { signature: 'v9=YWJjZA==' }, 401, 'unsupported_signature_version'],
		['a timestamp outside the window', { timestamp: NOW - 100_000 }, 401, 'timestamp_outside_window'],
		['a method that is not POST', { method: 'GET' }, 401, 'method_not_allowed'],
	];

	it.each(refusals)('refuses %s', async (_label, overrides, status, reason) => {
		const { fake, reply } = context(overrides);

		const result = await node.webhook.call(fake);

		// No workflowData at all: n8n does not start the workflow.
		expect(result.workflowData).toBeUndefined();
		expect(result.noWebhookResponse).toBe(true);
		expect(reply.status).toBe(status);
		expect(reply.body).toBe(reason);
	});

	it('answers 400 when the signature is right but the envelope is not', async () => {
		const { fake, reply } = context({ body: '{"specVersion":"comers.v1"}' });

		const result = await node.webhook.call(fake);

		expect(result.workflowData).toBeUndefined();
		expect(reply.status).toBe(400);
		expect(reply.body).toBe('malformed_envelope');
	});

	it('answers 400 when the signature is right but the body is not JSON', async () => {
		const { fake, reply } = context({ body: 'definitely not json' });

		const result = await node.webhook.call(fake);

		expect(result.workflowData).toBeUndefined();
		expect(reply.status).toBe(400);
		expect(reply.body).toBe('body_not_json');
	});

	it('answers 500, saying nothing more, when something unexpected breaks', async () => {
		const { fake, reply, logs } = context({
			credentialError: new TypeError('connection string postgres://user:hunter2@db/n8n failed'),
		});

		const result = await node.webhook.call(fake);

		expect(result.workflowData).toBeUndefined();
		expect(reply.status).toBe(500);
		expect(reply.body).toBe('internal_error');
		expect(JSON.stringify(logs)).not.toContain('hunter2');
		expect(JSON.stringify(logs)).toContain('TypeError');
	});
});

describe('the credential', () => {
	it('is required: without it nothing is authenticated and nothing runs', async () => {
		const { fake, reply } = context({
			credentialError: new Error('Credentials could not be found'),
		});

		const result = await node.webhook.call(fake);

		expect(result.workflowData).toBeUndefined();
		expect(reply.status).toBe(500);
	});

	it('is declared as required on the node', () => {
		expect(node.description.credentials).toEqual([
			{
				name: 'comersWebhookSecretApi',
				required: true,
				testedBy: 'comersSigningSecretShape',
			},
		]);
	});
});

describe('the body is only parsed once it is proven', () => {
	it('does not parse JSON when authentication fails', async () => {
		const parse = vi.spyOn(JSON, 'parse');
		const { fake } = context({ secret: 'the-wrong-secret', body: '{"a":1}' });

		await node.webhook.call(fake);

		expect(parse).not.toHaveBeenCalled();
	});

	it('parses JSON once authentication succeeds', async () => {
		const parse = vi.spyOn(JSON, 'parse');
		const { fake } = context();

		await node.webhook.call(fake);

		expect(parse).toHaveBeenCalled();
	});
});

describe('re-serialising cannot stand in for the raw body', () => {
	it('refuses a delivery signed over a re-serialised copy of its own body', async () => {
		const pretty = JSON.stringify(JSON.parse(envelopeJson()), null, 2);
		const reSerialised = JSON.stringify(JSON.parse(pretty));

		expect(reSerialised).not.toBe(pretty);

		const { fake, reply } = context({
			body: pretty,
			signature: signatureHeader(sign(SIGNING_MATERIAL, NOW, reSerialised)),
		});

		const result = await node.webhook.call(fake);

		expect(result.workflowData).toBeUndefined();
		expect(reply.status).toBe(401);
	});

	it('accepts the same pretty-printed body when the signature covers its real bytes', async () => {
		const pretty = JSON.stringify(JSON.parse(envelopeJson()), null, 2);
		const { fake } = context({ body: pretty, signature: signatureHeader(sign(SIGNING_MATERIAL, NOW, pretty)) });

		const result = await node.webhook.call(fake);

		expect(result.workflowData).toHaveLength(1);
	});
});

describe('nothing secret leaves the node', () => {
	it('keeps the secret and the signature out of the item', async () => {
		const { fake, signatureOffered } = context();

		const result = await node.webhook.call(fake);
		const emitted = JSON.stringify(result.workflowData);

		expect(emitted).not.toContain(SIGNING_MATERIAL);
		expect(emitted).not.toContain(String(signatureOffered));
		expect(emitted).not.toContain('signingSecret');
		// The whole header block, including any Authorization, stays out too.
		expect(emitted).not.toContain('x-comers-signature');
	});

	it('keeps them out of the refusal it sends back', async () => {
		const { fake, reply, signatureOffered } = context({ secret: 'the-wrong-secret' });

		await node.webhook.call(fake);

		expect(reply.body).not.toContain(SIGNING_MATERIAL);
		expect(reply.body).not.toContain(String(signatureOffered));
	});

	it('keeps them, and the body, out of the log', async () => {
		const { fake, logs } = context({ secret: 'the-wrong-secret' });

		await node.webhook.call(fake);

		const logged = JSON.stringify(logs);

		expect(logged).not.toContain(SIGNING_MATERIAL);
		expect(logged).not.toContain('the-wrong-secret');
		expect(logged).not.toContain('support.case.opened');
		expect(logged).toContain('signature_mismatch');
	});
});

describe('the manual webhook lifecycle', () => {
	const hooks = node.webhookMethods.default;

	it('reports the webhook as already registered, so n8n never tries to create one', async () => {
		expect(await hooks.checkExists.call({} as never)).toBe(true);
	});

	it('succeeds on create and delete without registering anything', async () => {
		expect(await hooks.create.call({} as never)).toBe(true);
		expect(await hooks.delete.call({} as never)).toBe(true);
	});

	it('performs no I/O at all', async () => {
		const fetchStub = vi.fn();
		vi.stubGlobal('fetch', fetchStub);

		await hooks.checkExists.call({} as never);
		await hooks.create.call({} as never);
		await hooks.delete.call({} as never);

		expect(fetchStub).not.toHaveBeenCalled();

		// Stronger than watching one client: each hook's compiled body is
		// nothing but a return, so there is no call of any kind to intercept.
		for (const hook of [hooks.checkExists, hooks.create, hooks.delete]) {
			expect(hook.toString().replace(/\s+/g, ' ')).toMatch(
				/^async [a-z]+\(\) \{ return true; \}$/i,
			);
		}
	});

	it('is stateless, so activating and deactivating repeatedly changes nothing', async () => {
		for (let round = 0; round < 3; round += 1) {
			expect(await hooks.checkExists.call({} as never)).toBe(true);
			expect(await hooks.delete.call({} as never)).toBe(true);
		}

		// A delivery after all that is treated exactly as the first one was.
		const { fake } = context();
		expect((await node.webhook.call(fake)).workflowData).toHaveLength(1);
	});
});

describe('the node describes itself as a receive-only trigger', () => {
	it('declares one POST webhook and no inputs', () => {
		expect(node.description.inputs).toEqual([]);
		expect(node.description.webhooks).toEqual([
			expect.objectContaining({ httpMethod: 'POST', responseMode: 'onReceived' }),
		]);
	});

	it('does not echo the event back to Comers', () => {
		expect(node.description.webhooks?.[0].responseData).toBe('noData');
	});
});
