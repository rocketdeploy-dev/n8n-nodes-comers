import { describe, expect, it } from 'vitest';

// @ts-expect-error -- a plain ESM script, deliberately not part of the package build
import { checkReleaseTag } from '../scripts/release-tag.mjs';

const check = (tag: string, version = '0.1.0') =>
	checkReleaseTag({ tag, version }) as { ok: boolean; reason?: string };

/**
 * The publish workflow runs on a tag and publishes whatever `package.json`
 * says. These two have to agree, and nothing else checks that they do.
 */
describe('the release tag', () => {
	it('passes when the tag is exactly the declared version', () => {
		expect(check('0.1.0')).toEqual({ ok: true });
		expect(check('1.2.3', '1.2.3')).toEqual({ ok: true });
		expect(check('2.0.0-rc.1', '2.0.0-rc.1')).toEqual({ ok: true });
	});

	it('refuses a tag that names a different version', () => {
		expect(check('0.1.1').ok).toBe(false);
		expect(check('0.1.1').reason).toContain('does not match');
	});

	it('refuses a v-prefixed tag, which is not what the release produces', () => {
		// release-it is pinned to the bare version in package.json. A `v` tag
		// means somebody tagged by hand, and the two halves of the release no
		// longer came from the same process.
		expect(check('v0.1.0').ok).toBe(false);
		expect(check('v0.1.0').reason).toContain('prefix');
	});

	it('refuses build metadata, which no release here produces', () => {
		// Semver allows `+…`, but nothing tags with it, npm ignores it when
		// comparing versions, and the workflow's tag filter excludes it — so a
		// tag carrying it could only mean the two halves of the release have
		// stopped agreeing.
		expect(check('1.2.3+build.4', '1.2.3').ok).toBe(false);
		expect(check('1.2.3+build.4', '1.2.3').reason).toContain('build metadata');
		expect(check('2.0.0-rc.1+sha.abc', '2.0.0-rc.1').ok).toBe(false);
		expect(check('1.2.3', '1.2.3+build.4').ok).toBe(false);
	});

	it('refuses anything that is not a version', () => {
		for (const tag of ['', 'latest', 'release-1', '0.1', '0.1.0.0', '01.1.0', 'v', '1.2.3-']) {
			expect(check(tag).ok, tag).toBe(false);
		}
	});

	it('refuses a package version that is not a release version either', () => {
		expect(check('0.1.0', '0.1.0-').ok).toBe(false);
	});


	it('says which tag and which version disagreed, so a failed run is readable', () => {
		const result = check('9.9.9', '0.1.0');

		expect(result.reason).toContain('9.9.9');
		expect(result.reason).toContain('0.1.0');
	});
});
