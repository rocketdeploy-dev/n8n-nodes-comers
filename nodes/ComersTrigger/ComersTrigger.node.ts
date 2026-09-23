import type {
	IDataObject,
	IHookFunctions,
	ILoadOptionsFunctions,
	INodeType,
	INodeTypeDescription,
	IWebhookFunctions,
	IWebhookResponseData,
} from 'n8n-workflow';
import { NodeConnectionTypes } from 'n8n-workflow';

import { comersConnection, deliveryKeysUri, fetchDeliveryKeys } from './comers-api';
import {
	DeliveryKeyCache,
	readJws,
	verifyJws,
	type Refused,
	type Unavailable,
} from './delivery-jws';
import { readDelivery } from './envelope';
import {
	checkExists,
	createSubscription,
	deleteSubscription,
	archiveDeliveredTestSubscription,
	SIGNATURE_PROFILE,
	type RegistrationState,
} from './registration';
import { getEventOptions } from './event-catalog';

/** Public delivery keys, shared by every Comers Trigger in this process. */
export const deliveryKeys = new DeliveryKeyCache();

/** Verifies the delivery against the published keys; the payload only once the signature holds. */
async function verifiedPayload(
	this: IWebhookFunctions,
	jwksUri: string,
	rawBody: Buffer,
): Promise<{ ok: true; payload: unknown } | Refused | Unavailable> {
	const jws = readJws(rawBody);

	if (!jws.ok) return jws;

	const key = await deliveryKeys.key(jwksUri, jws.kid, (uri) => fetchDeliveryKeys.call(this, uri));

	if (!key.ok) return key;

	return verifyJws(jws, key.key);
}

export class ComersTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Comers Trigger',
		name: 'comersTrigger',
		icon: { light: 'file:comers.svg', dark: 'file:comers.dark.svg' },
		group: ['trigger'],
		version: 1,
		subtitle:
			'={{$parameter["events"]["event"] ? $parameter["events"]["event"].map(e => e.eventKey).join(", ") : ""}}',
		description: 'Starts the workflow when Comers delivers a signed domain event',
		eventTriggerDescription: 'Waiting for Comers to deliver an event',
		activationMessage:
			'Comers now delivers the selected events to this workflow. Unpublishing the workflow archives its subscription.',
		defaults: { name: 'Comers Trigger' },
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: 'comersApi', required: true }],
		webhooks: [
			{
				name: 'default',
				httpMethod: 'POST',
				responseMode: 'onReceived',
				// Comers ignores the body of a successful delivery.
				responseData: 'noData',
				path: 'webhook',
			},
		],
		triggerPanel: {
			header: '',
			executionsHelp: {
				inactive:
					'Publish the workflow to receive events: publishing creates this workflow’s subscription in Comers, and Comers then delivers to the production URL. Deliveries appear in the executions list.',
				active:
					'The workflow is published and subscribed. Comers delivers the selected events to the production URL, and they appear in the <a data-key="executions">executions list</a>.',
			},
			activationHint:
				'Publish the workflow to create its Comers subscription. Unpublishing or deleting it archives the subscription.',
		},
		properties: [
			{
				displayName: 'Subscription Name',
				name: 'subscriptionName',
				type: 'string',
				default: '',
				placeholder: 'Orders to fulfilment',
				description:
					'How the subscription is named in Comers. Leave empty to use the workflow and node names. A short identifier of this node is always appended.',
			},
			{
				displayName: 'Events',
				name: 'events',
				type: 'fixedCollection',
				typeOptions: { multipleValues: true },
				default: {},
				required: true,
				placeholder: 'Add Event',
				description:
					'The Comers events that start this workflow. Any event key Comers publishes can be used, including ones added after this node was released.',
				options: [
					{
								displayName: 'Event',
						name: 'event',
						values: [
							{
									displayName: 'Event Name or ID',
								name: 'event',
								type: 'options',
								typeOptions: { loadOptionsMethod: 'getEventOptions' },
								default: '',
								required: true,
									description: 'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
							},
						],
					},
				],
			},
		],
	};

	webhookMethods = {
		default: {
			async checkExists(this: IHookFunctions): Promise<boolean> {
				return checkExists.call(this);
			},
			async create(this: IHookFunctions): Promise<boolean> {
				return createSubscription.call(this);
			},
			async delete(this: IHookFunctions): Promise<boolean> {
				return deleteSubscription.call(this);
			},
		},
	};

	methods = { loadOptions: { getEventOptions: async function (this: ILoadOptionsFunctions) { return getEventOptions.call(this); } } };

	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		const response = this.getResponseObject();

		const refuse = (status: number, reason: string): IWebhookResponseData => {
			// Comers keeps a bounded snippet of any non-2xx body, so the reply
			// carries a fixed code and nothing that came out of the request.
			response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
			response.end(reason);

			// No workflowData: the workflow does not run.
			return { noWebhookResponse: true };
		};

		try {
			const state = this.getWorkflowStaticData('node') as RegistrationState & IDataObject;
			const connection = await comersConnection.call(this);

			const registrations = ([['production', state.production], ['test', state.test]] as const).filter(
				(entry): entry is ['production' | 'test', NonNullable<typeof state.test>] => {
					const slot = entry[1];
					return (
					typeof slot?.subscriptionId === 'string' &&
					slot.signatureProfile === SIGNATURE_PROFILE &&
					slot.jwksUri === deliveryKeysUri(connection.origin)
					);
				},
			);
			if (registrations.length === 0) {
				return refuse(401, 'not_registered');
			}

			const request = this.getRequestObject();

			if (request.rawBody === undefined) {
				await request.readRawBody();
			}

			const verified = await verifiedPayload.call(this, deliveryKeysUri(connection.origin), request.rawBody);

			if (!verified.ok) {
				if ('unavailable' in verified) {
					// Comers retries a 503, by which time the keys may be reachable.
					this.logger.warn('Comers Trigger could not obtain the delivery keys', {
						reason: verified.unavailable,
					});

					return refuse(503, 'keys_unavailable');
				}

				this.logger.warn('Comers Trigger refused a delivery', { reason: verified.refused });

				return refuse(verified.refused === 'not_flattened_jws' ? 400 : 401, verified.refused);
			}

			// The JWS is verified before selecting an identity. Then only the exact
			// test or production subscription ID may accept its envelope.
			const deliveries = registrations.map(([mode, slot]) => ({ mode, slot, delivery: readDelivery({
				payload: verified.payload,
				subscriptionId: slot.subscriptionId as string,
				organizationId: typeof slot.organizationId === 'string' ? slot.organizationId : undefined,
				nowSeconds: Math.floor(Date.now() / 1000),
			}) }));
			const matched = deliveries.find((candidate) => candidate.delivery.ok) ?? deliveries[0];
			const delivery = matched?.delivery;

			if (delivery === undefined || !delivery.ok) {
				const reason = delivery === undefined ? 'other_subscription' : delivery.reason;
				this.logger.warn('Comers Trigger refused a delivery', { reason });

				return refuse(reason === 'malformed_envelope' ? 400 : 401, reason);
			}

			if (matched?.mode === 'test') {
				try {
					await archiveDeliveredTestSubscription.call(this, matched.slot.subscriptionId as string);
				} catch (error) {
					this.logger.warn('Comers Trigger could not archive its delivered test subscription', {
						failure: error instanceof Error ? error.name : 'UnknownError',
					});
				}
			}

			return {
				workflowData: [
					[
						{
							json: {
								event: delivery.item.event as IDataObject,
								delivery: { ...delivery.item.delivery },
							},
						},
					],
				],
			};
		} catch (error) {
			// Only the kind of failure: nothing from the request or the credential.
			this.logger.error('Comers Trigger failed to handle a delivery', {
				failure: error instanceof Error ? error.name : 'UnknownError',
			});

			return refuse(500, 'internal_error');
		}
	}
}
