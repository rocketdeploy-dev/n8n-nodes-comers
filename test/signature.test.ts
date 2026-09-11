import { describe, expect, it } from 'vitest';

import {
	authenticateDelivery,
	TIMESTAMP_TOLERANCE_SECONDS,
} from '../nodes/ComersTrigger/signature';
import { ROTATED_MATERIAL, SIGNING_MATERIAL, sign, signatureHeader } from './helpers';

const NOW = 1788259530;
const BODY = Buffer.from('{"specVersion":"comers.v1","data":{}}', 'utf8');

const authenticate = (
	overrides: {
		method?: string;
		headers?: Record<string, string | string[] | undefined>;
		rawBody?: Buffer;
		secret?: string;
		nowSeconds?: number;
	} = {},
) =>
	authenticateDelivery({
		method: overrides.method ?? 'POST',
		headers: overrides.headers ?? {
			'x-comers-timestamp': String(NOW),
			'x-comers-signature': signatureHeader(sign(SIGNING_MATERIAL, NOW, BODY)),
		},
		rawBody: overrides.rawBody ?? BODY,
		secret: overrides.secret ?? SIGNING_MATERIAL,
		nowSeconds: overrides.nowSeconds ?? NOW,
	});

const headersFor = (
	timestamp: number,
	signatureValue: string,
): Record<string, string | string[] | undefined> => ({
	'x-comers-timestamp': String(timestamp),
	'x-comers-signature': signatureValue,
});

describe('authenticating a delivery', () => {
	it('accepts a signature over the exact bytes that arrived', () => {
		expect(authenticate()).toEqual({ authenticated: true, timestamp: NOW });
	});

	it('only accepts POST', () => {
		for (const method of ['GET', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) {
			expect(authenticate({ method })).toEqual({
				authenticated: false,
				reason: 'method_not_allowed',
			});
		}
	});

	it('accepts a lowercase method name, since only the method itself matters', () => {
		expect(authenticate({ method: 'post' }).authenticated).toBe(true);
	});
});

describe('the body is authenticated as bytes', () => {
	it('rejects a body changed by a single byte', () => {
		const tampered = Buffer.concat([BODY, Buffer.from(' ')]);

		expect(
			authenticate({
				rawBody: tampered,
				headers: headersFor(NOW, signatureHeader(sign(SIGNING_MATERIAL, NOW, BODY))),
			}),
		).toEqual({ authenticated: false, reason: 'signature_mismatch' });
	});

	it('rejects a signature taken over re-serialised JSON', () => {
		// Same document, different bytes: re-serialising drops the whitespace the
		// sender chose, and the signature covers bytes, not meaning.
		const pretty = Buffer.from('{\n  "specVersion": "comers.v1",\n  "data": {}\n}', 'utf8');
		const reSerialised = JSON.stringify(JSON.parse(pretty.toString('utf8')));

		expect(reSerialised).not.toBe(pretty.toString('utf8'));
		expect(
			authenticate({
				rawBody: pretty,
				headers: headersFor(NOW, signatureHeader(sign(SIGNING_MATERIAL, NOW, reSerialised))),
			}),
		).toEqual({ authenticated: false, reason: 'signature_mismatch' });
	});

	it('distinguishes two documents that differ only in whitespace', () => {
		const compact = Buffer.from('{"a":1}', 'utf8');
		const spaced = Buffer.from('{"a": 1}', 'utf8');

		expect(
			authenticate({
				rawBody: spaced,
				headers: headersFor(NOW, signatureHeader(sign(SIGNING_MATERIAL, NOW, compact))),
			}).authenticated,
		).toBe(false);
		expect(
			authenticate({
				rawBody: spaced,
				headers: headersFor(NOW, signatureHeader(sign(SIGNING_MATERIAL, NOW, spaced))),
			}).authenticated,
		).toBe(true);
	});

	it('distinguishes two documents that differ only in field order', () => {
		const one = Buffer.from('{"a":1,"b":2}', 'utf8');
		const other = Buffer.from('{"b":2,"a":1}', 'utf8');

		expect(
			authenticate({
				rawBody: other,
				headers: headersFor(NOW, signatureHeader(sign(SIGNING_MATERIAL, NOW, one))),
			}).authenticated,
		).toBe(false);
	});

	it('handles non-ASCII payloads as the bytes they are', () => {
		const body = Buffer.from('{"name":"Zażółć gęślą jaźń — ü ß 日本語 🚀"}', 'utf8');

		expect(body.length).toBeGreaterThan(body.toString('utf8').length);
		expect(
			authenticate({
				rawBody: body,
				headers: headersFor(NOW, signatureHeader(sign(SIGNING_MATERIAL, NOW, body))),
			}).authenticated,
		).toBe(true);
	});

	it('authenticates a body that is not valid UTF-8 without mangling it', () => {
		// A lone continuation byte survives here but would become U+FFFD if the
		// body were decoded to a string before hashing.
		const body = Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0x80, 0x22, 0x7d]);

		expect(Buffer.from(body.toString('utf8'), 'utf8')).not.toEqual(body);
		expect(
			authenticate({
				rawBody: body,
				headers: headersFor(NOW, signatureHeader(sign(SIGNING_MATERIAL, NOW, body))),
			}).authenticated,
		).toBe(true);
	});

	it('rejects a delivery signed with another subscription\'s secret', () => {
		expect(
			authenticate({
				headers: headersFor(NOW, signatureHeader(sign(ROTATED_MATERIAL, NOW, BODY))),
			}),
		).toEqual({ authenticated: false, reason: 'signature_mismatch' });
	});
});

describe('the timestamp window', () => {
	const at = (offset: number) => {
		const timestamp = NOW + offset;

		return authenticate({
			headers: headersFor(timestamp, signatureHeader(sign(SIGNING_MATERIAL, timestamp, BODY))),
			nowSeconds: NOW,
		});
	};

	it('accepts a timestamp exactly on the past edge', () => {
		expect(at(-TIMESTAMP_TOLERANCE_SECONDS).authenticated).toBe(true);
	});

	it('accepts a timestamp exactly on the future edge', () => {
		expect(at(TIMESTAMP_TOLERANCE_SECONDS).authenticated).toBe(true);
	});

	it('rejects a timestamp one second past the edge', () => {
		expect(at(-TIMESTAMP_TOLERANCE_SECONDS - 1)).toEqual({
			authenticated: false,
			reason: 'timestamp_outside_window',
		});
	});

	it('rejects a timestamp one second into the future beyond the edge', () => {
		expect(at(TIMESTAMP_TOLERANCE_SECONDS + 1)).toEqual({
			authenticated: false,
			reason: 'timestamp_outside_window',
		});
	});

	it('rejects a captured body replayed under a fresh timestamp', () => {
		// The timestamp is inside the signed string, so re-stamping a captured
		// delivery invalidates the signature it was captured with.
		const captured = sign(SIGNING_MATERIAL, NOW - 3600, BODY);

		expect(authenticate({ headers: headersFor(NOW, signatureHeader(captured)) })).toEqual({
			authenticated: false,
			reason: 'signature_mismatch',
		});
	});

	it('rejects a timestamp that is not a strict integer', () => {
		for (const value of ['', ' ', '1788259530.0', '+1788259530', '-1', '1e9', '0x10', 'now', '01']) {
			expect(
				authenticate({
					headers: {
						'x-comers-timestamp': value,
						'x-comers-signature': signatureHeader(sign(SIGNING_MATERIAL, NOW, BODY)),
					},
				}),
			).toEqual({ authenticated: false, reason: 'malformed_timestamp' });
		}
	});

	it('rejects a timestamp beyond the safe integer range', () => {
		expect(
			authenticate({
				headers: {
					'x-comers-timestamp': '9007199254740993',
					'x-comers-signature': signatureHeader(sign(SIGNING_MATERIAL, NOW, BODY)),
				},
			}),
		).toEqual({ authenticated: false, reason: 'malformed_timestamp' });
	});

	it('rejects a repeated timestamp header, which leaves the value ambiguous', () => {
		expect(
			authenticate({
				headers: {
					'x-comers-timestamp': [String(NOW), String(NOW)],
					'x-comers-signature': signatureHeader(sign(SIGNING_MATERIAL, NOW, BODY)),
				},
			}),
		).toEqual({ authenticated: false, reason: 'malformed_timestamp' });
	});

	it('rejects the comma-joined form a repeated header usually arrives as', () => {
		expect(
			authenticate({
				headers: {
					'x-comers-timestamp': `${NOW}, ${NOW}`,
					'x-comers-signature': signatureHeader(sign(SIGNING_MATERIAL, NOW, BODY)),
				},
			}),
		).toEqual({ authenticated: false, reason: 'malformed_timestamp' });
	});
});

describe('the signature header', () => {
	it('accepts a single signature', () => {
		expect(
			authenticate({ headers: headersFor(NOW, signatureHeader(sign(SIGNING_MATERIAL, NOW, BODY))) })
				.authenticated,
		).toBe(true);
	});

	it('accepts when the first of several offers matches', () => {
		expect(
			authenticate({
				headers: headersFor(
					NOW,
					signatureHeader(sign(SIGNING_MATERIAL, NOW, BODY), sign(ROTATED_MATERIAL, NOW, BODY)),
				),
			}).authenticated,
		).toBe(true);
	});

	it('accepts when a later offer matches, so the order does not matter', () => {
		expect(
			authenticate({
				headers: headersFor(
					NOW,
					signatureHeader(sign(ROTATED_MATERIAL, NOW, BODY), sign(SIGNING_MATERIAL, NOW, BODY)),
				),
			}).authenticated,
		).toBe(true);
	});

	it('accepts a match among many offers', () => {
		const offers = [
			sign('secret-one-that-does-not-match-anything', NOW, BODY),
			sign(ROTATED_MATERIAL, NOW, BODY),
			sign(SIGNING_MATERIAL, NOW, BODY),
			sign('another-secret-entirely', NOW, BODY),
		];

		expect(authenticate({ headers: headersFor(NOW, signatureHeader(...offers)) }).authenticated).toBe(
			true,
		);
	});

	it('rejects when none of several offers matches', () => {
		expect(
			authenticate({
				headers: headersFor(
					NOW,
					signatureHeader(sign(ROTATED_MATERIAL, NOW, BODY), sign('third', NOW, BODY)),
				),
			}),
		).toEqual({ authenticated: false, reason: 'signature_mismatch' });
	});

	it('tolerates whitespace around the offers', () => {
		expect(
			authenticate({
				headers: headersFor(
					NOW,
					` v1=${sign(ROTATED_MATERIAL, NOW, BODY)} , v1=${sign(SIGNING_MATERIAL, NOW, BODY)} `,
				),
			}).authenticated,
		).toBe(true);
	});

	it('treats a repeated signature header as one longer list of offers', () => {
		expect(
			authenticate({
				headers: {
					'x-comers-timestamp': String(NOW),
					'x-comers-signature': [
						signatureHeader(sign(ROTATED_MATERIAL, NOW, BODY)),
						signatureHeader(sign(SIGNING_MATERIAL, NOW, BODY)),
					],
				},
			}).authenticated,
		).toBe(true);
	});

	it('rejects a signature that is not valid base64', () => {
		for (const value of ['v1=not base64!', 'v1=****', 'v1==', 'v1=YWJjZA=', 'v1=']) {
			expect(authenticate({ headers: headersFor(NOW, value) })).toEqual({
				authenticated: false,
				reason: 'malformed_signature',
			});
		}
	});

	it('rejects base64 it could not have produced itself', () => {
		// Trailing bits that re-encode differently: lenient decoders accept this,
		// a strict one must not.
		expect(authenticate({ headers: headersFor(NOW, 'v1=YWJjZB==') })).toEqual({
			authenticated: false,
			reason: 'malformed_signature',
		});
	});

	it('rejects an offer with no scheme at all', () => {
		expect(authenticate({ headers: headersFor(NOW, sign(SIGNING_MATERIAL, NOW, BODY)) })).toEqual({
			authenticated: false,
			reason: 'malformed_signature',
		});
	});

	it('rejects a header that offers only schemes it does not understand', () => {
		expect(
			authenticate({ headers: headersFor(NOW, `v2=${sign(SIGNING_MATERIAL, NOW, BODY)}`) }),
		).toEqual({ authenticated: false, reason: 'unsupported_signature_version' });
	});

	it('ignores an unknown scheme offered alongside one it understands', () => {
		// Core Events could introduce a v2 during a migration; refusing the whole
		// header on sight of it would fail every delivery until the migration ended.
		expect(
			authenticate({
				headers: headersFor(NOW, `v2=ZGVmaW5pdGVseS1ub3QtdjE=,v1=${sign(SIGNING_MATERIAL, NOW, BODY)}`),
			}).authenticated,
		).toBe(true);
	});

	it('rejects an offer of a different length without throwing', () => {
		// timingSafeEqual throws on operands of unequal length; the comparison
		// has to survive a signature that is simply the wrong size.
		for (const value of ['v1=YWJjZA==', 'v1=' + Buffer.alloc(64).toString('base64')]) {
			expect(() => authenticate({ headers: headersFor(NOW, value) })).not.toThrow();
			expect(authenticate({ headers: headersFor(NOW, value) })).toEqual({
				authenticated: false,
				reason: 'signature_mismatch',
			});
		}
	});

	it('rejects an empty signature header', () => {
		for (const value of ['', '   ', ',', ' , ']) {
			expect(authenticate({ headers: headersFor(NOW, value) }).authenticated).toBe(false);
		}
	});
});

describe('missing and oddly cased headers', () => {
	it('reports a missing timestamp', () => {
		expect(
			authenticate({
				headers: { 'x-comers-signature': signatureHeader(sign(SIGNING_MATERIAL, NOW, BODY)) },
			}),
		).toEqual({ authenticated: false, reason: 'missing_timestamp' });
	});

	it('reports a missing signature', () => {
		expect(authenticate({ headers: { 'x-comers-timestamp': String(NOW) } })).toEqual({
			authenticated: false,
			reason: 'missing_signature',
		});
	});

	it('reports missing headers when there are none at all', () => {
		expect(authenticate({ headers: {} })).toEqual({
			authenticated: false,
			reason: 'missing_timestamp',
		});
	});

	it('reads headers whatever their casing', () => {
		expect(
			authenticate({
				headers: {
					'X-Comers-Timestamp': String(NOW),
					'X-COMERS-SIGNATURE': signatureHeader(sign(SIGNING_MATERIAL, NOW, BODY)),
				},
			}).authenticated,
		).toBe(true);
	});
});
