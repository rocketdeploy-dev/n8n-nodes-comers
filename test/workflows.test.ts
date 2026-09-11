import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

// @ts-expect-error -- a plain ESM script, deliberately not part of the package build
import { checkReleaseTag } from '../scripts/release-tag.mjs';

// Imported as text rather than read from disk: community nodes may not touch
// the filesystem, and the linter holds the tests to that too.
// @ts-expect-error -- Vite's ?raw suffix, which has no ambient declaration here
import ciSource from '../.github/workflows/ci.yml?raw';
// @ts-expect-error -- Vite's ?raw suffix, which has no ambient declaration here
import publishSource from '../.github/workflows/publish.yml?raw';

/**
 * The release workflows, read as data.
 *
 * Publishing is the one thing here that cannot be rehearsed: it happens once
 * per version, against the real registry, and a mistake in it is either a
 * leaked credential or a release that never happens. So the properties that
 * matter are asserted against the workflow file rather than trusted to review.
 */
interface Step {
	name?: string;
	uses?: string;
	run?: string;
	if?: string;
	env?: Record<string, string>;
	with?: Record<string, unknown>;
}

interface Workflow {
	on: Record<string, unknown>;
	jobs: Record<
		string,
		{
			'runs-on': string;
			permissions?: Record<string, string>;
			env?: Record<string, string>;
			steps: Step[];
		}
	>;
	env?: Record<string, string>;
}

const read = (source: string) => ({
	source,
	workflow: parse(source) as Workflow,
});

/**
 * A GitHub ref filter as a regular expression.
 *
 * The syntax is glob-like but its own: `*` matches anything but a slash, `?`
 * one optional character, `+` one or more of whatever precedes it, `[…]` a
 * character range. Everything else, `.` and `-` included, is a literal — which
 * is also why a filter cannot exclude a tag for containing a `+`.
 */
const githubRefFilter = (filter: string): RegExp => {
	let pattern = '';

	for (let index = 0; index < filter.length; index += 1) {
		const character = filter[index];

		if (character === '[') {
			const close = filter.indexOf(']', index);
			pattern += filter.slice(index, close + 1);
			index = close;
		} else if (character === '*') {
			pattern += '[^/]*';
		} else if (character === '?') {
			pattern += '[^/]?';
		} else if (character === '+') {
			pattern += '+';
		} else {
			pattern += character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		}
	}

	return new RegExp(`^${pattern}$`);
};

/** One npm for both workflows; see "the npm both workflows run" below. */
const PINNED_NPM = '12.0.2';

describe('the publish workflow', () => {
	const { source, workflow } = read(publishSource as string);
	const job = workflow.jobs.publish;
	const steps = job.steps;
	const publishSteps = steps.filter((step) => step.run?.includes('npm publish'));

	it('has exactly one way to publish', () => {
		// There was a second one once: a token-authenticated step that existed
		// only because Trusted Publishing cannot be configured for a package
		// that does not exist yet. 0.1.0 exists, so it is gone.
		expect(publishSteps).toHaveLength(1);
	});

	it('publishes publicly, with provenance', () => {
		expect(publishSteps[0].run?.trim()).toBe('npm publish --access public --provenance');
	});

	it('runs unconditionally, with no special case for any one version', () => {
		expect(publishSteps[0].if).toBeUndefined();
	});

	it('carries no credential into the publish step', () => {
		expect(publishSteps[0].env).toBeUndefined();
	});

	it('references no secret anywhere, so there is none to leak or rotate', () => {
		expect(source).not.toMatch(/secrets\./);
		expect(source).not.toMatch(/NODE_AUTH_TOKEN/);
		expect(source).not.toMatch(/NPM_TOKEN/);
		expect(workflow.env).toBeUndefined();
		expect(job.env).toBeUndefined();

		for (const step of steps) {
			expect(JSON.stringify(step.env ?? {})).not.toMatch(/TOKEN|secrets\./);
		}
	});

	it('authenticates over OIDC, which needs exactly these permissions', () => {
		expect(job.permissions).toEqual({ 'id-token': 'write', contents: 'read' });
	});

	it('never prints a secret', () => {
		for (const step of steps) {
			expect(step.run ?? '').not.toMatch(/echo\s+.*\$\{\{\s*secrets\./);
		}
	});

	it('publishes only from a GitHub-hosted runner', () => {
		expect(job['runs-on']).toBe('ubuntu-latest');
	});

	it('verifies everything before it publishes', () => {
		const gates = [
			'npm ci',
			'npm run lint',
			'npm run build',
			'npm test',
			'npm run scan',
			'npm run pack:check',
			'npm run check:tag',
		];
		const scripts = steps.map((step) => step.run ?? '').join('\n');
		const firstPublish = steps.findIndex((step) => step.run?.includes('npm publish'));

		for (const gate of gates) {
			expect(scripts, gate).toContain(gate);

			const at = steps.findIndex((step) => (step.run ?? '').includes(gate));

			expect(at, `${gate} must run before publishing`).toBeLessThan(firstPublish);
		}
	});

	it('checks the tag against package.json immediately before publishing', () => {
		const check = steps.findIndex((step) => step.run?.includes('npm run check:tag'));
		const publish = steps.findIndex((step) => step.run?.includes('npm publish'));

		expect(publish).toBe(check + 1);
	});

	it('never runs the local release process, which versions and tags', () => {
		expect(source).not.toMatch(/^\s*run:.*npm run release/m);
	});

	it('runs only on the release tag format', () => {
		expect((workflow.on as { push: { tags: string[] } }).push.tags).toEqual([
			'[0-9]+.[0-9]+.[0-9]+',
			'[0-9]+.[0-9]+.[0-9]+-*',
		]);
	});

	/**
	 * The filter decides whether a run starts; `check:tag` decides whether it
	 * may publish. If the check accepted a tag the filter ignores, that release
	 * would silently never happen — so the check has to be the stricter of the
	 * two. Asserted against the filters as written, not against a copy of them.
	 */
	it('accepts no tag the filter would ignore', () => {
		const filters = (workflow.on as { push: { tags: string[] } }).push.tags;
		const matchesFilter = (tag: string) =>
			filters.some((filter) => githubRefFilter(filter).test(tag));
		const accepted = (tag: string) =>
			(checkReleaseTag({ tag, version: tag }) as { ok: boolean }).ok;

		for (const tag of [
			'0.1.0',
			'1.2.3',
			'10.20.30',
			'2.0.0-rc.1',
			'v0.1.0',
			'1.2.3+build.4',
			'2.0.0-rc.1+sha.abc',
			'latest',
			'0.1',
			'1.2.3-',
			'release-1',
		]) {
			if (accepted(tag)) {
				expect(matchesFilter(tag), `${tag} is accepted but the filter ignores it`).toBe(true);
			}
		}

		// The filter is the looser of the two, on purpose: a ref filter cannot
		// exclude a tag for carrying build metadata, because `+` is a
		// quantifier there rather than a literal. Such a tag starts a run and
		// then fails the check, which is the right way round.
		expect(matchesFilter('2.0.0-rc.1+sha.abc')).toBe(true);
		expect(accepted('2.0.0-rc.1+sha.abc')).toBe(false);
		expect(matchesFilter('1.2.3+build.4')).toBe(false);
	});
});

/**
 * Verifying a pull request on one npm and publishing on another is how the npm
 * 12 change to `npm pack --json` reached the publish workflow without CI ever
 * seeing it. The two run the same npm now, and this is what keeps them there.
 */
describe('the npm both workflows run', () => {
	const pinStep = (workflow: Workflow) =>
		Object.values(workflow.jobs)[0].steps.find((step) =>
			/npm install --global npm@/.test(step.run ?? ''),
		);

	const ci = parse(ciSource as string) as Workflow;
	const publish = parse(publishSource as string) as Workflow;

	const version = (step: Step | undefined) =>
		/npm install --global npm@(\S+)/.exec(step?.run ?? '')?.[1];

	it('is pinned to one exact version in both', () => {
		expect(version(pinStep(ci))).toBe(PINNED_NPM);
		expect(version(pinStep(publish))).toBe(PINNED_NPM);
	});

	it('is never `latest`, which is what let the two drift apart', () => {
		for (const workflow of [ci, publish]) {
			for (const step of Object.values(workflow.jobs)[0].steps) {
				expect(step.run ?? '').not.toMatch(/npm install --global npm@latest/);
				expect(step.run ?? '').not.toMatch(/npm@latest/);
			}
		}
	});

	it('is installed before the dependencies it resolves', () => {
		for (const workflow of [ci, publish]) {
			const steps = Object.values(workflow.jobs)[0].steps;
			const pinned = steps.findIndex((step) => /npm install --global npm@/.test(step.run ?? ''));
			const install = steps.findIndex((step) => /^npm ci\b/m.test(step.run ?? ''));

			expect(pinned).toBeGreaterThan(-1);
			expect(install).toBeGreaterThan(pinned);
		}
	});

	it('reports the toolchain without reporting anything else', () => {
		for (const workflow of [ci, publish]) {
			const report = Object.values(workflow.jobs)[0].steps.find(
				(step) => step.name === 'Report the toolchain',
			);

			expect(report?.run?.trim().split('\n').map((line) => line.trim())).toEqual([
				'node --version',
				'npm --version',
			]);
		}
	});
});

describe('the CI workflow', () => {
	const { source, workflow } = read(ciSource as string);
	const job = workflow.jobs.verify;

	it('runs the same gates as the publish workflow', () => {
		const scripts = job.steps.map((step) => step.run ?? '').join('\n');

		for (const script of [
			'npm ci',
			'npm run lint',
			'npm run build',
			'npm test',
			'npm run scan',
			'npm run pack:check',
		]) {
			expect(scripts, script).toContain(script);
		}
	});

	it('never releases or publishes', () => {
		expect(source).not.toMatch(/^\s*run:.*npm run release/m);
		expect(source).not.toContain('npm publish');
	});

	it('uses no secrets at all', () => {
		expect(source).not.toContain('secrets.');
		expect(source).not.toMatch(/NODE_AUTH_TOKEN|NPM_TOKEN/);
	});
});
