import { describe, expect, it } from 'vitest';

// @ts-expect-error -- a plain ESM script, deliberately not part of the package build
import {
	assertReleasable,
	finalizeChangelog,
	readUnreleasedNotes,
	// @ts-expect-error -- same
} from '../scripts/finalize-changelog.mjs';

const finalize = (changelog: string, version = '0.1.1', date = '2026-09-12') =>
	finalizeChangelog({ changelog, version, date }) as string;

const CHANGELOG = `# Changelog

## Unreleased

### Fixed

- \`delivery.deliveryAttempt\` must now be at least 1.

### Changed

- Examples use the canonical event key.

## 0.1.0 — 2026-09-11

First release.
`;

describe('moving the Unreleased notes into a dated section', () => {
	it('dates the notes under the released version', () => {
		const result = finalize(CHANGELOG);

		expect(result).toContain('## 0.1.1 — 2026-09-12');
		expect(result).toContain('- `delivery.deliveryAttempt` must now be at least 1.');
		expect(result).toContain('- Examples use the canonical event key.');
	});

	it('leaves an empty Unreleased section behind, ready for the next change', () => {
		const result = finalize(CHANGELOG);

		expect(result).toContain('# Changelog\n\n## Unreleased\n\n## 0.1.1 — 2026-09-12\n');
	});

	it('puts the new section above the older ones', () => {
		const result = finalize(CHANGELOG);

		expect(result.indexOf('## Unreleased')).toBeLessThan(result.indexOf('## 0.1.1'));
		expect(result.indexOf('## 0.1.1')).toBeLessThan(result.indexOf('## 0.1.0'));
	});

	it('works on a changelog with no previous release', () => {
		const result = finalize('# Changelog\n\n## Unreleased\n\n- The first thing.\n', '0.1.0');

		expect(result).toBe(
			'# Changelog\n\n## Unreleased\n\n## 0.1.0 — 2026-09-12\n\n- The first thing.\n',
		);
	});
});

/**
 * Everything from the previous release's heading onwards is a published record.
 * Rewriting any of it — reflowing blank lines, trimming trailing spaces,
 * touching a fenced block — would be a silent edit to something already shipped.
 */
describe('earlier releases are carried over byte for byte', () => {
	// Deliberately awkward but legal Markdown: consecutive blank lines, a fenced
	// code block with its own blank line and indentation, an indented list, and
	// trailing spaces used as a hard line break.
	const HISTORY = [
		'## 0.1.0 — 2026-09-11',
		'',
		'',
		'First release.',
		'',
		'```ts',
		'const example = {',
		'',
		'\tnested: true,',
		'};',
		'```',
		'',
		'- a list item  ',
		'  continued after a hard break',
		'    - deeply indented',
		'',
		'',
		'## 0.0.1 — 2026-09-01',
		'',
		'Older still.   ',
		'',
	].join('\n');

	const withHistory = `# Changelog\n\n## Unreleased\n\n- Something new.\n\n${HISTORY}`;

	it('reproduces the whole historical suffix exactly', () => {
		const result = finalize(withHistory);

		expect(result.endsWith(HISTORY)).toBe(true);
		expect(result.slice(result.indexOf('## 0.1.0'))).toBe(HISTORY);
	});

	it('does not collapse blank runs in released sections', () => {
		expect(finalize(withHistory)).toContain('## 0.1.0 — 2026-09-11\n\n\nFirst release.');
	});

	it('leaves a fenced code block untouched, blank line and all', () => {
		expect(finalize(withHistory)).toContain('```ts\nconst example = {\n\n\tnested: true,\n};\n```');
	});

	it('keeps trailing spaces, which are a hard line break in Markdown', () => {
		expect(finalize(withHistory)).toContain('- a list item  \n  continued after a hard break');
		expect(finalize(withHistory)).toContain('Older still.   \n');
	});

	it('keeps indentation', () => {
		expect(finalize(withHistory)).toContain('    - deeply indented');
	});
});

describe('the notes being moved keep their own formatting', () => {
	const notes = [
		'### Fixed',
		'',
		'- One thing.',
		'',
		'  ```sh',
		'  npm run release -- 0.1.1',
		'  ```',
		'',
		'',
		'- Another, after two blank lines.',
	].join('\n');

	it('moves them verbatim', () => {
		const result = finalize(`# Changelog\n\n## Unreleased\n\n${notes}\n\n## 0.1.0 — 2026-09-11\n\nOld.\n`);

		expect(result).toContain(`## 0.1.1 — 2026-09-12\n\n${notes}\n`);
	});
});

describe('formatting is stable', () => {
	it('ends with exactly one newline', () => {
		const result = finalize(CHANGELOG);

		expect(result.endsWith('\n')).toBe(true);
		expect(result.endsWith('\n\n')).toBe(false);
	});

	it('adds a trailing newline when the source lacked one', () => {
		expect(finalize('# Changelog\n\n## Unreleased\n\n- Thing.').endsWith('- Thing.\n')).toBe(true);
	});

	it('releasing twice in a row stays tidy', () => {
		const once = finalize(CHANGELOG);
		const twice = finalizeChangelog({
			changelog: once.replace('## Unreleased\n', '## Unreleased\n\n- Another change.\n'),
			version: '0.1.2',
			date: '2026-09-13',
		}) as string;

		expect(twice).toContain('# Changelog\n\n## Unreleased\n\n## 0.1.2 — 2026-09-13\n');
		expect(twice).toContain('- Another change.');
		expect(twice).toContain('## 0.1.1 — 2026-09-12');
		expect(twice).toContain('## 0.1.0 — 2026-09-11');
	});
});

describe('the checks that run before anything is touched', () => {
	it('returns the notes when there are some', () => {
		expect(readUnreleasedNotes(CHANGELOG) as string).toContain(
			'- `delivery.deliveryAttempt` must now be at least 1.',
		);
	});

	it('refuses an empty Unreleased without needing to know the version', () => {
		expect(() =>
			readUnreleasedNotes('# Changelog\n\n## Unreleased\n\n## 0.1.0 — 2026-09-11\n\nOld.\n'),
		).toThrow(/is empty/);
	});

	it('refuses a missing or duplicated Unreleased', () => {
		expect(() => readUnreleasedNotes('# Changelog\n\n## 0.1.0 — 2026-09-11\n\nOld.\n')).toThrow(
			/no "## Unreleased" section/,
		);
		expect(() =>
			readUnreleasedNotes('# Changelog\n\n## Unreleased\n\n- a\n\n## Unreleased\n\n- b\n'),
		).toThrow(/2 "## Unreleased" sections/);
	});
});

/**
 * These run as `--check-version` in release-it's `before:bump`, where the
 * version is known and nothing has been written yet — so every predictable
 * refusal leaves the working tree exactly as it was.
 */
describe('the checks that run before the version is written', () => {
	const check = (changelog: string, version: string) =>
		assertReleasable({ changelog, version });

	it('passes for a version that has notes and no section yet', () => {
		expect(() => check(CHANGELOG, '0.1.1')).not.toThrow();
	});

	it('refuses a version that already has a section', () => {
		expect(() => check(CHANGELOG, '0.1.0')).toThrow(/already has a section for 0\.1\.0/);
	});

	it('recognises a version heading with or without a date', () => {
		const bare = '# Changelog\n\n## Unreleased\n\n- New.\n\n## 0.1.1\n\nUndated.\n';
		const dashed = '# Changelog\n\n## Unreleased\n\n- New.\n\n## 0.1.1 - 2026-09-11\n\nDashed.\n';
		const emdash = '# Changelog\n\n## Unreleased\n\n- New.\n\n## 0.1.1 — 2026-09-11\n\nEm.\n';

		for (const changelog of [bare, dashed, emdash]) {
			expect(() => check(changelog, '0.1.1')).toThrow(/already has a section/);
		}
	});

	it('does not mistake 0.1.10 for 0.1.1', () => {
		const other = '# Changelog\n\n## Unreleased\n\n- New.\n\n## 0.1.10 — 2026-09-11\n\nLater.\n';

		expect(() => check(other, '0.1.1')).not.toThrow();
	});

	it('refuses a version that is not a version', () => {
		for (const version of ['', '0.1', '0.1.0.0', 'latest', '01.1.0']) {
			expect(() => check(CHANGELOG, version), version).toThrow(/Cannot release/);
		}
	});

	it('refuses a v prefix and says why', () => {
		expect(() => check(CHANGELOG, 'v0.1.1')).toThrow(/carries a "v" prefix/);
	});

	it('refuses build metadata and says why', () => {
		expect(() => check(CHANGELOG, '0.1.1+build.4')).toThrow(/carries build metadata/);
	});

	it('accepts a prerelease version', () => {
		expect(() => check(CHANGELOG, '0.2.0-rc.1')).not.toThrow();
	});
});

describe('the date', () => {
	it('accepts a real one', () => {
		expect(finalize(CHANGELOG, '0.1.1', '2026-02-28')).toContain('## 0.1.1 — 2026-02-28');
	});

	it('accepts a leap day in a leap year', () => {
		expect(finalize(CHANGELOG, '0.1.1', '2028-02-29')).toContain('## 0.1.1 — 2028-02-29');
	});

	it('refuses a date that does not exist', () => {
		for (const date of ['2026-99-99', '2026-02-30', '2026-13-01', '2026-00-10', '2027-02-29']) {
			expect(() => finalize(CHANGELOG, '0.1.1', date), date).toThrow(/is not a real date/);
		}
	});

	it('refuses a date in the wrong shape', () => {
		for (const date of ['12-09-2026', '2026-9-12', '20260912', 'today', '']) {
			expect(() => finalize(CHANGELOG, '0.1.1', date), date).toThrow(/is not a real date/);
		}
	});
});
