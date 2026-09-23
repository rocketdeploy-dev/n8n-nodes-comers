import { describe, expect, it } from 'vitest';

import { catalogOptions } from '../nodes/ComersTrigger/event-catalog';
import { decodeEventChoice } from '../nodes/ComersTrigger/registration';

describe('event catalog choices', () => {
	it('keeps two versions of the same key distinct and labels deprecation', () => {
		const options = catalogOptions({ events: [
			{ eventKey: 'comers.core.support.case.opened', eventVersion: 1, producer: 'support', subject: 'case', description: 'A case opened.', deprecatedFrom: '2027-01-01' },
			{ eventKey: 'comers.core.support.case.opened', eventVersion: 2, producer: 'support', subject: 'case', description: 'A case opened.' },
		] });
		expect(options?.map((option) => option.value).sort()).toEqual([
			'comers.core.support.case.opened@1', 'comers.core.support.case.opened@2',
		]);
		expect(options?.find((option) => option.value === 'comers.core.support.case.opened@1')?.name).toContain('deprecated');
		expect(decodeEventChoice('comers.core.support.case.opened@2')).toEqual({ eventKey: 'comers.core.support.case.opened', eventVersion: 2 });
	});

	it('fails closed for malformed or duplicate catalog entries', () => {
		expect(catalogOptions({ events: [{ eventKey: 'invalid key', eventVersion: 1, producer: 'p', subject: 's', description: 'd' }] })).toBeUndefined();
		expect(catalogOptions({ events: [
			{ eventKey: 'comers.core.support.case.opened', eventVersion: 1, producer: 'p', subject: 's', description: 'd' },
			{ eventKey: 'comers.core.support.case.opened', eventVersion: 1, producer: 'p', subject: 's', description: 'd' },
		] })).toBeUndefined();
	});
});
