import { createHmac } from 'node:crypto';

/**
 * Two fixtures with the shape Comers issues — 32 random bytes in base64url.
 * They were generated for these tests and have never belonged to a
 * subscription. Nothing real is stored here.
 */
export const SIGNING_MATERIAL = 'IM68OKPZoDziE_Qss65qwKTNRYQTE1uc9hwsc0e1uGQ';
export const ROTATED_MATERIAL = 'sO0CYnpBLDvGQbJ0zOwnxbg0AFiBcWHOAOX1dKbJ0aE';

/**
 * Core Events' signing rule, written out again here rather than imported.
 *
 * The tests have to fail if this package drifts from the contract, and they
 * could not if they shared an implementation with the thing under test.
 */
export const sign = (secret: string, timestamp: number, rawBody: string | Buffer): string =>
	createHmac('sha256', secret)
		.update(Buffer.concat([
			Buffer.from(`v1:${timestamp}:`, 'utf8'),
			typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody,
		]))
		.digest('base64');

export const signatureHeader = (...signatures: string[]): string =>
	signatures.map((signature) => `v1=${signature}`).join(',');

export const envelopeJson = (overrides: Record<string, unknown> = {}): string =>
	JSON.stringify({
		specVersion: 'comers.v1',
		eventId: '0199c3f0-1a2b-7c3d-8e4f-000000000001',
		eventKey: 'support.case.opened',
		eventVersion: 1,
		sequence: '9007199254740993',
		occurredAt: '2026-09-11T07:05:30.000Z',
		producer: 'comers-core-support',
		scope: {
			organizationId: '0199c3f0-1a2b-7c3d-8e4f-00000000000a',
			sellerId: null,
			sellerStoreId: null,
		},
		subject: { type: 'support_case', id: '0199c3f0-1a2b-7c3d-8e4f-00000000000b' },
		correlationId: '0199c3f0-1a2b-7c3d-8e4f-00000000000c',
		data: { caseId: '0199c3f0-1a2b-7c3d-8e4f-00000000000b', priority: 'high' },
		...overrides,
	});

/** The headers Core Events sends alongside a body, minus the signature. */
export const deliveryHeaders = (
	timestamp: number,
	overrides: Record<string, string | string[] | undefined> = {},
): Record<string, string | string[] | undefined> => ({
	'content-type': 'application/json',
	'x-comers-event-id': '0199c3f0-1a2b-7c3d-8e4f-000000000001',
	'x-comers-event-key': 'support.case.opened',
	'x-comers-event-version': '1',
	'x-comers-subscription-id': '0199c3f0-1a2b-7c3d-8e4f-000000000002',
	'x-comers-delivery-id': '0199c3f0-1a2b-7c3d-8e4f-000000000003',
	'x-comers-delivery-attempt': '0',
	'x-comers-timestamp': String(timestamp),
	'x-correlation-id': '0199c3f0-1a2b-7c3d-8e4f-00000000000c',
	...overrides,
});
