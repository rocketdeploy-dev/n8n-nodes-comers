import { describe, expect, it } from 'vitest';

import { readDelivery, SPEC_VERSION } from '../nodes/ComersTrigger/envelope';
import { deliveryHeaders, envelopeJson } from './helpers';

const TIMESTAMP = 1788259530;

const read = (
	body: string,
	headerOverrides: Record<string, string | string[] | undefined> = {},
) =>
	readDelivery({
		headers: deliveryHeaders(TIMESTAMP, headerOverrides),
		rawBody: Buffer.from(body, 'utf8'),
		timestamp: TIMESTAMP,
	});

describe('reading a verified delivery', () => {
	it('produces one item holding the event and the delivery, side by side', () => {
		const result = read(envelopeJson());

		expect(result).toEqual({
			ok: true,
			item: {
				event: {
					specVersion: SPEC_VERSION,
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
				},
				delivery: {
					subscriptionId: '0199c3f0-1a2b-7c3d-8e4f-000000000002',
					deliveryId: '0199c3f0-1a2b-7c3d-8e4f-000000000003',
					deliveryAttempt: 0,
					timestamp: TIMESTAMP,
				},
			},
		});
	});

	it('hands the envelope over exactly as it was parsed', () => {
		const body = envelopeJson();
		const result = read(body);

		expect(result.ok && result.item.event).toEqual(JSON.parse(body));
	});

	it('has only the two keys, so nothing of ours can shadow the envelope', () => {
		const result = read(envelopeJson());

		expect(result.ok && Object.keys(result.item).sort()).toEqual(['delivery', 'event']);
	});

	it('exposes no requestId, because Core Events does not send one', () => {
		const result = read(envelopeJson());

		expect(result.ok && 'requestId' in result.item.event).toBe(false);
		expect(result.ok && 'requestId' in result.item.delivery).toBe(false);
	});

	it('carries a null correlationId through rather than dropping it', () => {
		const result = read(envelopeJson({ correlationId: null }));

		expect(result.ok && result.item.event.correlationId).toBeNull();
	});

	it('reports the attempt number, so a workflow can tell a redelivery', () => {
		const result = read(envelopeJson(), { 'x-comers-delivery-attempt': '3' });

		expect(result.ok && result.item.delivery.deliveryAttempt).toBe(3);
	});
});

describe('forward compatibility', () => {
	it('accepts an event key it has never seen', () => {
		const result = read(
			envelopeJson({ eventKey: 'some.future.thing' }),
			{ 'x-comers-event-key': 'some.future.thing' },
		);

		expect(result.ok).toBe(true);
	});

	it('accepts any shape of domain payload', () => {
		for (const data of [{}, [], 'a string', 42, null, { deeply: { nested: [1, 2, 3] } }]) {
			expect(read(envelopeJson({ data })).ok).toBe(true);
		}
	});

	it('keeps envelope fields it does not know about', () => {
		const result = read(envelopeJson({ somethingNew: { added: 'later' } }));

		expect(result.ok && result.item.event.somethingNew).toEqual({ added: 'later' });
	});

	it('leaves a future envelope field named `delivery` untouched', () => {
		// The one collision that separating `event` from `delivery` exists to
		// prevent: if Core Events ever adds its own `delivery` to the envelope,
		// it stays the envelope's, and the transport keeps its own place.
		const theirs = { courier: 'dhl', trackingNumber: 'JD0000000000' };
		const result = read(envelopeJson({ delivery: theirs }));

		expect(result.ok && result.item.event.delivery).toEqual(theirs);
		expect(result.ok && result.item.delivery).toEqual({
			subscriptionId: '0199c3f0-1a2b-7c3d-8e4f-000000000002',
			deliveryId: '0199c3f0-1a2b-7c3d-8e4f-000000000003',
			deliveryAttempt: 0,
			timestamp: TIMESTAMP,
		});
	});

	it('accepts a subject id that is not a UUID', () => {
		// The contract does not promise UUIDs here, so a producer that uses a
		// slug or a legacy numeric id is not this node's business to refuse.
		const result = read(envelopeJson({ subject: { type: 'listing', id: 'SKU-114-B' } }));

		expect(result.ok).toBe(true);
	});
});

describe('envelopes it refuses', () => {
	it('refuses a body that is not JSON', () => {
		expect(read('not json at all')).toEqual({ ok: false, reason: 'body_not_json' });
	});

	it('refuses a body that is JSON but not an object', () => {
		for (const body of ['[]', '"text"', '42', 'null', 'true']) {
			expect(read(body), body).toEqual({ ok: false, reason: 'body_not_an_object' });
		}
	});

	it('refuses an envelope version it does not understand', () => {
		expect(read(envelopeJson({ specVersion: 'comers.v2' }))).toEqual({
			ok: false,
			reason: 'unsupported_spec_version',
		});
	});

	it('refuses an envelope missing a protocol field', () => {
		for (const field of [
			'eventId',
			'eventKey',
			'eventVersion',
			'sequence',
			'occurredAt',
			'producer',
			'scope',
			'subject',
			'correlationId',
			'data',
		]) {
			const envelope = JSON.parse(envelopeJson()) as Record<string, unknown>;
			delete envelope[field];

			expect(read(JSON.stringify(envelope)).ok, `missing ${field}`).toBe(false);
		}
	});

	it('refuses protocol fields of the wrong type', () => {
		const wrong: Array<Record<string, unknown>> = [
			{ eventId: 42 },
			{ eventId: '' },
			{ eventKey: null },
			{ eventVersion: '1' },
			{ eventVersion: 1.5 },
			{ sequence: 12 },
			{ sequence: 'not-a-number' },
			{ sequence: '-1' },
			{ occurredAt: 'the day before yesterday' },
			{ occurredAt: '' },
			{ producer: '' },
			{ correlationId: 42 },
			{ correlationId: {} },
		];

		for (const override of wrong) {
			expect(read(envelopeJson(override)).ok, JSON.stringify(override)).toBe(false);
		}
	});

	it('refuses an event version that is not a whole number above zero', () => {
		for (const eventVersion of [0, -1, 1.5, '1', null, Number.NaN, 2 ** 53]) {
			expect(read(envelopeJson({ eventVersion })).ok, String(eventVersion)).toBe(false);
		}

		expect(read(envelopeJson({ eventVersion: 1 })).ok).toBe(true);
		expect(
			read(envelopeJson({ eventVersion: 7 }), { 'x-comers-event-version': '7' }).ok,
		).toBe(true);
	});

	it('refuses a subject without a usable type or id', () => {
		const wrong: unknown[] = [
			[],
			'support_case',
			null,
			{ type: 'support_case' },
			{ id: '0199c3f0-1a2b-7c3d-8e4f-00000000000b' },
			{ type: '', id: 'x' },
			{ type: 'support_case', id: '' },
			{ type: 'support_case', id: null },
			{ type: 'support_case', id: 42 },
		];

		for (const subject of wrong) {
			expect(read(envelopeJson({ subject })).ok, JSON.stringify(subject)).toBe(false);
		}
	});

	it('refuses a scope that does not say which organization the event belongs to', () => {
		const wrong: unknown[] = [
			'organization',
			null,
			{},
			{ organizationId: '', sellerId: null, sellerStoreId: null },
			{ organizationId: 42, sellerId: null, sellerStoreId: null },
			// The narrowing keys are always sent, explicitly null when unused.
			{ organizationId: '0199c3f0-1a2b-7c3d-8e4f-00000000000a' },
			{ organizationId: '0199c3f0-1a2b-7c3d-8e4f-00000000000a', sellerId: null },
			{ organizationId: '0199c3f0-1a2b-7c3d-8e4f-00000000000a', sellerStoreId: null },
			// ...and when they are sent, they are a string or that null.
			{ organizationId: '0199c3f0-1a2b-7c3d-8e4f-00000000000a', sellerId: 42, sellerStoreId: null },
			{
				organizationId: '0199c3f0-1a2b-7c3d-8e4f-00000000000a',
				sellerId: null,
				sellerStoreId: { id: 'x' },
			},
		];

		for (const scope of wrong) {
			expect(read(envelopeJson({ scope })).ok, JSON.stringify(scope)).toBe(false);
		}
	});

	it('accepts a scope narrowed to a seller and a store', () => {
		const scope = {
			organizationId: '0199c3f0-1a2b-7c3d-8e4f-00000000000a',
			sellerId: '0199c3f0-1a2b-7c3d-8e4f-00000000000d',
			sellerStoreId: '0199c3f0-1a2b-7c3d-8e4f-00000000000e',
		};

		expect(read(envelopeJson({ scope })).ok).toBe(true);
	});

	it('refuses a delivery whose headers contradict the envelope it signed', () => {
		expect(read(envelopeJson(), { 'x-comers-event-id': 'a-different-event' })).toEqual({
			ok: false,
			reason: 'headers_contradict_envelope',
		});
		expect(read(envelopeJson(), { 'x-comers-event-key': 'a.different.key' })).toEqual({
			ok: false,
			reason: 'headers_contradict_envelope',
		});
		expect(read(envelopeJson(), { 'x-comers-event-version': '2' })).toEqual({
			ok: false,
			reason: 'headers_contradict_envelope',
		});
	});
});

describe('delivery headers', () => {
	it('requires every header Core Events sends', () => {
		for (const header of [
			'x-comers-event-id',
			'x-comers-event-key',
			'x-comers-event-version',
			'x-comers-subscription-id',
			'x-comers-delivery-id',
			'x-comers-delivery-attempt',
		]) {
			expect(read(envelopeJson(), { [header]: undefined }).ok, header).toBe(false);
		}
	});

	it('reads them whatever their casing', () => {
		const headers: Record<string, string | string[] | undefined> = {
			'Content-Type': 'application/json',
			'X-Comers-Event-Id': '0199c3f0-1a2b-7c3d-8e4f-000000000001',
			'X-Comers-Event-Key': 'support.case.opened',
			'X-COMERS-EVENT-VERSION': '1',
			'x-comers-subscription-id': '0199c3f0-1a2b-7c3d-8e4f-000000000002',
			'X-Comers-Delivery-Id': '0199c3f0-1a2b-7c3d-8e4f-000000000003',
			'X-Comers-Delivery-Attempt': '0',
		};

		expect(
			readDelivery({
				headers,
				rawBody: Buffer.from(envelopeJson(), 'utf8'),
				timestamp: TIMESTAMP,
			}).ok,
		).toBe(true);
	});

	it('refuses a repeated header, which leaves the value ambiguous', () => {
		expect(
			read(envelopeJson(), {
				'x-comers-delivery-id': ['one', 'two'],
			}),
		).toEqual({ ok: false, reason: 'missing_delivery_headers' });
	});

	it('refuses counters that are not strict integers', () => {
		for (const value of ['1.0', '-1', '+1', 'one', '', '0x2']) {
			expect(read(envelopeJson(), { 'x-comers-delivery-attempt': value }).ok, value).toBe(false);
		}
	});

	it('refuses a content type it cannot read', () => {
		expect(read(envelopeJson(), { 'content-type': 'text/plain' })).toEqual({
			ok: false,
			reason: 'unsupported_content_type',
		});
		expect(read(envelopeJson(), { 'content-type': undefined })).toEqual({
			ok: false,
			reason: 'unsupported_content_type',
		});
	});

	it('accepts a content type that carries a charset', () => {
		expect(read(envelopeJson(), { 'content-type': 'application/json; charset=utf-8' }).ok).toBe(
			true,
		);
	});
});
