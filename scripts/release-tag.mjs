#!/usr/bin/env node
/**
 * Checks that a release tag names the version the package actually declares.
 *
 * The two halves of a release are produced in different places: `npm run
 * release` bumps `package.json`, commits and tags locally, and the publish
 * workflow reacts to that tag. Nothing but this check ties them together, and
 * without it a tag pushed by hand, or a workflow re-run against a moved tag,
 * would publish a version nobody named.
 *
 * The accepted format is the one `release-it` is pinned to in package.json:
 * the bare version, no `v` prefix.
 *
 *   accepted   0.1.0, 1.2.3, 2.0.0-rc.1
 *   refused    v0.1.0, 1.2.3+build.4, a tag that names another version,
 *              anything that is not semantic versioning
 *
 * Build metadata is refused deliberately, even though semver allows it. A tag
 * carrying `+…` is not something any release here produces, npm ignores the
 * metadata when comparing versions, and the `+` would have to be threaded
 * through the workflow's tag filter as well — three ways for the tag and the
 * published version to stop meaning the same thing, for no gain.
 *
 * Left unpinned, release-it infers the `v` prefix from whatever the newest
 * existing tag happens to look like, which is not something a publish trigger
 * should depend on.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/**
 * Semantic versioning without build metadata, which is exactly what release-it
 * produces here: `0.1.0`, `1.2.3`, `2.0.0-rc.1`.
 */
const RELEASE_VERSION =
	/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?$/;

/**
 * @param {{ tag: string, version: string }} release
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export const checkReleaseTag = ({ tag, version }) => {
	if (!tag) {
		return { ok: false, reason: 'No tag was given. This workflow only runs on a version tag.' };
	}

	if (tag.startsWith('v')) {
		return {
			ok: false,
			reason: `Tag "${tag}" carries a "v" prefix. Releases are tagged with the bare version, as "${version}".`,
		};
	}

	if (tag.includes('+')) {
		return {
			ok: false,
			reason: `Tag "${tag}" carries build metadata. Releases are tagged with the version alone, as "${version}".`,
		};
	}

	if (!RELEASE_VERSION.test(tag)) {
		return { ok: false, reason: `Tag "${tag}" is not a release version.` };
	}

	if (!RELEASE_VERSION.test(version)) {
		return {
			ok: false,
			reason: `package.json version "${version}" is not a release version.`,
		};
	}

	if (tag !== version) {
		return {
			ok: false,
			reason: `Tag "${tag}" does not match package.json version "${version}". Publishing would release a version nobody tagged.`,
		};
	}

	return { ok: true };
};

const main = () => {
	const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME ?? '';
	const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
	const result = checkReleaseTag({ tag, version });

	if (!result.ok) {
		console.error(`Release tag check failed: ${result.reason}`);
		process.exit(1);
	}

	console.log(`Release tag check passed: tag ${tag} matches package.json version ${version}`);
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main();
}
