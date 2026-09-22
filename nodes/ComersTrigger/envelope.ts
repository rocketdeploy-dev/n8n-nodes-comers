/**
 * The Comers delivery payload inside a verified `jws-es256-v1` delivery, and
 * the one item it becomes.
 *
 * This runs only after the signature has been verified with a key Comers
 * publishes, so everything here is signed: the event, the organization it
 * belongs to, and the binding to one subscription, delivery, attempt and time.
 *
 * The event envelope is validated, never rewritten. Fields Comers adds later
 * flow through untouched, and neither the event key nor the domain payload
 * under `data` is checked against a list, so a new event type — or a new field
 * on an existing one — needs no release of this node.
 */

/** The only envelope version this node understands. */
export const SPEC_VERSION = 'comers.v1';

/** How far a delivery's signed timestamp may be from this clock. */
export const TIMESTAMP_TOLERANCE_SECONDS = 300;

export type PayloadFailure =
	| 'payload_shape'
	| 'unsupported_spec_version'
	| 'malformed_envelope'
	| 'malformed_delivery'
	| 'other_subscription'
	| 'other_organization'
	| 'stale_timestamp';

/** How this delivery reached the workflow. All of it is covered by the signature. */
export interface DeliveryMetadata {
	/** The subscription this delivery was signed for; always this workflow's own. */
	subscriptionId: string;
	/** This delivery's identity, for matching against the Comers delivery log. */
	deliveryId: string;
	/**
	 * Which attempt this is within its run, counting from 1. A replayed dead
	 * letter starts again at 1, so this is not unique: deduplicate on
	 * `event.eventId`.
	 */
	deliveryAttempt: number;
	/** When this attempt was signed, in whole seconds since the epoch. */
	timestamp: number;
}

/** The one item a verified delivery becomes. */
export interface DeliveryItem {
	/** The Comers event envelope, exactly as signed. */
	event: Record<string, unknown>;
	/** How this delivery reached the workflow. */
	delivery: DeliveryMetadata;
}

export type DeliveryResult =
	| { ok: true; item: DeliveryItem }
	| { ok: false; reason: PayloadFailure };

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
	typeof value === 'string' && value.length > 0;

const isNullableString = (value: unknown): value is string | null =>
	value === null || typeof value === 'string';

/** Present as a key, and either a string or an explicit null. */
const isOptionalScopeId = (scope: Record<string, unknown>, key: string): boolean =>
	key in scope && isNullableString(scope[key]);

/** A bigint rendered as decimal digits, because JSON numbers lose precision past 2^53-1. */
const DECIMAL_STRING = /^[0-9]+$/;

export const isValidEnvelope = (envelope: Record<string, unknown>): boolean => {
	if (
		!isNonEmptyString(envelope.eventId) ||
		!isNonEmptyString(envelope.eventKey) ||
		!isNonEmptyString(envelope.producer) ||
		!isNonEmptyString(envelope.occurredAt) ||
		!isNonEmptyString(envelope.sequence)
	) {
		return false;
	}

	// Versions start at 1 and count up. Zero or a negative would mean the
	// producer is sending something this contract has no meaning for.
	if (!Number.isSafeInteger(envelope.eventVersion) || (envelope.eventVersion as number) < 1) {
		return false;
	}

	if (!DECIMAL_STRING.test(envelope.sequence)) {
		return false;
	}

	if (Number.isNaN(Date.parse(envelope.occurredAt))) {
		return false;
	}

	// Every event belongs to an organization. A seller and a store narrow it
	// further when the subscription is scoped that way, and are explicitly null
	// when it is not — so the keys are always there, and their absence would
	// mean something other than "organization-wide".
	if (
		!isObject(envelope.scope) ||
		!isNonEmptyString(envelope.scope.organizationId) ||
		!isOptionalScopeId(envelope.scope, 'sellerId') ||
		!isOptionalScopeId(envelope.scope, 'sellerStoreId')
	) {
		return false;
	}

	// What the event is about. The id is whatever the producing service calls
	// the thing — often a UUID, but the contract does not say so, and a node
	// that insisted on one would reject events it has no business judging.
	if (
		!isObject(envelope.subject) ||
		!isNonEmptyString(envelope.subject.type) ||
		!isNonEmptyString(envelope.subject.id)
	) {
		return false;
	}

	if (!('correlationId' in envelope) || !isNullableString(envelope.correlationId)) {
		return false;
	}

	// The domain payload is carried, not inspected. It only has to be there.
	return 'data' in envelope;
};

const DELIVERY_KEYS = 'deliveryAttempt,deliveryId,subscriptionId,timestamp';

/**
 * Turns the verified payload into the item the workflow receives, after
 * checking that it was signed for this workflow's subscription (and, when the
 * node knows it, organization) and that it is recent.
 */
export const readDelivery = ({
	payload,
	subscriptionId,
	organizationId,
	nowSeconds,
}: {
	payload: unknown;
	subscriptionId: string;
	organizationId?: string;
	nowSeconds: number;
}): DeliveryResult => {
	if (!isObject(payload) || Object.keys(payload).sort().join() !== 'delivery,event') {
		return { ok: false, reason: 'payload_shape' };
	}

	const { event, delivery } = payload;

	if (
		!isObject(delivery) ||
		Object.keys(delivery).sort().join() !== DELIVERY_KEYS ||
		!isNonEmptyString(delivery.subscriptionId) ||
		!isNonEmptyString(delivery.deliveryId) ||
		!Number.isSafeInteger(delivery.deliveryAttempt) ||
		(delivery.deliveryAttempt as number) < 1 ||
		!Number.isSafeInteger(delivery.timestamp) ||
		(delivery.timestamp as number) < 1
	) {
		return { ok: false, reason: 'malformed_delivery' };
	}

	// Signed for a subscription, so it is refused anywhere else: a delivery
	// captured from one workflow cannot be replayed into another.
	if (delivery.subscriptionId !== subscriptionId) {
		return { ok: false, reason: 'other_subscription' };
	}

	if (Math.abs(nowSeconds - (delivery.timestamp as number)) > TIMESTAMP_TOLERANCE_SECONDS) {
		return { ok: false, reason: 'stale_timestamp' };
	}

	if (!isObject(event)) {
		return { ok: false, reason: 'malformed_envelope' };
	}

	if (event.specVersion !== SPEC_VERSION) {
		return { ok: false, reason: 'unsupported_spec_version' };
	}

	if (!isValidEnvelope(event)) {
		return { ok: false, reason: 'malformed_envelope' };
	}

	if (
		organizationId !== undefined &&
		(event.scope as Record<string, unknown>).organizationId !== organizationId
	) {
		return { ok: false, reason: 'other_organization' };
	}

	return {
		ok: true,
		item: {
			event,
			delivery: {
				subscriptionId: delivery.subscriptionId,
				deliveryId: delivery.deliveryId,
				deliveryAttempt: delivery.deliveryAttempt as number,
				timestamp: delivery.timestamp as number,
			},
		},
	};
};
