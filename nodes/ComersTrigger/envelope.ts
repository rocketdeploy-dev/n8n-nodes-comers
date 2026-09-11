/**
 * The Core Events delivery envelope, and the one item a verified delivery
 * becomes.
 *
 * This runs only after `authenticateDelivery` has proved the bytes are
 * genuine, so anything wrong from here on is a contract fault by a sender that
 * holds the right secret — not an intruder.
 *
 * The signature covers `v1:<timestamp>:<raw body>`. The delivery headers are
 * outside it; they are checked against the authenticated body instead, which
 * is what stops one being changed in flight without the other.
 *
 * The envelope is validated, never rewritten. Fields Core Events adds later
 * flow through untouched, and the domain payload under `data` is not inspected
 * at all, so a new event type or a new field on an existing one does not need
 * a release of this node.
 */

/** The only envelope version this node understands. */
export const SPEC_VERSION = 'comers.v1';

export type EnvelopeFailure =
	| 'unsupported_content_type'
	| 'missing_delivery_headers'
	| 'malformed_delivery_headers'
	| 'body_not_json'
	| 'body_not_an_object'
	| 'unsupported_spec_version'
	| 'malformed_envelope'
	| 'headers_contradict_envelope';

/**
 * How this delivery reached the workflow.
 *
 * These are transport facts, read from the request headers. Only `timestamp`
 * is covered by the signature — it is part of the signed string. The other
 * three appear nowhere in the body, so the HMAC does not bind them: they are
 * protected by the HTTPS connection, not by the application-level signature.
 *
 * Treat them as routing and bookkeeping, never as evidence. What makes the
 * domain fact authentic is the signed body together with its signed timestamp.
 */
export interface DeliveryMetadata {
	/** Which subscription this delivery belongs to. Not covered by the signature. */
	subscriptionId: string;
	/** This delivery's identity, for matching against the Comers delivery log. Not covered by the signature. */
	deliveryId: string;
	/**
	 * Which attempt this is **within its run**, counting from 1: Core Events
	 * raises the counter as it claims the delivery, so the first request already
	 * says 1 and each automatic retry says 2, 3 and so on.
	 *
	 * Replaying a dead letter starts a new run — the run counter goes up and the
	 * attempt counter goes back to zero — so the next request is numbered 1
	 * again. The run itself is not sent to the receiver, which means this number
	 * is not unique across a delivery's life and cannot be used to tell a fresh
	 * event from a repeat. Deduplicate on the event id instead.
	 *
	 * Not covered by the signature.
	 */
	deliveryAttempt: number;
	/** The timestamp from the signed string, in whole seconds since the epoch. */
	timestamp: number;
}

/** The one item a verified delivery becomes. */
export interface DeliveryItem {
	/** The Comers envelope, as the authenticated bytes decoded. */
	event: Record<string, unknown>;
	/** How this delivery reached the workflow. */
	delivery: DeliveryMetadata;
}

export type DeliveryResult =
	| { ok: true; item: DeliveryItem }
	| { ok: false; reason: EnvelopeFailure };

const readHeader = (
	headers: Record<string, string | string[] | undefined>,
	name: string,
): string | undefined => {
	const wanted = name.toLowerCase();

	for (const [key, value] of Object.entries(headers)) {
		// A repeated header arrives as an array, which leaves the intended
		// value ambiguous. None of these headers may legitimately repeat.
		if (key.toLowerCase() === wanted) {
			return typeof value === 'string' ? value : undefined;
		}
	}

	return undefined;
};

const STRICT_INTEGER = /^(?:0|[1-9][0-9]*)$/;

/**
 * A header that must be a whole number at or above `atLeast`.
 *
 * Surrounding whitespace is tolerated on purpose: optional whitespace around a
 * header value is part of HTTP, and an intermediary may add or normalise it
 * before the request reaches here. Refusing it would be refusing a delivery for
 * something the sender did not do.
 *
 * Everything else is refused — whitespace *inside* the number, a leading sign,
 * a decimal point, an exponent, hexadecimal, and anything outside the safe
 * integer range, where `Number` would silently round to a value the dispatcher
 * never sent.
 */
const parseCounter = (value: string | undefined, atLeast: number): number | null => {
	if (value === undefined || !STRICT_INTEGER.test(value.trim())) {
		return null;
	}

	const parsed = Number(value.trim());

	return Number.isSafeInteger(parsed) && parsed >= atLeast ? parsed : null;
};

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

const isValidEnvelope = (envelope: Record<string, unknown>): boolean => {
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

/**
 * Turns an authenticated delivery into the single item the workflow receives.
 *
 * The item has exactly two keys:
 *
 *   `event`    exactly the value `JSON.parse` returned for the authenticated
 *              bytes — no field renamed, removed, added or overwritten. The
 *              bytes themselves were verified byte for byte; this is the value
 *              they decode to, and re-serialising it would not necessarily
 *              reproduce them. Nothing here promises that it would.
 *   `delivery` transport facts, which live in headers rather than in the
 *              envelope, plus the timestamp that was verified.
 *
 * Keeping them apart is what makes the forward-compatibility promise real. If
 * the two were merged, a field Core Events adds to the envelope one day could
 * collide with a transport field and be silently shadowed — and `delivery` is
 * exactly the name that collision would land on.
 */
export const readDelivery = ({
	headers,
	rawBody,
	timestamp,
}: {
	headers: Record<string, string | string[] | undefined>;
	rawBody: Buffer;
	timestamp: number;
}): DeliveryResult => {
	const contentType = readHeader(headers, 'content-type');

	if (contentType === undefined || !contentType.startsWith('application/json')) {
		return { ok: false, reason: 'unsupported_content_type' };
	}

	const eventId = readHeader(headers, 'x-comers-event-id');
	const eventKey = readHeader(headers, 'x-comers-event-key');
	const subscriptionId = readHeader(headers, 'x-comers-subscription-id');
	const deliveryId = readHeader(headers, 'x-comers-delivery-id');
	const rawEventVersion = readHeader(headers, 'x-comers-event-version');
	const rawAttempt = readHeader(headers, 'x-comers-delivery-attempt');

	if (
		!isNonEmptyString(eventId) ||
		!isNonEmptyString(eventKey) ||
		!isNonEmptyString(subscriptionId) ||
		!isNonEmptyString(deliveryId) ||
		rawEventVersion === undefined ||
		rawAttempt === undefined
	) {
		return { ok: false, reason: 'missing_delivery_headers' };
	}

	const eventVersion = parseCounter(rawEventVersion, 1);
	// Core Events raises the attempt counter as it claims the delivery, so the
	// very first request already carries 1. A 0 is a transport state the real
	// dispatcher never emits, and accepting it would mean accepting a delivery
	// nothing on the other side could have produced.
	const deliveryAttempt = parseCounter(rawAttempt, 1);

	if (eventVersion === null || deliveryAttempt === null) {
		return { ok: false, reason: 'malformed_delivery_headers' };
	}

	let parsed: unknown;

	try {
		parsed = JSON.parse(rawBody.toString('utf8'));
	} catch {
		return { ok: false, reason: 'body_not_json' };
	}

	if (!isObject(parsed)) {
		return { ok: false, reason: 'body_not_an_object' };
	}

	if (parsed.specVersion !== SPEC_VERSION) {
		return { ok: false, reason: 'unsupported_spec_version' };
	}

	if (!isValidEnvelope(parsed)) {
		return { ok: false, reason: 'malformed_envelope' };
	}

	// The routing headers are NOT in the signed material: the HMAC covers
	// `v1:<timestamp>:<raw body>` and nothing else. What binds them is this
	// comparison — the body is authenticated, and a header that disagrees with
	// the authenticated body gets the delivery refused. So a header changed in
	// flight cannot steer a workflow onto an event the body does not describe,
	// even though the header itself carries no signature of its own.
	if (
		parsed.eventId !== eventId ||
		parsed.eventKey !== eventKey ||
		parsed.eventVersion !== eventVersion
	) {
		return { ok: false, reason: 'headers_contradict_envelope' };
	}

	const delivery: DeliveryMetadata = {
		subscriptionId,
		deliveryId,
		deliveryAttempt,
		timestamp,
	};

	return { ok: true, item: { event: parsed, delivery } };
};
