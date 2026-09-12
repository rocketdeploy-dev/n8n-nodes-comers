/**
 * What counts as a version in this project, in one place.
 *
 * Three things need to agree about it — the release wrapper, the changelog hook
 * and the tag check the publish workflow runs — and three copies of a regular
 * expression is three chances for them to disagree.
 *
 * Semantic versioning without build metadata, and never with a `v` prefix:
 * `0.1.0`, `1.2.3`, `2.0.0-rc.1`. Build metadata is refused because nothing here
 * produces it, npm ignores it when comparing versions, and a ref filter cannot
 * exclude a `+` — three ways for a tag and a published version to stop meaning
 * the same thing, for no gain.
 */
export const RELEASE_VERSION =
	/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?$/;

/** @param {unknown} version */
export const isReleaseVersion = (version) =>
	typeof version === 'string' && RELEASE_VERSION.test(version);

/**
 * Says what is wrong with a version, or null when nothing is.
 *
 * Separate messages for the two near-misses, because "not a release version" is
 * unhelpful when the actual problem is one leading character.
 *
 * @param {unknown} version
 * @returns {string | null}
 */
export const releaseVersionProblem = (version) => {
	if (typeof version !== 'string' || version === '') {
		return 'no version was given';
	}

	if (version.startsWith('v')) {
		return `"${version}" carries a "v" prefix; releases are the bare version`;
	}

	if (version.includes('+')) {
		return `"${version}" carries build metadata, which this project does not release`;
	}

	return RELEASE_VERSION.test(version) ? null : `"${version}" is not a semantic version`;
};
