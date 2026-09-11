import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Authentication of a Core Events webhook delivery.
 *
 * Core Events signs the exact bytes it puts on the wire:
 *
 *   HMAC-SHA256(secret, "v1:<timestamp>:<raw body bytes>")
 *
 * base64-encoded and offered in `X-Comers-Signature` as `v1=<signature>`,
 * comma-separated when more than one is offered. The timestamp is inside the
 * signed string rather than beside it, so a captured body cannot be replayed
 * later under a fresh timestamp.
 *
 * Nothing here knows about n8n. The delivery arrives as bytes, headers and a
 * secret, which keeps the rule that decides whether a request is genuine
 * testable on its own and independent of where the secret came from.
 */

/** The only signature scheme this node understands. */
export const SIGNATURE_SCHEME = 'v1';

/**
 * How far a delivery's timestamp may sit from the receiver's clock. Fixed
 * rather than configurable: a window a user can widen is a replay window a
 * user can widen.
 */
export const TIMESTAMP_TOLERANCE_SECONDS = 300;

export type AuthenticationFailure =
	| 'method_not_allowed'
	| 'missing_timestamp'
	| 'malformed_timestamp'
	| 'timestamp_outside_window'
	| 'missing_signature'
	| 'malformed_signature'
	| 'unsupported_signature_version'
	| 'signature_mismatch';

export type AuthenticationResult =
	| { authenticated: true; timestamp: number }
	| { authenticated: false; reason: AuthenticationFailure };

export interface DeliveryAuthentication {
	/** The HTTP method the request arrived with. */
	method: string;
	/** Request headers, in any casing. */
	headers: Record<string, string | string[] | undefined>;
	/** The exact bytes of the request body, never a re-serialised object. */
	rawBody: Buffer;
	/** The subscription's signing secret. */
	secret: string;
	/** The receiver's clock, in whole seconds since the epoch. */
	nowSeconds: number;
}

/**
 * Reads a header case-insensitively.
 *
 * A repeated header reaches Node as an array (or, more often, as one string
 * the parser joined with a comma). Each caller decides what that means for
 * its own header, so the raw value is handed back untouched.
 */
const readHeader = (
	headers: Record<string, string | string[] | undefined>,
	name: string,
): string | string[] | undefined => {
	const wanted = name.toLowerCase();

	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === wanted) {
			return value;
		}
	}

	return undefined;
};

/** A decimal integer and nothing else: no sign, no padding, no exponent. */
const STRICT_INTEGER = /^(?:0|[1-9][0-9]*)$/;

/**
 * Parses a header that must be a single strict integer.
 *
 * An array means the header arrived more than once, which makes the intended
 * value ambiguous, so it is rejected rather than guessed at.
 */
export const parseIntegerHeader = (
	value: string | string[] | undefined,
): number | null => {
	if (typeof value !== 'string') {
		return null;
	}

	const candidate = value.trim();

	if (!STRICT_INTEGER.test(candidate)) {
		return null;
	}

	const parsed = Number(candidate);

	return Number.isSafeInteger(parsed) ? parsed : null;
};

/** What a scheme label looks like, whether or not this node understands it. */
const SCHEME_LABEL = /^v[0-9]+$/;

/** Canonical base64: the right alphabet, the right padding, nothing extra. */
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

const decodeBase64 = (value: string): Buffer | null => {
	if (value.length === 0 || value.length % 4 !== 0 || !BASE64.test(value)) {
		return null;
	}

	const decoded = Buffer.from(value, 'base64');

	// Buffer.from is lenient and quietly accepts input it cannot reproduce.
	// Re-encoding is what turns it into a strict decoder.
	return decoded.toString('base64') === value ? decoded : null;
};

/**
 * Splits the signature header into the signatures offered under a scheme this
 * node understands.
 *
 * Entries under another scheme are skipped rather than treated as an error:
 * Core Events may one day offer a `v2` alongside `v1` during a migration, and
 * a receiver that refused the whole header on sight of an unfamiliar scheme
 * would fail every delivery for the length of that migration. A header that
 * offers *only* unknown schemes still fails, because then nothing was offered
 * that this node can check.
 */
const parseSignatureHeader = (
	value: string,
): { offered: Buffer[] } | { malformed: true } | { unsupported: true } => {
	const entries = value
		.split(',')
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);

	if (entries.length === 0) {
		return { malformed: true };
	}

	const offered: Buffer[] = [];
	let sawSupportedScheme = false;

	for (const entry of entries) {
		const separator = entry.indexOf('=');

		if (separator === -1) {
			return { malformed: true };
		}

		const scheme = entry.slice(0, separator);

		// A bare signature with no label at all is malformed, not merely
		// unfamiliar. Base64 padding contains '=', so without this check a
		// naked signature would look like a scheme nobody has heard of.
		if (!SCHEME_LABEL.test(scheme)) {
			return { malformed: true };
		}

		if (scheme !== SIGNATURE_SCHEME) {
			continue;
		}

		sawSupportedScheme = true;

		const decoded = decodeBase64(entry.slice(separator + 1));

		if (decoded === null) {
			return { malformed: true };
		}

		offered.push(decoded);
	}

	if (!sawSupportedScheme) {
		return { unsupported: true };
	}

	return { offered };
};

/**
 * The signature Core Events would have produced for these exact bytes.
 *
 * The prefix is hashed as its own chunk so the body is fed in as the bytes
 * that arrived. Decoding it to a string first would be lossy for any byte
 * sequence that is not valid UTF-8, and a lossy round trip is precisely the
 * mistake this whole module exists to avoid.
 */
export const expectedSignature = (
	secret: string,
	timestamp: number,
	rawBody: Buffer,
): Buffer =>
	createHmac('sha256', secret)
		.update(Buffer.from(`${SIGNATURE_SCHEME}:${timestamp}:`, 'utf8'))
		.update(rawBody)
		.digest();

/**
 * Compares two signatures without leaking, through timing, how much of one
 * matched the other.
 *
 * `timingSafeEqual` throws on operands of different lengths, so the lengths
 * are compared first. That comparison is not itself a leak: the length of an
 * HMAC-SHA256 digest is fixed and public.
 */
const matches = (offered: Buffer, expected: Buffer): boolean =>
	offered.length === expected.length && timingSafeEqual(offered, expected);

/**
 * Decides whether a delivery really came from Core Events.
 *
 * The body is never parsed here. Everything this function does happens on
 * bytes, so a forged or tampered request is turned away before any of its
 * content is interpreted.
 */
export const authenticateDelivery = ({
	method,
	headers,
	rawBody,
	secret,
	nowSeconds,
}: DeliveryAuthentication): AuthenticationResult => {
	if (method.toUpperCase() !== 'POST') {
		return { authenticated: false, reason: 'method_not_allowed' };
	}

	const rawTimestamp = readHeader(headers, 'x-comers-timestamp');

	if (rawTimestamp === undefined) {
		return { authenticated: false, reason: 'missing_timestamp' };
	}

	const timestamp = parseIntegerHeader(rawTimestamp);

	if (timestamp === null) {
		return { authenticated: false, reason: 'malformed_timestamp' };
	}

	if (Math.abs(nowSeconds - timestamp) > TIMESTAMP_TOLERANCE_SECONDS) {
		return { authenticated: false, reason: 'timestamp_outside_window' };
	}

	const rawSignature = readHeader(headers, 'x-comers-signature');

	if (rawSignature === undefined) {
		return { authenticated: false, reason: 'missing_signature' };
	}

	// A repeated signature header means the same thing as one header offering
	// several signatures, so the parts are joined and every offer considered.
	const parsed = parseSignatureHeader(
		Array.isArray(rawSignature) ? rawSignature.join(',') : rawSignature,
	);

	if ('malformed' in parsed) {
		return { authenticated: false, reason: 'malformed_signature' };
	}

	if ('unsupported' in parsed) {
		return { authenticated: false, reason: 'unsupported_signature_version' };
	}

	const expected = expectedSignature(secret, timestamp, rawBody);

	// Every offer is compared, and the order they came in does not matter:
	// during a secret rotation Core Events offers the old and the new
	// signature together, and either one proves the delivery is genuine.
	let authenticated = false;

	for (const offered of parsed.offered) {
		authenticated = matches(offered, expected) || authenticated;
	}

	return authenticated
		? { authenticated: true, timestamp }
		: { authenticated: false, reason: 'signature_mismatch' };
};
