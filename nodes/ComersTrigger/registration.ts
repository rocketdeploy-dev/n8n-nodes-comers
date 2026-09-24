import { createHash } from 'node:crypto';

import type { IDataObject, IHookFunctions, IWebhookFunctions } from 'n8n-workflow';

import {
	comersConnection,
	comersError,
	comersRequest,
	deliveryKeysUri,
	SUBSCRIPTIONS_PATH,
	SUBSCRIPTION_SCOPE,
	type ComersConnection,
	type ComersResponse,
} from './comers-api';

/**
 * The workflow's own Comers subscription: created when the workflow is
 * published, archived when it is unpublished or deleted.
 *
 * The node's static data holds only what is needed to find and verify that
 * subscription, none of it secret:
 *
 *   schemaVersion     this layout, so a future one can be told apart
 *   production        registration slot for the published workflow
 *   test              separate registration slot for editor listening
 *
 * Each slot carries registrationId, subscriptionId, jwksUri,
 * signatureProfile and organizationId. Separate slots keep test cleanup from
 * adopting or archiving the production subscription.
 *
 * No access token, client secret or delivery key is ever stored here: n8n
 * keeps static data in plain text in its database and workflow exports.
 */

export const SIGNATURE_PROFILE = 'jws-es256-v1';
export const STATE_SCHEMA_VERSION = 2;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const EVENT_KEY = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const REASON = /^[a-z_]{1,64}$/;
const NAME_LIMIT = 120;
const LIST_PAGE_SIZE = 100;
const LIST_PAGE_LIMIT = 50;
/** Backstop for editor listeners; production registrations intentionally omit it. */
export const TEST_SUBSCRIPTION_TTL_SECONDS = 600;

export interface RegistrationState {
	schemaVersion: number;
	production?: RegistrationSlot;
	test?: RegistrationSlot;
}

export interface RegistrationSlot {
	registrationId?: string;
	subscriptionId?: string;
	jwksUri?: string;
	signatureProfile?: string;
	organizationId?: string;
}

interface Subscription {
	subscriptionId: string;
	name: string;
	targetUrl: string;
	signatureProfile: string;
	state: string;
	events: Array<{ eventKey: string; eventVersion: number }>;
}

interface Desired {
	mode: RegistrationMode;
	registrationId: string;
	name: string;
	/** Ends every name this node gives a subscription; what recovery matches on. */
	marker: string;
	targetUrl: string;
	events: Array<{ eventKey: string; eventVersion: number }>;
}

export type RegistrationMode = 'production' | 'test';

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

const asSubscription = (value: unknown): Subscription | undefined =>
	isObject(value) &&
	typeof value.subscriptionId === 'string' &&
	UUID.test(value.subscriptionId) &&
	typeof value.name === 'string' &&
	typeof value.targetUrl === 'string' &&
	typeof value.signatureProfile === 'string' &&
	typeof value.state === 'string' &&
	Array.isArray(value.events)
		? (value as unknown as Subscription)
		: undefined;

/** Why Comers refused a request, as its safe reason code if it gave one. */
const refusal = (response: ComersResponse): string => {
	const reason =
		isObject(response.body) && isObject(response.body.details)
			? response.body.details.reason
			: undefined;

	return typeof reason === 'string' && REASON.test(reason) ? ` (${reason})` : '';
};

/** The message for an answer the operation did not expect: status and safe reason only. */
const unexpected = (what: string, response: ComersResponse): string => {
	if (response.statusCode === 403) {
		return `Comers refused to ${what}: the integration needs the scope ${SUBSCRIPTION_SCOPE}.`;
	}

	if (response.statusCode === 503 || response.statusCode === 502) {
		return `Comers could not ${what} right now. Try again.`;
	}

	return `Comers refused to ${what} (HTTP ${response.statusCode})${refusal(response)}.`;
};

export function registrationState(this: IHookFunctions): RegistrationState & IDataObject {
	const state = this.getWorkflowStaticData('node') as RegistrationState & IDataObject;
	if (state.schemaVersion !== STATE_SCHEMA_VERSION) {
		const legacy = state as RegistrationSlot & IDataObject;
		if (typeof legacy.registrationId === 'string') state.production = { ...legacy };
		delete legacy.registrationId; delete legacy.subscriptionId; delete legacy.jwksUri;
		delete legacy.signatureProfile; delete legacy.organizationId;
		state.schemaVersion = STATE_SCHEMA_VERSION;
	}
	return state;
}

const slotFor = (state: RegistrationState & IDataObject, mode: RegistrationMode): RegistrationSlot & IDataObject => {
	if (!isObject(state[mode])) state[mode] = {};
	return state[mode] as RegistrationSlot & IDataObject;
};

const clearSubscription = (state: RegistrationState & IDataObject, mode: RegistrationMode): void => {
	delete state[mode];
};

/** How this node's subscription is recognised: its registration marker and production URL. */
type Identity = Pick<Desired, 'registrationId' | 'marker' | 'targetUrl'>;

export function registrationIdentity(this: IHookFunctions, mode: RegistrationMode = this.getMode() === 'manual' ? 'test' : 'production'): Identity {
	const workflow = this.getWorkflow();
	const node = this.getNode();
	// Stable for this workflow and node across activations and restarts, and
	// different for a copied workflow, so a lost create can be found again.
	const registrationId = createHash('sha256')
		.update(`${workflow.id ?? ''}\u0000${node.id}\u0000${mode}`)
		.digest('hex')
		.slice(0, 20);
	const targetUrl = this.getNodeWebhookUrl('default');

	if (targetUrl === undefined) {
		throw comersError(this, `n8n did not provide a ${mode} webhook URL for this node.`);
	}

	return { registrationId, marker: ` [n8n ${mode} ${registrationId}]`, targetUrl };
}

/** What the subscription should look like, from the node's parameters. */
export function desiredSubscription(this: IHookFunctions): Desired {
	const workflow = this.getWorkflow();
	const node = this.getNode();
	const mode: RegistrationMode = this.getMode() === 'manual' ? 'test' : 'production';
	const { registrationId, marker, targetUrl } = registrationIdentity.call(this, mode);
	const label =
		String(this.getNodeParameter('subscriptionName', '') ?? '').trim() ||
		`${workflow.name ?? 'n8n workflow'} / ${node.name}`;

	const selected = this.getNodeParameter('events', {}) as {
		event?: Array<{ event?: unknown }>;
	};
	const events: Desired['events'] = [];
	const seen = new Set<string>();

	for (const entry of selected.event ?? []) {
		const choice = decodeEventChoice(entry.event);
		if (choice === undefined) throw comersError(this, 'Choose an event from the current Comers catalog.');
		const { eventKey, eventVersion } = choice;

		const key = `${eventKey}@${eventVersion}`;

		if (!seen.has(key)) {
			seen.add(key);
			events.push({ eventKey, eventVersion });
		}
	}

	if (events.length === 0) {
		throw comersError(this, 'Add at least one event for Comers to deliver.');
	}

	return {
		mode,
		registrationId,
		marker,
		name: `${label.slice(0, NAME_LIMIT - marker.length)}${marker}`,
		targetUrl,
		events,
	};
}

/** Stable n8n option value; versions are part of the identity, never inferred. */
export const decodeEventChoice = (value: unknown): { eventKey: string; eventVersion: number } | undefined => {
	if (typeof value !== 'string') return undefined;
	const match = /^(.+)@(\d+)$/.exec(value);
	if (match === null) return undefined;
	const eventVersion = Number(match[2]);
	return EVENT_KEY.test(match[1]) && Number.isSafeInteger(eventVersion) && eventVersion > 0 ? { eventKey: match[1], eventVersion } : undefined;
};

const sameEvents = (left: Desired['events'], right: Desired['events']): boolean => {
	const key = (events: Desired['events']) =>
		events
			.map((event) => `${event.eventKey}@${event.eventVersion}`)
			.sort()
			.join();

	return key(left) === key(right);
};

/**
 * Finds this node's subscription among the integration's own: not archived,
 * JWS, the exact target URL, and a name ending in this registration's marker.
 * Anything short of exactly one such subscription is never guessed at.
 */
async function findOwn(
	this: IHookFunctions,
	connection: ComersConnection,
	desired: Identity,
): Promise<Subscription | undefined> {
	const matches: Subscription[] = [];
	let cursor: string | null = null;
	let complete = false;

	for (let page = 0; page < LIST_PAGE_LIMIT; page += 1) {
		const query: string = `?limit=${LIST_PAGE_SIZE}${cursor === null ? '' : `&cursor=${cursor}`}`;
		const response: ComersResponse = await comersRequest.call(
			this,
			connection,
			'GET',
			`${SUBSCRIPTIONS_PATH}${query}`,
		);

		if (
			response.statusCode !== 200 ||
			!isObject(response.body) ||
			!Array.isArray(response.body.items)
		) {
			throw comersError(this, unexpected('list this integration’s subscriptions', response));
		}

		for (const item of response.body.items) {
			const subscription = asSubscription(item);

			if (
				subscription !== undefined &&
				subscription.state !== 'archived' &&
				subscription.signatureProfile === SIGNATURE_PROFILE &&
				subscription.targetUrl === desired.targetUrl &&
				subscription.name.endsWith(desired.marker)
			) {
				matches.push(subscription);
			}
		}

		const next: unknown = response.body.nextCursor;

		if (next === null || next === undefined) {
			complete = true;
			break;
		}
		if (typeof next !== 'string' || !UUID.test(next)) {
			throw comersError(this, 'Comers answered the subscription list with an invalid cursor.');
		}
		cursor = next;
	}

	// A list not read to its end cannot say "not found": that answer would
	// create a duplicate of a subscription on a page never read.
	if (!complete) {
		throw comersError(
			this,
			`This integration has more than ${LIST_PAGE_LIMIT * LIST_PAGE_SIZE} subscriptions, so this node cannot tell whether it already has one. Archive unused subscriptions in Comers, then try again.`,
		);
	}

	if (matches.length > 1) {
		throw comersError(
			this,
			`Comers has ${matches.length} subscriptions for this workflow node (${matches
				.map((match) => match.subscriptionId)
				.join(', ')}). Archive the extra ones in Comers, then activate the workflow again.`,
		);
	}

	return matches[0];
}

/** The integration behind the credential, and its scope. */
async function integration(
	this: IHookFunctions,
	connection: ComersConnection,
): Promise<{ organizationId: string }> {
	const response = await comersRequest.call(
		this,
		connection,
		'GET',
		'/core/api/v1/integrations/me',
	);

	if (
		response.statusCode !== 200 ||
		!isObject(response.body) ||
		typeof response.body.organizationId !== 'string' ||
		!Array.isArray(response.body.scopes)
	) {
		throw comersError(this, unexpected('identify this integration', response));
	}

	if (!response.body.scopes.includes(SUBSCRIPTION_SCOPE)) {
		throw comersError(this, `The Comers integration is missing the scope ${SUBSCRIPTION_SCOPE}.`);
	}

	return { organizationId: response.body.organizationId };
}

/** Brings an existing subscription's name and events in line with the node. */
async function reconcile(
	this: IHookFunctions,
	connection: ComersConnection,
	subscription: Subscription,
	desired: Desired,
): Promise<void> {
	if (subscription.name === desired.name && sameEvents(subscription.events, desired.events)) return;

	const response = await comersRequest.call(
		this,
		connection,
		'PATCH',
		`${SUBSCRIPTIONS_PATH}/${subscription.subscriptionId}`,
		{ name: desired.name, events: desired.events },
	);

	if (response.statusCode !== 200) {
		throw comersError(this, unexpected('update the subscription', response));
	}
}

async function adopt(
	this: IHookFunctions,
	connection: ComersConnection,
	state: RegistrationState & IDataObject,
	subscription: Subscription,
	desired: Desired,
): Promise<void> {
	const { organizationId } = await integration.call(this, connection);

	await reconcile.call(this, connection, subscription, desired);
	const slot = slotFor(state, desired.mode);
	slot.registrationId = desired.registrationId;
	slot.subscriptionId = subscription.subscriptionId;
	slot.jwksUri = deliveryKeysUri(connection.origin);
	slot.signatureProfile = SIGNATURE_PROFILE;
	slot.organizationId = organizationId;
}

async function archive(
	this: IHookFunctions,
	connection: ComersConnection,
	subscriptionId: string,
): Promise<void> {
	const response = await comersRequest.call(
		this,
		connection,
		'DELETE',
		`${SUBSCRIPTIONS_PATH}/${subscriptionId}`,
	);

	// 404: already gone, or never this integration's — either way nothing to do.
	if (response.statusCode !== 204 && response.statusCode !== 404) {
		throw comersError(this, unexpected('archive the subscription', response));
	}
}

/**
 * Whether this node's subscription exists. `false` only when Comers has
 * certainly none for it; an error is never taken for "does not exist",
 * because that would create a duplicate.
 */
export async function checkExists(this: IHookFunctions): Promise<boolean> {
	const state = registrationState.call(this);
	const connection = await comersConnection.call(this);
	const desired = desiredSubscription.call(this);
	const slot = slotFor(state, desired.mode);

	if (typeof slot.subscriptionId === 'string') {
		const response = await comersRequest.call(
			this,
			connection,
			'GET',
			`${SUBSCRIPTIONS_PATH}/${slot.subscriptionId}`,
		);

		if (response.statusCode === 200) {
			const subscription = asSubscription(response.body);

			if (subscription === undefined) {
				throw comersError(this, 'Comers answered with a subscription this node cannot read.');
			}

			if (subscription.state !== 'archived' && subscription.targetUrl === desired.targetUrl) {
				await adopt.call(this, connection, state, subscription, desired);
				return true;
			}

			// Archived, or pointing at a URL this workflow no longer serves: it is
			// ours, so it is retired rather than left delivering elsewhere.
			if (subscription.state !== 'archived') {
				await archive.call(this, connection, subscription.subscriptionId);
			}
			clearSubscription(state, desired.mode);
		} else if (response.statusCode === 404) {
			clearSubscription(state, desired.mode);
		} else {
			throw comersError(this, unexpected('read the subscription', response));
		}
	}

	// No usable ID: a create whose answer was lost may still have succeeded.
	const found = await findOwn.call(this, connection, desired);

	if (found !== undefined) {
		await adopt.call(this, connection, state, found, desired);
		return true;
	}

	return false;
}

export async function createSubscription(this: IHookFunctions): Promise<boolean> {
	const state = registrationState.call(this);
	const connection = await comersConnection.call(this);
	const desired = desiredSubscription.call(this);
	const { organizationId } = await integration.call(this, connection);
	const expectedKeys = deliveryKeysUri(connection.origin);

	const response = await comersRequest.call(this, connection, 'POST', SUBSCRIPTIONS_PATH, {
		signatureProfile: SIGNATURE_PROFILE,
		name: desired.name,
		targetUrl: desired.targetUrl,
		events: desired.events,
		...(desired.mode === 'test' ? { expiresInSeconds: TEST_SUBSCRIPTION_TTL_SECONDS } : {}),
	});

	if (response.statusCode !== 201 || !isObject(response.body)) {
		throw comersError(this, unexpected('create the subscription', response));
	}

	const subscription = asSubscription(response.body.subscription);
	const verification = response.body.verification;

	if (
		response.body.signatureProfile !== SIGNATURE_PROFILE ||
		'signingSecret' in response.body ||
		subscription === undefined ||
		subscription.signatureProfile !== SIGNATURE_PROFILE ||
		!isObject(verification) ||
		verification.jwksUri !== expectedKeys ||
		verification.algorithm !== 'ES256' ||
		verification.type !== 'comers-delivery+jws'
	) {
		// Created, but not as this node can verify: retire it rather than keep a
		// subscription whose deliveries would all be refused.
		if (subscription !== undefined) {
			await archive.call(this, connection, subscription.subscriptionId);
		}
		throw comersError(
			this,
			'Comers answered the subscription request with an unexpected contract.',
		);
	}

	const slot = slotFor(state, desired.mode);
	slot.registrationId = desired.registrationId;
	slot.subscriptionId = subscription.subscriptionId;
	slot.jwksUri = expectedKeys;
	slot.signatureProfile = SIGNATURE_PROFILE;
	slot.organizationId = organizationId;

	return true;
}

/**
 * Best-effort cleanup after a verified test delivery. n8n does not guarantee
 * webhookMethods.delete for editor listeners, so failure is deliberately not
 * made visible to the execution; the server-side TTL remains authoritative.
 */
export async function archiveDeliveredTestSubscription(
	this: IWebhookFunctions,
	subscriptionId: string,
): Promise<void> {
	const connection = await comersConnection.call(this);
	const response = await comersRequest.call(
		this,
		connection,
		'DELETE',
		`${SUBSCRIPTIONS_PATH}/${subscriptionId}`,
	);
	if (response.statusCode !== 204 && response.statusCode !== 404) {
		throw comersError(this, unexpected('archive the test subscription', response));
	}
}

/**
 * Archives exactly the subscription this node recorded. The state is cleared
 * only once Comers confirms (204) or no longer knows it (404); any other
 * answer keeps it, so n8n can retry the cleanup.
 *
 * With no recorded ID, a create whose answer was lost may still have left a
 * subscription in Comers. The same recovery as `checkExists` finds it: none is
 * success, exactly one is archived, more than one or an API error fails and
 * keeps the state.
 */
export async function deleteSubscription(this: IHookFunctions): Promise<boolean> {
	const state = registrationState.call(this);
	const connection = await comersConnection.call(this);
	const mode: RegistrationMode = this.getMode() === 'manual' ? 'test' : 'production';
	const slot = slotFor(state, mode);

	if (typeof slot.subscriptionId === 'string') {
		await archive.call(this, connection, slot.subscriptionId);
	} else {
		const orphan = await findOwn.call(this, connection, registrationIdentity.call(this, mode));

		if (orphan !== undefined) {
			await archive.call(this, connection, orphan.subscriptionId);
		}
	}

	clearSubscription(state, mode);

	return true;
}
