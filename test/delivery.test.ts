import type { IHookFunctions, IWebhookFunctions } from 'n8n-workflow';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ComersTrigger, deliveryKeys } from '../nodes/ComersTrigger/ComersTrigger.node';
import { clearTokenCache } from '../nodes/ComersTrigger/comers-api';
import {
	CLIENT_MATERIAL,
	ComersStub,
	envelope,
	hookContext,
	newSigningKey,
	signedDelivery,
	webhookContext,
} from './support/comers';

const trigger = new ComersTrigger();

describe('delivery verification', () => {
	let stub: ComersStub;
	let staticData: Record<string, unknown>;
	let subscriptionId: string;

	afterEach(() => {
		vi.useRealTimers();
	});

	beforeEach(async () => {
		clearTokenCache();
		deliveryKeys.clear();
		stub = new ComersStub();
		staticData = {};
		const { context } = hookContext({ stub, staticData });
		await trigger.webhookMethods.default.create.call(context as unknown as IHookFunctions);
		subscriptionId = String(staticData.subscriptionId);
	});

	const deliver = async (body: string) => {
		const hook = webhookContext({ stub, staticData, body });
		const result = await trigger.webhook.call(hook.context as unknown as IWebhookFunctions);

		return { result, reply: hook.reply, logs: hook.logs };
	};

	it('runs the workflow with one {event, delivery} item for a delivery signed with a published key', async () => {
		const body = signedDelivery({ key: stub.keys[0], subscriptionId });
		const { result, reply, logs } = await deliver(body);

		expect(reply.status).toBeUndefined();
		expect(result.workflowData).toHaveLength(1);
		const [[item]] = result.workflowData!;
		expect(Object.keys(item.json).sort()).toEqual(['delivery', 'event']);
		expect(item.json.event).toEqual(envelope());
		expect(item.json.delivery).toMatchObject({ subscriptionId, deliveryAttempt: 1 });

		const output = JSON.stringify([result, logs]);
		const jws = JSON.parse(body) as { protected: string; signature: string };
		expect(output).not.toContain(jws.signature);
		expect(output).not.toContain(jws.protected);
		expect(output).not.toContain(CLIENT_MATERIAL);
		expect(output).not.toContain('stub-access-token');
	});

	it('passes a future event key it has never heard of, unchanged', async () => {
		const event = envelope({ eventKey: 'comers.core.future.thing.happened', eventVersion: 7, data: { shape: 'new' } });
		const { result } = await deliver(signedDelivery({ key: stub.keys[0], subscriptionId, event }));

		expect(result.workflowData![0][0].json.event).toEqual(event);
	});

	const refusals: Array<[string, () => string, number, string]> = [
		[
			'a changed payload (bad signature)',
			() => {
				const jws = JSON.parse(signedDelivery({ key: stub.keys[0], subscriptionId })) as Record<string, string>;
				const other = JSON.parse(signedDelivery({ key: stub.keys[0], subscriptionId, event: envelope({ data: { priority: 'low' } }) })) as Record<string, string>;
				return JSON.stringify({ ...jws, payload: other.payload });
			},
			401,
			'signature',
		],
		[
			'alg none',
			() => {
				const jws = JSON.parse(signedDelivery({ key: stub.keys[0], subscriptionId, header: { typ: 'comers-delivery+jws', alg: 'none', kid: stub.keys[0].kid } })) as Record<string, string>;
				return JSON.stringify({ ...jws, signature: '' });
			},
			401,
			'algorithm',
		],
		[
			'HS256',
			() => signedDelivery({ key: stub.keys[0], subscriptionId, header: { typ: 'comers-delivery+jws', alg: 'HS256', kid: stub.keys[0].kid } }),
			401,
			'algorithm',
		],
		[
			'a key Comers does not publish',
			() => {
				const stranger = newSigningKey(9);
				return signedDelivery({ key: stranger, subscriptionId });
			},
			401,
			'unknown_kid',
		],
		[
			'a delivery signed for another subscription',
			() => signedDelivery({ key: stub.keys[0], subscriptionId: '0199c3f0-1a2b-7c3d-8e4f-0000000000ee' }),
			401,
			'other_subscription',
		],
		[
			'an old timestamp',
			() => signedDelivery({ key: stub.keys[0], subscriptionId, timestamp: Math.floor(Date.now() / 1000) - 301 }),
			401,
			'stale_timestamp',
		],
		[
			'another organization',
			() => signedDelivery({ key: stub.keys[0], subscriptionId, event: envelope({ scope: { organizationId: '0199c3f0-1a2b-7c3d-8e4f-0000000000ff', sellerId: null, sellerStoreId: null } }) }),
			401,
			'other_organization',
		],
		[
			'an unprotected header',
			() => JSON.stringify({ ...(JSON.parse(signedDelivery({ key: stub.keys[0], subscriptionId })) as object), header: { kid: 'x' } }),
			400,
			'not_flattened_jws',
		],
		[
			'a key signing under the published kid of another key',
			() => signedDelivery({ key: stub.keys[0], subscriptionId, signWith: newSigningKey(1).privateKey }),
			401,
			'signature',
		],
	];

	for (const [name, build, status, reason] of refusals) {
		it(`does not run the workflow for ${name}`, async () => {
			const { result, reply } = await deliver(build());

			expect(result.workflowData).toBeUndefined();
			expect(reply).toEqual({ status, body: reason });
		});
	}

	it('refreshes the key set exactly once for an unknown kid, and verifies with the rotated key', async () => {
		await deliver(signedDelivery({ key: stub.keys[0], subscriptionId }));
		expect(stub.jwksRequests()).toBe(1);

		// Comers rotates: the new key is published; the node's cached set,
		// fetched more than the refresh interval ago, predates it.
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(Date.now() + 11_000);
		const rotated = newSigningKey(2);
		stub.keys.push(rotated);

		const { result } = await deliver(signedDelivery({ key: rotated, subscriptionId }));
		expect(result.workflowData).toHaveLength(1);
		expect(stub.jwksRequests()).toBe(2);

		// A forged kid right after cannot make the node fetch again.
		const { reply } = await deliver(signedDelivery({ key: newSigningKey(3), subscriptionId }));
		expect(reply).toEqual({ status: 401, body: 'unknown_kid' });
		expect(stub.jwksRequests()).toBe(2);
	});

	it('refuses with 503 — so Comers retries — when the published key set is unusable', async () => {
		stub.keys[0].jwk = { ...stub.keys[0].jwk, x: String(stub.keys[0].jwk.y) };
		const { result, reply } = await deliver(signedDelivery({ key: stub.keys[0], subscriptionId }));

		expect(result.workflowData).toBeUndefined();
		expect(reply).toEqual({ status: 503, body: 'keys_unavailable' });
	});

	it('refuses deliveries once the subscription was archived', async () => {
		const { context } = hookContext({ stub, staticData });
		await trigger.webhookMethods.default.delete.call(context as unknown as IHookFunctions);

		const { result, reply } = await deliver(signedDelivery({ key: stub.keys[0], subscriptionId }));
		expect(result.workflowData).toBeUndefined();
		expect(reply).toEqual({ status: 401, body: 'not_registered' });
	});
});
