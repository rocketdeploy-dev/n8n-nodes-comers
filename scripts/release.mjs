#!/usr/bin/env node
/**
 * The release entry point: `npm run release -- 0.1.1`.
 *
 * It exists to make the version mandatory. `release-it --ci` on its own picks a
 * patch bump silently, which is a fine default for a tool and the wrong one for
 * a release: the version a package is published under should be something a
 * person decided and typed, not something inferred from the absence of an
 * argument. So this refuses to run without exactly one explicit version.
 *
 * Beyond that it does nothing. It does not commit, tag, push or publish —
 * release-it does all of that, configured in the `release-it` block of
 * package.json.
 */
import { spawnSync } from 'node:child_process';
import process from 'node:process';

import { releaseVersionProblem } from './release-version.mjs';

const USAGE = 'usage: npm run release -- <version>        e.g. npm run release -- 0.1.1';

/**
 * Decides what to do with the arguments, without doing it — so the rules can be
 * tested without spawning anything.
 *
 * @param {string[]} argv arguments after the script name
 * @returns {{ ok: true, version: string } | { ok: false, reason: string }}
 */
export const parseReleaseArgs = (argv) => {
	if (argv.length === 0) {
		return {
			ok: false,
			reason: 'No version given. The version is never inferred: pass it explicitly.',
		};
	}

	if (argv.length > 1) {
		return {
			ok: false,
			reason: `Expected exactly one version, got ${argv.length}: ${argv.join(' ')}`,
		};
	}

	const [version] = argv;

	// A flag where a version belongs is almost always someone reaching for
	// release-it's own options, which this wrapper deliberately does not forward.
	if (version.startsWith('-')) {
		return {
			ok: false,
			reason: `"${version}" is a flag, not a version. This command takes a version and nothing else.`,
		};
	}

	const problem = releaseVersionProblem(version);

	return problem === null ? { ok: true, version } : { ok: false, reason: problem };
};

const main = () => {
	const parsed = parseReleaseArgs(process.argv.slice(2));

	if (!parsed.ok) {
		console.error(`${parsed.reason}\n${USAGE}`);
		process.exit(1);
	}

	// No shell: the version is already validated, but a command line assembled
	// for a shell is a habit worth not having.
	const release = spawnSync('release-it', ['--ci', parsed.version], { stdio: 'inherit' });

	if (release.error) {
		console.error(`Could not run release-it: ${release.error.message}`);
		process.exit(1);
	}

	if (release.signal) {
		process.kill(process.pid, release.signal);
	}

	process.exit(release.status ?? 1);
};

if (process.argv[1] && process.argv[1].endsWith('release.mjs')) {
	main();
}
