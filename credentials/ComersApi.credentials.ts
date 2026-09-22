import type {
	IAuthenticateGeneric,
	ICredentialTestRequest,
	ICredentialType,
	Icon,
	INodeProperties,
} from 'n8n-workflow';

/**
 * A Comers machine integration: the OAuth client an organization creates in
 * Comers for this n8n, with the event subscription scope.
 *
 * The Comers Trigger uses it to obtain a short-lived access token
 * (client_credentials, client_secret_basic) and, with that token, to create and
 * archive the workflow's own event subscription. The client secret is only
 * ever sent to the Comers token endpoint; the access token lives in memory for
 * its lifetime and is never stored. Nothing about a delivery's verification is
 * secret, so this credential is the only secret the node holds.
 */
export class ComersApi implements ICredentialType {
	name = 'comersApi';

	displayName = 'Comers API';

	documentationUrl = 'https://github.com/rocketdeploy-dev/n8n-nodes-comers#credentials';

	icon: Icon = { light: 'file:comers.svg', dark: 'file:comers.dark.svg' };

	properties: INodeProperties[] = [
		{
			displayName: 'Comers URL',
			name: 'baseUrl',
			type: 'string',
			default: '',
			required: true,
			placeholder: 'https://app.comers.example',
			description:
				'The public HTTPS origin of your Comers installation, without a path. Tokens, subscriptions and delivery keys are all requested from it.',
		},
		{
			displayName: 'Client ID',
			name: 'clientId',
			type: 'string',
			default: '',
			required: true,
			description: 'The client ID of the machine integration created in Comers',
		},
		{
			displayName: 'Client Secret',
			name: 'clientSecret',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			description:
				'The client secret Comers showed once when the integration or its credential was created',
		},
	];

	/**
	 * Client authentication, applied by n8n only to the token request: HTTP
	 * Basic with the client ID and secret (client_secret_basic). Comers API
	 * calls carry the short-lived access token instead.
	 */
	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			auth: {
				username: '={{$credentials.clientId}}',
				password: '={{$credentials.clientSecret}}',
			},
		},
	};

	/**
	 * Asks the Comers token endpoint for a token with exactly the scope the
	 * trigger needs. Comers answers 401 for a wrong client ID or secret and 400
	 * `invalid_scope` when the integration was not granted the scope, so one
	 * request proves both. The token itself is discarded by n8n.
	 */
	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.baseUrl.replace(/\\/+$/, "")}}',
			url: '/core/oauth2/token',
			method: 'POST',
			headers: {
				'content-type': 'application/x-www-form-urlencoded',
				accept: 'application/json',
			},
			body: 'grant_type=client_credentials&scope=comers.core.events.subscriptions.manage-own',
			disableFollowRedirect: true,
		},
		rules: [
			{
				type: 'responseCode',
				properties: {
					value: 401,
					message: 'Comers did not accept this client ID and secret.',
				},
			},
			{
				type: 'responseCode',
				properties: {
					value: 400,
					message:
						'Comers refused the token request. The integration needs the scope comers.core.events.subscriptions.manage-own.',
				},
			},
			{
				type: 'responseCode',
				properties: {
					value: 404,
					message:
						'Comers URL does not serve machine access. Check the URL, and that machine access is enabled for this installation.',
				},
			},
			{
				type: 'responseCode',
				properties: {
					value: 503,
					message: 'Comers is temporarily unavailable. Try again.',
				},
			},
		],
	};
}
