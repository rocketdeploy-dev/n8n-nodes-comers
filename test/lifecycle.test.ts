import type { IHookFunctions } from 'n8n-workflow';
import { beforeEach, describe, expect, it } from 'vitest';

import { ComersTrigger } from '../nodes/ComersTrigger/ComersTrigger.node';
import { clearTokenCache } from '../nodes/ComersTrigger/comers-api';
import {
	CLIENT_MATERIAL,
	ComersStub,
	hookContext,
	JWKS_PATH,
	ORGANIZATION_ID,
	ORIGIN,
	productionState,
	selectedEvents,
	WEBHOOK_URL,
	type HookOptions,
} from './support/comers';

const hooks = new ComersTrigger().webhookMethods.default;
const call = <T>(method: (this: IHookFunctions) => Promise<T>, context: unknown) =>
	method.call(context as IHookFunctions);

/** What n8n does when a workflow is published: checkExists, then create if needed. */
const activate = async (options: HookOptions) => {
	const { context } = hookContext(options);
	if (!(await call(hooks.checkExists, context))) {
		await call(hooks.create, context);
	}
};

const posts = (stub: ComersStub) =>
	stub.requests.filter((request) => request.method === 'POST' && request.path === '/core/api/v1/event-subscriptions');

describe('subscription lifecycle', () => {
	let stub: ComersStub;
	let staticData: Record<string, unknown>;

	beforeEach(() => {
		clearTokenCache();
		stub = new ComersStub();
		staticData = {};
	});

	it('creates exactly one jws-es256-v1 subscription for the production URL and keeps only non-secret state', async () => {
		await activate({ stub, staticData });

		expect(posts(stub)).toHaveLength(1);
		const [subscription] = stub.subscriptions.values();
		expect(subscription).toMatchObject({
			signatureProfile: 'jws-es256-v1',
			targetUrl: WEBHOOK_URL,
			events: [{ eventKey: 'comers.core.support.case.opened', eventVersion: 1 }],
		});
		expect(subscription.name).toMatch(/^Orders \/ Comers Trigger \[n8n production [0-9a-f]{20}\]$/);
		expect(posts(stub)[0].body).toMatchObject({ signatureProfile: 'jws-es256-v1' });

		expect(Object.keys(staticData).sort()).toEqual(['production', 'schemaVersion']);
		expect({ schemaVersion: staticData.schemaVersion, ...productionState(staticData) }).toMatchObject({
			schemaVersion: 2,
			subscriptionId: subscription.subscriptionId,
			jwksUri: `${ORIGIN}${JWKS_PATH}`,
			signatureProfile: 'jws-es256-v1',
			organizationId: ORGANIZATION_ID,
		});
		const stored = JSON.stringify(staticData);
		expect(stored).not.toContain(CLIENT_MATERIAL);
		expect(stored).not.toContain('stub-access-token');
		// Every Comers call carried a bearer token; only the token request carried the client secret.
		for (const request of stub.requests) {
			if (request.path === '/core/oauth2/token') expect(request.basicAuth?.password).toBe(CLIENT_MATERIAL);
			else expect(request.basicAuth).toBeUndefined();
		}
	});

	it('finds its existing subscription again on the next activation instead of creating another', async () => {
		await activate({ stub, staticData });
		await activate({ stub, staticData });

		expect(posts(stub)).toHaveLength(1);
		expect(stub.requests.some((request) => request.method === 'GET' && request.path.endsWith(String(productionState(staticData).subscriptionId)))).toBe(true);
	});

	it('updates the name and events of its subscription when the node changes', async () => {
		await activate({ stub, staticData });
		await activate({
			stub,
			staticData,
			parameters: {
				subscriptionName: 'Fulfilment',
				...selectedEvents('comers.core.orders.order.created@2'),
			},
		});

		const [subscription] = stub.subscriptions.values();
		expect(posts(stub)).toHaveLength(1);
		expect(subscription.name).toMatch(/^Fulfilment \[n8n production [0-9a-f]{20}\]$/);
		expect(subscription.events).toEqual([{ eventKey: 'comers.core.orders.order.created', eventVersion: 2 }]);
	});

	it('forgets an ID Comers no longer knows (404) and creates a new subscription', async () => {
		await activate({ stub, staticData });
		stub.subscriptions.clear();

		await activate({ stub, staticData });

		expect(posts(stub)).toHaveLength(2);
		expect(stub.subscriptions.size).toBe(1);
		expect(productionState(staticData).subscriptionId).toBe([...stub.subscriptions.keys()][0]);
	});

	it('recovers a subscription whose create answer was lost, without creating a duplicate', async () => {
		stub.loseNextCreateResponse = true;
		const { context } = hookContext({ stub, staticData });

		expect(await call(hooks.checkExists, context)).toBe(false);
		await expect(call(hooks.create, context)).rejects.toThrow();
		expect(productionState(staticData).subscriptionId).toBeUndefined();
		expect(stub.subscriptions.size).toBe(1);

		// n8n tries the activation again.
		await activate({ stub, staticData });

		expect(posts(stub)).toHaveLength(1);
		expect(productionState(staticData).subscriptionId).toBe([...stub.subscriptions.keys()][0]);
	});

	it('archives a subscription whose create answer was lost when the workflow is deactivated right after', async () => {
		stub.loseNextCreateResponse = true;
		const { context } = hookContext({ stub, staticData });

		await expect(call(hooks.create, context)).rejects.toThrow();
		expect(productionState(staticData).subscriptionId).toBeUndefined();
		const [orphan] = stub.subscriptions.values();

		// No checkExists in between: delete itself has to find the orphan.
		expect(await call(hooks.delete, context)).toBe(true);
		expect(orphan.state).toBe('archived');
		expect(productionState(staticData).subscriptionId).toBeUndefined();
	});

	it('does not read an unfinished subscription list as "not found"', async () => {
		stub.endlessList = true;
		const { context } = hookContext({ stub, staticData });

		await expect(call(hooks.checkExists, context)).rejects.toThrow(/cannot tell whether it already has one/);
		expect(posts(stub)).toHaveLength(0);
	});

	it('never takes over a subscription only because it looks similar', async () => {
		// The same URL but another node's marker, and this node's marker on another URL.
		await activate({ stub, staticData: {}, nodeId: '6f1c2d3e-0000-4000-8000-0000000000ff' });
		const [foreign] = stub.subscriptions.values();
		foreign.name = foreign.name.replace(/\[n8n [0-9a-f]+\]/u, '[n8n 00000000000000000000]');

		await activate({ stub, staticData });

		expect(posts(stub)).toHaveLength(2);
		expect(productionState(staticData).subscriptionId).not.toBe(foreign.subscriptionId);
	});

	it('refuses to guess between two subscriptions that both match', async () => {
		await activate({ stub, staticData: {} });
		await activate({ stub, staticData: {} });
		// Two survived through a race elsewhere; the node must not pick one.
		const [first] = stub.subscriptions.values();
		stub.subscriptions.set('0199c3f0-1a2b-7c3d-8e4f-0000000000ee', { ...first, subscriptionId: '0199c3f0-1a2b-7c3d-8e4f-0000000000ee' });

		const { context } = hookContext({ stub, staticData: {} });
		await expect(call(hooks.checkExists, context)).rejects.toThrow(/2 subscriptions for this workflow node/);
	});

	it('does not treat an error while checking as "does not exist"', async () => {
		await activate({ stub, staticData });
		stub.failOnce[`GET /core/api/v1/event-subscriptions/${String(productionState(staticData).subscriptionId)}`] = 503;
		const { context } = hookContext({ stub, staticData });

		await expect(call(hooks.checkExists, context)).rejects.toThrow(/right now/);
		expect(posts(stub)).toHaveLength(1);
		expect(productionState(staticData).subscriptionId).toBeDefined();
	});

	it('archives exactly its subscription on deactivation and clears the state only after 204 or 404', async () => {
		await activate({ stub, staticData });
		const id = String(productionState(staticData).subscriptionId);
		const { context } = hookContext({ stub, staticData });

		// A transient failure keeps the state, so n8n can retry the cleanup.
		stub.failOnce[`DELETE /core/api/v1/event-subscriptions/${id}`] = 503;
		await expect(call(hooks.delete, context)).rejects.toThrow();
		expect(productionState(staticData).subscriptionId).toBe(id);

		expect(await call(hooks.delete, context)).toBe(true);
		expect(stub.subscriptions.get(id)?.state).toBe('archived');
		expect(productionState(staticData).subscriptionId).toBeUndefined();

		// Already archived and forgotten: nothing to do.
		expect(await call(hooks.delete, context)).toBe(true);

		// 404 is idempotent too.
		staticData.production = { subscriptionId: '0199c3f0-1a2b-7c3d-8e4f-0000000000dd' };
		expect(await call(hooks.delete, context)).toBe(true);
		expect(productionState(staticData).subscriptionId).toBeUndefined();
	});

	it('fetches a new token once when Comers rejects the cached one, and never more than once', async () => {
		await activate({ stub, staticData });
		stub.revokeTokens();
		const before = stub.requests.filter((request) => request.path === '/core/oauth2/token').length;

		await activate({ stub, staticData });
		expect(stub.requests.filter((request) => request.path === '/core/oauth2/token').length).toBe(before + 1);
	});

	it('explains a missing scope at activation, without the secret', async () => {
		stub.scopes = [];
		const { context } = hookContext({ stub, staticData });
		const error = await call(hooks.checkExists, context).catch((failure: Error) => failure);

		expect(String(error)).toMatch(/missing the scope comers\.core\.events\.subscriptions\.manage-own/);
		expect(String(error)).not.toContain(CLIENT_MATERIAL);
	});

	it('rejects a non-catalog choice and preserves a selected future catalog event', async () => {
		const bad = hookContext({ stub, staticData: {}, parameters: selectedEvents('Orders Created@1') });
		await expect(call(hooks.checkExists, bad.context)).rejects.toThrow(/Choose an event/);

		await activate({
			stub,
			staticData,
			parameters: selectedEvents('comers.core.future.thing.happened@3'),
		});
		expect([...stub.subscriptions.values()][0].events).toEqual([
			{ eventKey: 'comers.core.future.thing.happened', eventVersion: 3 },
		]);
	});

	it('keeps test listening isolated from production and archives only the test subscription', async () => {
		await activate({ stub, staticData });
		const productionId = String(productionState(staticData).subscriptionId);
		const { context } = hookContext({ stub, staticData, mode: 'manual' });
		if (!(await call(hooks.checkExists, context))) await call(hooks.create, context);

		const test = staticData.test as Record<string, unknown>;
		const testId = String(test.subscriptionId);
		expect(testId).not.toBe(productionId);
		expect(stub.subscriptions.get(testId)?.targetUrl).toContain('/webhook-test/');
		expect(posts(stub).at(-1)?.body).toMatchObject({ expiresInSeconds: 600 });
		expect(stub.subscriptions.get(productionId)?.targetUrl).toBe(WEBHOOK_URL);
		expect(posts(stub)[0].body).not.toHaveProperty('expiresInSeconds');
		expect(stub.subscriptions.get(testId)?.name).toMatch(/\[n8n test [0-9a-f]{20}\]$/);
		expect(stub.subscriptions.get(productionId)?.name).toMatch(/\[n8n production [0-9a-f]{20}\]$/);

		expect(await call(hooks.delete, context)).toBe(true);
		expect(stub.subscriptions.get(testId)?.state).toBe('archived');
		expect(stub.subscriptions.get(productionId)?.state).toBe('active');
		expect(productionState(staticData).subscriptionId).toBe(productionId);
	});
});
