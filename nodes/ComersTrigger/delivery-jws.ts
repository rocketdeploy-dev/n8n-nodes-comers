import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto';

/**
 * Verification of a Comers `jws-es256-v1` delivery.
 *
 * The body is an RFC 7515 JWS in flattened JSON serialization. Nothing in it is
 * trusted until the signature over the exact bytes received has been verified
 * with a public key Comers publishes; only then is the payload decoded. No
 * secret is involved anywhere, so nothing here needs protecting.
 */

export const DELIVERY_TYPE = 'comers-delivery+jws';
export const DELIVERY_ALGORITHM = 'ES256';

const BASE64URL = /^[A-Za-z0-9_-]+$/;
const KID = /^v[1-9][0-9]{0,9}\.[A-Za-z0-9_-]{43}$/;
const COORDINATE = /^[A-Za-z0-9_-]{43}$/;
const PUBLIC_MEMBERS = 'alg,crv,key_ops,kid,kty,use,x,y';

export type JwsFailure =
	| 'not_flattened_jws'
	| 'protected_header'
	| 'algorithm'
	| 'unknown_kid'
	| 'signature'
	| 'payload';

/** Refused: the delivery is not genuine or not for this node. */
export type Refused = { ok: false; refused: JwsFailure };

/** The delivery keys could not be obtained: Comers should try again later. */
export type Unavailable = { ok: false; unavailable: string };

const refused = (reason: JwsFailure): Refused => ({ ok: false, refused: reason });

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

/** Canonical unpadded base64url: re-encoding the decoded bytes gives the same text. */
const decodeCanonical = (value: string): Buffer | undefined => {
	if (!BASE64URL.test(value)) return undefined;
	const bytes = Buffer.from(value, 'base64url');

	return bytes.toString('base64url') === value ? bytes : undefined;
};

const thumbprint = (x: string, y: string): string =>
	createHash('sha256')
		.update(`{"crv":"P-256","kty":"EC","x":"${x}","y":"${y}"}`)
		.digest('base64url');

/**
 * The published key set, as a map from `kid` to key. One key that is not
 * exactly a public ES256 verification key whose `kid` is its own RFC 7638
 * thumbprint makes the whole set unusable: a receiver never trusts part of a
 * document it cannot account for.
 */
export const parseKeySet = (body: unknown): Map<string, KeyObject> | null => {
	if (!isObject(body) || Object.keys(body).join() !== 'keys' || !Array.isArray(body.keys)) {
		return null;
	}

	const keys = new Map<string, KeyObject>();

	for (const entry of body.keys as unknown[]) {
		if (
			!isObject(entry) ||
			Object.keys(entry).sort().join() !== PUBLIC_MEMBERS ||
			entry.kty !== 'EC' ||
			entry.crv !== 'P-256' ||
			entry.alg !== DELIVERY_ALGORITHM ||
			entry.use !== 'sig' ||
			!Array.isArray(entry.key_ops) ||
			entry.key_ops.join() !== 'verify' ||
			typeof entry.kid !== 'string' ||
			!KID.test(entry.kid) ||
			typeof entry.x !== 'string' ||
			typeof entry.y !== 'string' ||
			!COORDINATE.test(entry.x) ||
			!COORDINATE.test(entry.y) ||
			decodeCanonical(entry.x)?.length !== 32 ||
			decodeCanonical(entry.y)?.length !== 32 ||
			entry.kid.split('.')[1] !== thumbprint(entry.x, entry.y) ||
			keys.has(entry.kid)
		) {
			return null;
		}

		try {
			keys.set(
				entry.kid,
				createPublicKey({
					key: { kty: 'EC', crv: 'P-256', x: entry.x, y: entry.y },
					format: 'jwk',
				}),
			);
		} catch {
			return null;
		}
	}

	return keys.size === 0 ? null : keys;
};

/** How long a fetched key set may be reused: its `max-age`, bounded; none when it may not be stored. */
export const cacheLifetimeMs = (cacheControl: string | undefined): number => {
	if (cacheControl === undefined) return 60_000;
	const directives = cacheControl
		.toLowerCase()
		.split(',')
		.map((part) => part.trim());

	if (directives.includes('no-store') || directives.includes('no-cache')) return 0;

	const maxAge = directives.find((part) => part.startsWith('max-age='));
	const seconds = maxAge === undefined ? 60 : Number(maxAge.slice('max-age='.length));

	return Number.isSafeInteger(seconds) && seconds >= 0 ? Math.min(seconds, 3600) * 1000 : 60_000;
};

/** Fetches a JWKS: status, parsed body and its Cache-Control. */
export type KeySetFetcher = (
	uri: string,
) => Promise<{ statusCode: number; body: unknown; cacheControl: string | undefined }>;

/** An unknown `kid` refreshes the set at most this often per URI. */
export const FORCED_REFRESH_INTERVAL_MS = 10_000;

interface CachedKeySet {
	keys: Map<string, KeyObject>;
	expiresAt: number;
	fetchedAt: number;
}

/**
 * Public delivery keys, per JWKS URI, in this process's memory only.
 *
 * A set is reused for its `max-age`. A `kid` the cached set does not know
 * causes one refresh — rate limited, so a stream of forged identifiers cannot
 * turn into a stream of requests — and is refused if the fresh set does not
 * know it either.
 */
export type KeyLookup = { ok: true; key: KeyObject } | Refused | Unavailable;

export class DeliveryKeyCache {
	private readonly sets = new Map<string, CachedKeySet>();
	private readonly pending = new Map<string, Promise<CachedKeySet | Unavailable>>();

	constructor(private readonly now: () => number = () => Date.now()) {}

	async key(uri: string, kid: string, fetch: KeySetFetcher): Promise<KeyLookup> {
		let set: CachedKeySet | Unavailable | undefined = this.sets.get(uri);

		// Every fetch counts as the fresh look an unknown `kid` is entitled to,
		// so one delivery never causes more than one request.
		if (set === undefined || set.expiresAt <= this.now()) {
			set = await this.refresh(uri, fetch);
		} else if (!set.keys.has(kid) && this.now() - set.fetchedAt >= FORCED_REFRESH_INTERVAL_MS) {
			set = await this.refresh(uri, fetch);
		}

		if ('unavailable' in set) {
			return set;
		}

		const key = set.keys.get(kid);

		return key === undefined ? refused('unknown_kid') : { ok: true, key };
	}

	clear(): void {
		this.sets.clear();
		this.pending.clear();
	}

	private refresh(uri: string, fetch: KeySetFetcher): Promise<CachedKeySet | Unavailable> {
		let pending = this.pending.get(uri);

		if (pending === undefined) {
			pending = (async (): Promise<CachedKeySet | Unavailable> => {
				let response: Awaited<ReturnType<KeySetFetcher>>;

				try {
					response = await fetch(uri);
				} catch {
					return { ok: false, unavailable: 'unreachable' };
				}

				if (response.statusCode !== 200) {
					return { ok: false, unavailable: `http_${response.statusCode}` };
				}

				const keys = parseKeySet(response.body);

				if (keys === null) {
					return { ok: false, unavailable: 'invalid_key_set' };
				}

				const set = {
					keys,
					expiresAt: this.now() + cacheLifetimeMs(response.cacheControl),
					fetchedAt: this.now(),
				};

				this.sets.set(uri, set);

				return set;
			})().finally(() => {
				this.pending.delete(uri);
			});
			this.pending.set(uri, pending);
		}

		return pending;
	}
}

/** The shape checks before any key is looked up, and the header they yield. */
export interface FlattenedJws {
	protectedHeader: string;
	payload: string;
	signature: Buffer;
	kid: string;
}

export const readJws = (rawBody: Buffer): ({ ok: true } & FlattenedJws) | Refused => {
	let jws: unknown;

	try {
		jws = JSON.parse(rawBody.toString('utf8'));
	} catch {
		return refused('not_flattened_jws');
	}

	if (
		!isObject(jws) ||
		Object.keys(jws).sort().join() !== 'payload,protected,signature' ||
		typeof jws.protected !== 'string' ||
		typeof jws.payload !== 'string' ||
		typeof jws.signature !== 'string'
	) {
		return refused('not_flattened_jws');
	}

	const headerBytes = decodeCanonical(jws.protected);
	let header: unknown;

	try {
		header = headerBytes === undefined ? undefined : JSON.parse(headerBytes.toString('utf8'));
	} catch {
		header = undefined;
	}

	if (!isObject(header) || Object.keys(header).sort().join() !== 'alg,kid,typ') {
		return refused('protected_header');
	}

	// The algorithm is checked before a key is chosen, so `none`, an HMAC
	// algorithm or anything else never reaches verification.
	if (header.alg !== DELIVERY_ALGORITHM) {
		return refused('algorithm');
	}

	if (header.typ !== DELIVERY_TYPE || typeof header.kid !== 'string' || !KID.test(header.kid)) {
		return refused('protected_header');
	}

	const signature = decodeCanonical(jws.signature);

	if (
		signature === undefined ||
		signature.length !== 64 ||
		decodeCanonical(jws.payload) === undefined
	) {
		return refused('signature');
	}

	return {
		ok: true,
		protectedHeader: jws.protected,
		payload: jws.payload,
		signature,
		kid: header.kid,
	};
};

/**
 * Verifies the ES256 signature over `protected.payload` exactly as received,
 * and only then decodes the payload.
 */
export const verifyJws = (
	jws: FlattenedJws,
	key: KeyObject,
): { ok: true; payload: unknown } | Refused => {
	const valid = verify(
		'sha256',
		Buffer.from(`${jws.protectedHeader}.${jws.payload}`, 'ascii'),
		{ key, dsaEncoding: 'ieee-p1363' },
		jws.signature,
	);

	if (!valid) {
		return refused('signature');
	}

	try {
		return {
			ok: true,
			payload: JSON.parse(Buffer.from(jws.payload, 'base64url').toString('utf8')) as unknown,
		};
	} catch {
		return refused('payload');
	}
};
