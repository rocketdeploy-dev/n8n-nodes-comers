import { describe, expect, it } from 'vitest';

// @ts-expect-error -- Vite's ?raw suffix, which has no ambient declaration here
import manifestSource from '../package.json?raw';

/**
 * The release mechanism, asserted as configuration.
 *
 * `n8n-node release` is deliberately not used. Version 0.47.2 of the CLI passes
 * `--hooks.after:bump="npx auto-changelog -p"` as a command-line argument, and
 * in release-it a command-line argument overrides config — so a repository
 * cannot opt out, and every release would rebuild CHANGELOG.md from commit
 * subjects. That is a reasonable default for a generated changelog and the
 * wrong one for a hand-written one. This project keeps the hand-written file,
 * so it drives release-it itself.
 */
const manifest = JSON.parse(manifestSource as string) as {
	scripts: Record<string, string>;
	'release-it': {
		git: Record<string, unknown>;
		npm: Record<string, unknown>;
		github: Record<string, unknown>;
		hooks: Record<string, unknown>;
	};
};

const release = manifest['release-it'];

describe('the release command', () => {
	it('drives release-it directly rather than through the n8n CLI', () => {
		expect(manifest.scripts.release).not.toContain('n8n-node release');
	});

	it('goes through the wrapper that makes the version mandatory', () => {
		// `release-it --ci` on its own would pick a patch bump silently.
		expect(manifest.scripts.release).toBe('node scripts/release.mjs');
	});
});

describe('what the local release may and may not do', () => {
	it('never publishes to npm', () => {
		expect(release.npm.publish).toBe(false);
	});

	it('creates no GitHub release, so no GitHub token is needed to cut one', () => {
		expect(release.github.release).toBe(false);
	});

	it('commits, tags and pushes', () => {
		expect(release.git.commit).toBe(true);
		expect(release.git.tag).toBe(true);
		expect(release.git.push).toBe(true);
	});

	it('tags the bare version, with no v prefix', () => {
		expect(release.git.tagName).toBe('${version}');
		expect(release.git.tagAnnotation).toBe('Release ${version}');
	});

	it('writes the commit message the history already uses', () => {
		expect(release.git.commitMessage).toBe('chore: release ${version}');
	});
});

describe('the guards that stop a release going out of a bad state', () => {
	it('releases only from main', () => {
		expect(release.git.requireBranch).toBe('main');
	});

	it('refuses a dirty working tree', () => {
		expect(release.git.requireCleanWorkingDir).toBe(true);
	});

	it('refuses a branch with no upstream, which could not be pushed', () => {
		expect(release.git.requireUpstream).toBe(true);
	});

	it('refuses a release with nothing new in it', () => {
		expect(release.git.requireCommits).toBe(true);
	});

	it('runs the same checks the publish pipeline does, before touching anything', () => {
		expect(release.hooks['before:init']).toEqual([
			// First, so releasing with nothing written down fails while the tree
			// is still clean.
			'node scripts/finalize-changelog.mjs --check',
			'npm run lint',
			'npm run build',
			'npm test',
			'npm run scan',
			'npm run pack:check',
		]);
	});

	it('refuses everything it can before the version is written', () => {
		// release-it interpolates ${version} in before:bump, so the check that
		// needs to know the version still runs while the tree is untouched.
		expect(release.hooks['before:bump']).toBe(
			'node scripts/finalize-changelog.mjs --check-version ${version}',
		);
	});
});

describe('the changelog', () => {
	it('is finalised by this repository’s own script', () => {
		expect(release.hooks['after:bump']).toBe('node scripts/finalize-changelog.mjs');
	});

	it('is never regenerated from commit history', () => {
		// The whole reason this configuration exists.
		expect(manifestSource as string).not.toContain('auto-changelog');
	});
});
