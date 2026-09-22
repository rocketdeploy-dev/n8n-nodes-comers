import type {
	IDataObject,
	IHookFunctions,
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
	SIGNATURE_PROFILE,
	type RegistrationState,
} from './registration';

/** Public delivery keys, shared by every Comers Trigger in this process. */
export const deliveryKeys = new DeliveryKeyCache();

/** Test listening in the editor has no production URL and registers nothing. */
const isTestListening = (context: IHookFunctions): boolean => context.getMode() === 'manual';

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
								displayName: 'Event Key',
								name: 'eventKey',
								type: 'string',
								default: '',
								required: true,
								placeholder: 'comers.core.orders.order.created',
								description: 'The event key, as listed in the Comers event catalog',
							},
							{
								displayName: 'Event Version',
								name: 'eventVersion',
								type: 'number',
								typeOptions: { minValue: 1, numberPrecision: 0 },
								default: 1,
								description: 'The version of the event’s payload',
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
				if (isTestListening(this)) return true;

				return checkExists.call(this);
			},
			async create(this: IHookFunctions): Promise<boolean> {
				if (isTestListening(this)) return true;

				return createSubscription.call(this);
			},
			async delete(this: IHookFunctions): Promise<boolean> {
				if (isTestListening(this)) return true;

				return deleteSubscription.call(this);
			},
		},
	};

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

			// Only a published, registered node receives deliveries, and only with
			// keys from the Comers the credential names.
			if (
				typeof state.subscriptionId !== 'string' ||
				state.signatureProfile !== SIGNATURE_PROFILE ||
				state.jwksUri !== deliveryKeysUri(connection.origin)
			) {
				return refuse(401, 'not_registered');
			}

			const request = this.getRequestObject();

			if (request.rawBody === undefined) {
				await request.readRawBody();
			}

			const verified = await verifiedPayload.call(this, state.jwksUri, request.rawBody);

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

			const delivery = readDelivery({
				payload: verified.payload,
				subscriptionId: state.subscriptionId,
				organizationId: typeof state.organizationId === 'string' ? state.organizationId : undefined,
				nowSeconds: Math.floor(Date.now() / 1000),
			});

			if (!delivery.ok) {
				this.logger.warn('Comers Trigger refused a delivery', { reason: delivery.reason });

				return refuse(delivery.reason === 'malformed_envelope' ? 400 : 401, delivery.reason);
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
