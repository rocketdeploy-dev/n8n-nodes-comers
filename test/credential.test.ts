import { describe, expect, it } from 'vitest';

import { ComersApi } from '../credentials/ComersApi.credentials';
import { CLIENT_MATERIAL, ComersStub, credentials, ORIGIN, SCOPE } from './support/comers';

/**
 * The credential test is declarative, as n8n requires for a lint-clean
 * community node: n8n sends `test.request` with the credential's `authenticate`
 * applied and reports the first matching `responseCode` rule. This emulates
 * exactly that against the Comers contract stub.
 */
const runCredentialTest = (stub: ComersStub, creds: Record<string, string>) => {
	const credential = new ComersApi();
	const { request, rules } = credential.test;
	const auth = credential.authenticate.properties.auth!;

	expect(request.baseURL).toBe('={{$credentials.baseUrl.replace(/\\/+$/, "")}}');
	expect(auth).toEqual({
		username: '={{$credentials.clientId}}',
		password: '={{$credentials.clientSecret}}',
	});

	const response = stub.handle({
		method: request.method,
		url: `${creds.baseUrl.replace(/\/+$/, '')}${request.url}`,
		headers: request.headers,
		body: request.body,
		auth: { username: creds.clientId, password: creds.clientSecret },
	});
	const rule = (rules ?? []).find(
		(candidate) => candidate.type === 'responseCode' && candidate.properties.value === response.statusCode,
	);

	if (rule !== undefined) return { status: 'Error', message: String(rule.properties.message) };
	return response.statusCode >= 200 && response.statusCode < 300
		? { status: 'OK' }
		: { status: 'Error', message: `HTTP ${response.statusCode}` };
};

describe('Comers API credential', () => {
	it('holds only the Comers URL, the client ID and the client secret as a password', () => {
		const properties = new ComersApi().properties;

		expect(properties.map((property) => property.name)).toEqual(['baseUrl', 'clientId', 'clientSecret']);
		expect(properties.find((property) => property.name === 'clientSecret')?.typeOptions).toEqual({
			password: true,
		});
	});

	it('passes with a valid client and the subscription scope, requesting exactly that scope with client_secret_basic', () => {
		const stub = new ComersStub();

		expect(runCredentialTest(stub, credentials({ baseUrl: `${ORIGIN}/` }))).toEqual({ status: 'OK' });

		const [token] = stub.requests;
		expect(token).toMatchObject({ method: 'POST', path: '/core/oauth2/token' });
		expect(new URLSearchParams(String(token.body)).get('grant_type')).toBe('client_credentials');
		expect(new URLSearchParams(String(token.body)).get('scope')).toBe(SCOPE);
	});

	it('reports a wrong secret readably, without the secret', () => {
		const wrongMaterial = 'wrong-material-0000000000';
		const result = runCredentialTest(new ComersStub(), credentials({ clientSecret: wrongMaterial }));

		expect(result).toEqual({ status: 'Error', message: 'Comers did not accept this client ID and secret.' });
		expect(JSON.stringify(result)).not.toContain(wrongMaterial);
		expect(JSON.stringify(result)).not.toContain(CLIENT_MATERIAL);
	});

	it('reports a missing scope readably', () => {
		const stub = new ComersStub();
		stub.scopes = ['comers.core.orders.read'];

		expect(runCredentialTest(stub, credentials())).toEqual({
			status: 'Error',
			message:
				'Comers refused the token request. The integration needs the scope comers.core.events.subscriptions.manage-own.',
		});
	});
});
