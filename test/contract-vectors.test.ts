import { describe, expect, it } from 'vitest';

import { authenticateDelivery } from '../nodes/ComersTrigger/signature';
import { readDelivery } from '../nodes/ComersTrigger/envelope';
import vectors from './fixtures/contract-vectors.json';
import { deliveryHeaders } from './helpers';

/**
 * Deliveries signed by the real Core Events signer.
 *
 * These are static fixtures: this package has no dependency, at build time or
 * run time, on the Core Events repository. `_provenance` in the fixture file
 * records exactly how they were produced, so they can be re-derived from the
 * Core Events source if the contract ever moves.
 */
describe('signatures produced by Core Events itself', () => {
	it.each(vectors.vectors)('authenticates the $name vector', (vector) => {
		const rawBody = Buffer.from(vector.rawBody, 'utf8');

		expect(
			authenticateDelivery({
				method: 'POST',
				headers: {
					'x-comers-timestamp': String(vector.timestamp),
					'x-comers-signature': vector.signature,
				},
				rawBody,
				secret: vector.secret,
				nowSeconds: vector.timestamp,
			}),
		).toEqual({ authenticated: true, timestamp: vector.timestamp });
	});

	it.each(vectors.vectors)('rejects the $name vector once a byte changes', (vector) => {
		expect(
			authenticateDelivery({
				method: 'POST',
				headers: {
					'x-comers-timestamp': String(vector.timestamp),
					'x-comers-signature': vector.signature,
				},
				rawBody: Buffer.from(`${vector.rawBody} `, 'utf8'),
				secret: vector.secret,
				nowSeconds: vector.timestamp,
			}).authenticated,
		).toBe(false);
	});

	it('reads a real envelope, keeping fields this node has never heard of', () => {
		const vector = vectors.vectors.find((candidate) => candidate.name === 'unknownFields');

		expect(vector).toBeDefined();

		const result = readDelivery({
			headers: deliveryHeaders(vector!.timestamp),
			rawBody: Buffer.from(vector!.rawBody, 'utf8'),
			timestamp: vector!.timestamp,
		});

		expect(result.ok).toBe(true);
		expect(result.ok && result.item.event.aFieldThisNodeHasNeverHeardOf).toEqual({
			nested: true,
		});
	});

	it('keeps sequence as the decimal string Core Events sends', () => {
		const vector = vectors.vectors[0];
		const result = readDelivery({
			headers: deliveryHeaders(vector.timestamp),
			rawBody: Buffer.from(vector.rawBody, 'utf8'),
			timestamp: vector.timestamp,
		});

		// A bigint past 2^53-1: parsing it as a number would silently change it.
		expect(result.ok && result.item.event.sequence).toBe('9007199254740993');
		expect(String(Number('9007199254740993'))).not.toBe('9007199254740993');
	});
});
