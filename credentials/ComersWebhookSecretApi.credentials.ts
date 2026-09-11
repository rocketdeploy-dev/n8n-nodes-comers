import type { ICredentialType, Icon, INodeProperties } from 'n8n-workflow';

/**
 * The signing secret for one Comers webhook subscription.
 *
 * This is not an API credential. It is never sent anywhere: it exists only so
 * the Comers Trigger node can recompute the HMAC over a delivery it received
 * and decide whether Comers really sent it. Comers issues the secret once,
 * when the subscription is created or its secret is rotated in Business
 * Settings, and never shows it again.
 *
 * One credential belongs to one subscription. Two subscriptions have two
 * secrets and therefore two credentials.
 */
export class ComersWebhookSecretApi implements ICredentialType {
	name = 'comersWebhookSecretApi';

	displayName = 'Comers Webhook Secret API';

	documentationUrl = 'https://github.com/rocketdeploy-dev/n8n-nodes-comers#credentials';

	icon: Icon = { light: 'file:comers.svg', dark: 'file:comers.dark.svg' };

	properties: INodeProperties[] = [
		{
			displayName: 'Signing Secret',
			name: 'signingSecret',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			description:
				'The signing secret Comers showed once when this webhook subscription was created or its secret was rotated. Comers cannot show it again: rotate the secret in Business Settings to get a new one.',
		},
	];
}
