import type {
	ICredentialsDecrypted,
	ICredentialTestFunctions,
	IDataObject,
	IHookFunctions,
	INodeCredentialTestResult,
	INodeType,
	INodeTypeDescription,
	IWebhookFunctions,
	IWebhookResponseData,
} from 'n8n-workflow';
import { NodeConnectionTypes } from 'n8n-workflow';

import { readDelivery } from './envelope';
import { authenticateDelivery, TIMESTAMP_TOLERANCE_SECONDS } from './signature';

/**
 * The secret Comers issues is 32 random bytes in base64url, so 43 characters
 * from that alphabet and no padding. Checked locally and only for shape: this
 * node has no way to ask Comers whether a secret is the right one, and does
 * not pretend otherwise.
 */
const SIGNING_SECRET_SHAPE = /^[A-Za-z0-9_-]{43}$/;

export class ComersTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Comers Trigger',
		name: 'comersTrigger',
		icon: { light: 'file:comers.svg', dark: 'file:comers.dark.svg' },
		group: ['trigger'],
		version: 1,
		subtitle: 'Signed webhook deliveries',
		description: 'Starts the workflow when Comers delivers a signed domain event',
		eventTriggerDescription: 'Waiting for Comers to deliver an event',
		activationMessage: 'Comers can now deliver events to your production webhook URL.',
		defaults: { name: 'Comers Trigger' },
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'comersWebhookSecretApi',
				required: true,
				testedBy: 'comersSigningSecretShape',
			},
		],
		webhooks: [
			{
				name: 'default',
				httpMethod: 'POST',
				responseMode: 'onReceived',
				// Comers ignores the body of a successful delivery, and echoing
				// the event back to the sender would put the payload somewhere
				// it does not need to be.
				responseData: 'noData',
				path: 'webhook',
			},
		],
		triggerPanel: {
			header: '',
			executionsHelp: {
				inactive:
					'This trigger has two URLs. <b>While you build the workflow</b>, click "Listen for test event" and point a Comers subscription at the test URL — those executions appear in the editor. <b>Once the workflow is published</b>, Comers delivers to the production URL and those executions appear in the executions list.',
				active:
					'This trigger has two URLs. The workflow is published, so Comers delivers to the production URL and those executions appear in the <a data-key="executions">executions list</a>. Click "Listen for test event" to receive a delivery in the editor instead.',
			},
			activationHint:
				'Create the subscription in Comers Business Settings with this workflow\'s production URL, and paste the secret Comers shows once into the credential.',
		},
		properties: [
			{
				displayName:
					'Create the webhook subscription yourself in Comers Business Settings, using this node\'s webhook URL, then paste the secret Comers shows once into the credential above. This node only receives deliveries — it never creates, changes or removes a subscription.',
				name: 'manualSetupNotice',
				type: 'notice',
				default: '',
			},
		],
	};

	/**
	 * n8n requires a webhook trigger to declare the full registration lifecycle,
	 * so that a node which registers itself with a third-party service can also
	 * check and clean up after itself.
	 *
	 * This node registers nothing. The Comers subscription is created, paused
	 * and removed by a person in Comers Business Settings, and this node holds
	 * only a signing secret — it has no credential that would let it call the
	 * Comers API at all. So all three hooks are honest no-ops, and none of them
	 * performs any I/O.
	 *
	 * Two consequences worth knowing:
	 *
	 *  - `checkExists` answers "yes" so n8n never calls `create`. There is
	 *    nothing to create, and claiming otherwise would be a lie that
	 *    eventually turns into a failed activation.
	 *  - `delete` does nothing, so deactivating or deleting the workflow does
	 *    NOT suspend the subscription in Comers. Comers keeps delivering, gets
	 *    404s, and eventually suspends the subscription itself. Suspend it in
	 *    Business Settings first if you mean to stop.
	 */
	webhookMethods = {
		default: {
			async checkExists(this: IHookFunctions): Promise<boolean> {
				return true;
			},
			async create(this: IHookFunctions): Promise<boolean> {
				return true;
			},
			async delete(this: IHookFunctions): Promise<boolean> {
				return true;
			},
		},
	};

	methods = {
		credentialTest: {
			async comersSigningSecretShape(
				this: ICredentialTestFunctions,
				credential: ICredentialsDecrypted,
			): Promise<INodeCredentialTestResult> {
				const secret = credential.data?.signingSecret;

				if (typeof secret !== 'string' || secret.length === 0) {
					return { status: 'Error', message: 'Enter the signing secret Comers showed you.' };
				}

				if (secret !== secret.trim()) {
					return {
						status: 'Error',
						message: 'The signing secret has leading or trailing whitespace. Paste it again without it.',
					};
				}

				if (!SIGNING_SECRET_SHAPE.test(secret)) {
					return {
						status: 'Error',
						message:
							'This does not look like a Comers signing secret. Comers issues 43 characters of base64url. Copy the whole value Comers showed when the subscription was created or its secret was rotated.',
					};
				}

				// Only the shape was checked. Whether this secret belongs to the
				// subscription that delivers here shows up on the first delivery.
				return { status: 'OK', message: 'The secret has the shape Comers issues.' };
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

			// No workflowData, so the workflow does not run at all.
			return { noWebhookResponse: true };
		};

		try {
			const request = this.getRequestObject();

			// n8n has usually read the body already; this is idempotent and makes
			// the node independent of whether it did.
			if (request.rawBody === undefined) {
				await request.readRawBody();
			}

			const { signingSecret } = await this.getCredentials<{ signingSecret: string }>(
				'comersWebhookSecretApi',
			);

			const authentication = authenticateDelivery({
				method: request.method,
				headers: this.getHeaderData(),
				rawBody: request.rawBody,
				secret: signingSecret,
				nowSeconds: Math.floor(Date.now() / 1000),
			});

			if (!authentication.authenticated) {
				this.logger.warn('Comers Trigger refused a delivery', {
					reason: authentication.reason,
					toleranceSeconds: TIMESTAMP_TOLERANCE_SECONDS,
				});

				return refuse(401, authentication.reason);
			}

			// Only now, with the bytes proven to be Comers', is anything parsed.
			const delivery = readDelivery({
				headers: this.getHeaderData(),
				rawBody: request.rawBody,
				timestamp: authentication.timestamp,
			});

			if (!delivery.ok) {
				this.logger.warn('Comers Trigger received a delivery it could not read', {
					reason: delivery.reason,
				});

				return refuse(400, delivery.reason);
			}

			return {
				workflowData: [
					[
						{
							json: {
								// The envelope came out of JSON.parse, so it can only hold
								// JSON values — which is what IDataObject describes.
								// TypeScript cannot see that through `unknown`, and giving
								// the envelope reader an n8n type would tie it to n8n for
								// no gain.
								event: delivery.item.event as IDataObject,
								delivery: { ...delivery.item.delivery },
							},
						},
					],
				],
			};
		} catch (error) {
			// Nothing from the request or the credential reaches the log or the
			// reply: only the kind of failure, which is enough to tell a missing
			// credential from a broken body reader.
			this.logger.error('Comers Trigger failed to handle a delivery', {
				failure: error instanceof Error ? error.name : 'UnknownError',
			});

			return refuse(500, 'internal_error');
		}
	}
}
