import { describe, expect, it } from 'vitest';

// @ts-expect-error -- a plain ESM script, deliberately not part of the package build
import { parseReleaseArgs } from '../scripts/release.mjs';

const parse = (...argv: string[]) =>
	parseReleaseArgs(argv) as { ok: boolean; version?: string; reason?: string };

/**
 * `release-it --ci` with no version picks a patch bump on its own. That is a
 * reasonable default for a tool and the wrong one for a release: the version a
 * package goes out under should be something a person decided and typed. The
 * wrapper exists to make the argument mandatory, and this is what holds it
 * mandatory.
 */
describe('the version must be given explicitly', () => {
	it('refuses to run with no version, rather than defaulting to a patch', () => {
		const result = parse();

		expect(result.ok).toBe(false);
		expect(result.reason).toMatch(/never inferred/);
	});

	it('accepts exactly one version', () => {
		expect(parse('0.1.1')).toEqual({ ok: true, version: '0.1.1' });
		expect(parse('1.2.3')).toEqual({ ok: true, version: '1.2.3' });
		expect(parse('2.0.0-rc.1')).toEqual({ ok: true, version: '2.0.0-rc.1' });
	});

	it('refuses more than one argument', () => {
		expect(parse('0.1.1', '0.1.2').ok).toBe(false);
		expect(parse('0.1.1', '--ci').reason).toMatch(/exactly one version, got 2/);
	});

	it('refuses a flag where a version belongs', () => {
		// Reaching for release-it's own options: this wrapper forwards none.
		for (const argument of ['--ci', '--patch', '-n', '--increment=patch']) {
			const result = parse(argument);

			expect(result.ok, argument).toBe(false);
			expect(result.reason, argument).toMatch(/is a flag, not a version/);
		}
	});
});

describe('the version has to be the format this project releases', () => {
	it('refuses a v prefix', () => {
		expect(parse('v0.1.1').reason).toMatch(/carries a "v" prefix/);
	});

	it('refuses build metadata', () => {
		expect(parse('0.1.1+build.4').reason).toMatch(/carries build metadata/);
	});

	it('refuses anything that is not a semantic version', () => {
		for (const version of ['0.1', '0.1.0.0', 'latest', '01.1.0', 'next']) {
			expect(parse(version).ok, version).toBe(false);
		}
	});
});
