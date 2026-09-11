import { describe, expect, it } from 'vitest';

// @ts-expect-error -- a plain ESM script, deliberately not part of the package build
import { normalizePackReport } from '../scripts/pack-report.mjs';

const PACKAGE = '@comers/n8n-nodes-comers';

/** What one report looks like, in the fields this repository reads. */
const reportBody = (overrides: Record<string, unknown> = {}) => ({
	id: `${PACKAGE}@0.1.0`,
	name: PACKAGE,
	version: '0.1.0',
	size: 17753,
	unpackedSize: 58068,
	files: [
		{ path: 'package.json', size: 1500, mode: 420 },
		{ path: 'dist/nodes/ComersTrigger/ComersTrigger.node.js', size: 6800, mode: 420 },
		{ path: 'LICENSE', size: 1100, mode: 420 },
	],
	entryCount: 3,
	...overrides,
});

/** npm 11 and earlier: an array of reports. */
const npm11 = (overrides?: Record<string, unknown>) => [reportBody(overrides)];

/** npm 12: an object keyed by package name. */
const npm12 = (overrides?: Record<string, unknown>) => ({ [PACKAGE]: reportBody(overrides) });

const normalize = (report: unknown, packageName = PACKAGE) =>
	normalizePackReport({ report, packageName, npmVersion: '12.0.2' }) as {
		files: string[];
		size: number;
	};

const expected = {
	files: ['LICENSE', 'dist/nodes/ComersTrigger/ComersTrigger.node.js', 'package.json'],
	size: 17753,
};

describe('the shapes npm actually produces', () => {
	it('reads the npm 11 array', () => {
		expect(normalize(npm11())).toEqual(expected);
	});

	it('reads the npm 12 object', () => {
		expect(normalize(npm12())).toEqual(expected);
	});

	it('returns the paths sorted, whichever shape they came in', () => {
		expect(normalize(npm11()).files).toEqual([...expected.files].sort());
		expect(normalize(npm12()).files).toEqual([...expected.files].sort());
	});
});

describe('picking the right report out of an npm 12 object', () => {
	it('looks the package up by name rather than taking a key', () => {
		const report = {
			'zzz-some-other-package': reportBody({ name: 'zzz-some-other-package', size: 999 }),
			[PACKAGE]: reportBody(),
			'aaa-another-one': reportBody({ name: 'aaa-another-one', size: 111 }),
		};

		// First key, last key and alphabetical order all disagree with each
		// other here, so only a lookup by name can get this right.
		expect(normalize(report)).toEqual(expected);
	});

	it('refuses an object that does not mention this package', () => {
		const report = { 'some-other-package': reportBody({ name: 'some-other-package' }) };

		expect(() => normalize(report)).toThrow(/none of them named @comers\/n8n-nodes-comers/);
	});
});

describe('shapes it refuses', () => {
	const rejected: Array<[string, unknown, RegExp]> = [
		['null', null, /got null/],
		['a string', 'ok', /got a string/],
		['a number', 42, /got a number/],
		['a boolean', true, /got a boolean/],
		['an empty array', [], /expected exactly one report, got an empty array/],
		['an empty object', {}, /an empty object/],
		['several reports in an array', [reportBody(), reportBody()], /expected exactly one report, got an array of 2 reports/],
		['a report that is null', { [PACKAGE]: null }, /is null/],
		['a report that is an array', { [PACKAGE]: [] }, /is an empty array/],
		['a report that is a scalar', { [PACKAGE]: 'packed' }, /is a string/],
	];

	it.each(rejected)('refuses %s', (_label, report, message) => {
		expect(() => normalize(report)).toThrow(message);
	});

	it('refuses a report with no files list', () => {
		expect(() => normalize(npm12({ files: undefined }))).toThrow(/has no list of files/);
		expect(() => normalize(npm11({ files: undefined }))).toThrow(/has no list of files/);
	});

	it('refuses a files field that is not an array', () => {
		for (const files of ['package.json', 42, null, { path: 'package.json' }]) {
			expect(() => normalize(npm12({ files }))).toThrow(/has no list of files/);
		}
	});

	it('refuses an empty files list, which would check nothing', () => {
		expect(() => normalize(npm12({ files: [] }))).toThrow(/has no list of files/);
	});

	it('refuses a file entry without a usable path', () => {
		for (const entry of [{}, { path: '' }, { path: 42 }, { path: null }, null, 'package.json']) {
			expect(() => normalize(npm12({ files: [{ path: 'package.json' }, entry] }))).toThrow(
				/file 1 .* has no path/,
			);
		}
	});

	it('refuses a missing or unusable size', () => {
		for (const size of [undefined, null, '17753', 0, -1, 1.5, Number.NaN, 2 ** 53]) {
			expect(() => normalize(npm12({ size })), String(size)).toThrow(/has no usable size/);
		}
	});

	it('refuses a third shape nobody has seen yet, rather than guessing', () => {
		expect(() => normalize({ packages: [reportBody()] })).toThrow(
			/an object with 1 entries, none of them named/,
		);
	});
});

describe('what the error says', () => {
	it('names the npm version, so the shape can be traced to a release', () => {
		expect(() =>
			normalizePackReport({ report: null, packageName: PACKAGE, npmVersion: '13.0.0' }),
		).toThrow(/npm 13\.0\.0/);
	});

	it('describes the shape without quoting the report back', () => {
		const secretish = [reportBody(), reportBody({ name: 'something-private' })];

		try {
			normalize(secretish);
			expect.unreachable('should have thrown');
		} catch (error) {
			const message = (error as Error).message;

			expect(message).toContain('an array of 2 reports');
			expect(message).not.toContain('something-private');
			expect(message).not.toContain('unpackedSize');
		}
	});
});

/**
 * The bug this parser exists to fix, stated as a test: the implementation it
 * replaced read `report[0].files`, which is `undefined` for an npm 12 object.
 */
describe('the regression that caused the failed 0.1.0 publish', () => {
	const previousImplementation = (report: unknown) =>
		(report as Array<{ files: Array<{ path: string }> }>)[0].files.map((file) => file.path);

	it('the previous implementation breaks on an npm 12 report', () => {
		expect(() => previousImplementation(npm12())).toThrow(TypeError);
	});

	it('and this one does not', () => {
		expect(normalize(npm12()).files).toEqual([...expected.files].sort());
	});
});
