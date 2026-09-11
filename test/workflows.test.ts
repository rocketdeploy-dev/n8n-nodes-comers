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

const BOOTSTRAP_TAG = '0.1.0';
const BOOTSTRAP_SECRET = 'NPM_BOOTSTRAP_TOKEN';

describe('the publish workflow', () => {
	const { source, workflow } = read(publishSource as string);
	const job = workflow.jobs.publish;
	const steps = job.steps;
	const publishSteps = steps.filter((step) => step.run?.includes('npm publish'));
	const bootstrap = publishSteps.find((step) => step.if?.includes('=='));
	const trusted = publishSteps.find((step) => step.if?.includes('!='));

	it('has exactly two publish paths', () => {
		expect(publishSteps).toHaveLength(2);
		expect(bootstrap).toBeDefined();
		expect(trusted).toBeDefined();
	});

	it('takes one path or the other, never both and never neither', () => {
		// Complementary conditions on the same expression: whatever the tag is,
		// exactly one of these is true.
		expect(bootstrap!.if).toBe(`github.ref_name == '${BOOTSTRAP_TAG}'`);
		expect(trusted!.if).toBe(`github.ref_name != '${BOOTSTRAP_TAG}'`);
	});

	it('publishes the same way on both paths', () => {
		for (const step of publishSteps) {
			expect(step.run).toContain('npm publish --access public --provenance');
		}
	});

	it('gives the bootstrap token to the bootstrap step and nothing else', () => {
		expect(bootstrap!.env).toEqual({
			NODE_AUTH_TOKEN: `\${{ secrets.${BOOTSTRAP_SECRET} }}`,
		});

		// Not the workflow, not the job, not any other step: a credential that
		// only one step may use must only be reachable from that step.
		expect(workflow.env).toBeUndefined();
		expect(job.env).toBeUndefined();

		const elsewhere = steps
			.filter((step) => step !== bootstrap)
			.filter((step) => JSON.stringify(step.env ?? {}).includes(BOOTSTRAP_SECRET));

		expect(elsewhere).toEqual([]);
	});

	it('references no secret other than the bootstrap token', () => {
		const secrets = [...source.matchAll(/secrets\.([A-Za-z_][A-Za-z0-9_]*)/g)].map(
			(match) => match[1],
		);

		expect([...new Set(secrets)]).toEqual([BOOTSTRAP_SECRET]);
	});

	it('has no general NPM_TOKEN, which is what Trusted Publishing replaces', () => {
		expect(source).not.toMatch(/secrets\.NPM_TOKEN\b/);
		expect(source).not.toMatch(/NODE_AUTH_TOKEN:\s*\$\{\{\s*secrets\.NPM_TOKEN\s*\}\}/);
	});

	it('fails outright when the bootstrap token is missing, rather than trying OIDC', () => {
		// Falling through to the other path could not work either — there is no
		// Trusted Publisher on a package that does not exist — and would turn a
		// setup mistake into an unrecognisable npm error.
		expect(bootstrap!.run).toMatch(/if \[ -z "\$\{NODE_AUTH_TOKEN\}" \]; then/);
		expect(bootstrap!.run).toContain('exit 1');
		expect(bootstrap!.run).toContain(BOOTSTRAP_SECRET);
	});

	it('leaves every later release authenticating over OIDC alone', () => {
		expect(trusted!.env).toBeUndefined();
		expect(job.permissions).toEqual({ 'id-token': 'write', contents: 'read' });
	});

	it('never prints a secret', () => {
		for (const step of steps) {
			expect(step.run ?? '').not.toMatch(/echo\s+.*NODE_AUTH_TOKEN/);
			expect(step.run ?? '').not.toMatch(/echo\s+.*\$\{\{\s*secrets\./);
		}
	});

	it('publishes only from a GitHub-hosted runner', () => {
		expect(job['runs-on']).toBe('ubuntu-latest');
	});

	it('verifies before it publishes', () => {
		const scripts = steps.map((step) => step.run ?? '').join('\n');

		for (const script of [
			'npm ci',
			'npm run lint',
			'npm run build',
			'npm test',
			'npm run scan',
			'npm run pack:check',
			'npm run check:tag',
		]) {
			expect(scripts, script).toContain(script);
		}

		const lastCheck = steps.findIndex((step) => step.run?.includes('npm run check:tag'));
		const firstPublish = steps.findIndex((step) => step.run?.includes('npm publish'));

		expect(lastCheck).toBeGreaterThan(-1);
		expect(firstPublish).toBeGreaterThan(lastCheck);
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
	});
});
