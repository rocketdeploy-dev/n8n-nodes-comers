/**
 * Reading the one report `npm pack --json` produces for this package.
 *
 * The shape is not stable across npm majors. npm 11 and earlier answer with an
 * array of reports; npm 12 answers with an object keyed by package name:
 *
 *   npm 11   [ { name, files, size, … } ]
 *   npm 12   { "@scope/name": { name, files, size, … } }
 *
 * Both are read here, and anything that is neither fails loudly. A parser that
 * shrugged at an unfamiliar shape would be worse than none: the tarball check
 * built on it would pass while checking nothing, which is exactly the state it
 * exists to prevent.
 *
 * Kept pure and separate from the check itself so every shape — including the
 * ones no npm produces — can be put through it in a test.
 */

/** Describes a value without quoting it back, so a report never reaches a log. */
const describe = (value) => {
	if (value === null) return 'null';
	if (Array.isArray(value)) {
		return value.length === 0 ? 'an empty array' : `an array of ${value.length} reports`;
	}
	if (typeof value !== 'object') return `a ${typeof value}`;

	const keys = Object.keys(value);

	return keys.length === 0 ? 'an empty object' : `an object with ${keys.length} entries`;
};

const fail = (npmVersion, detail) => {
	throw new Error(
		`Could not read \`npm pack --json\` (npm ${npmVersion}): ${detail}. ` +
			'Its output shape may have changed again.',
	);
};

/**
 * Picks this package's report out of whatever npm returned, and checks it says
 * what the caller needs: a list of file paths and a size.
 *
 * @param {{ report: unknown, packageName: string, npmVersion: string }} input
 * @returns {{ files: string[], size: number }}
 */
export const normalizePackReport = ({ report, packageName, npmVersion }) => {
	if (report === null || typeof report !== 'object') {
		fail(npmVersion, `expected an array or an object, got ${describe(report)}`);
	}

	let packed;

	if (Array.isArray(report)) {
		// This repository publishes exactly one package. More than one report
		// means npm packed something nobody asked for, and picking one of them
		// would be a guess.
		if (report.length !== 1) {
			fail(npmVersion, `expected exactly one report, got ${describe(report)}`);
		}

		packed = report[0];
	} else {
		// Keyed by package name. Look the name up rather than taking a first
		// key, which is only ever right by accident.
		if (!Object.prototype.hasOwnProperty.call(report, packageName)) {
			fail(
				npmVersion,
				`${describe(report)}, none of them named ${packageName}`,
			);
		}

		packed = report[packageName];
	}

	if (packed === null || typeof packed !== 'object' || Array.isArray(packed)) {
		fail(npmVersion, `the report for ${packageName} is ${describe(packed)}`);
	}

	if (!Array.isArray(packed.files) || packed.files.length === 0) {
		fail(npmVersion, `the report for ${packageName} has no list of files`);
	}

	const files = packed.files.map((file, index) => {
		if (file === null || typeof file !== 'object' || typeof file.path !== 'string' || file.path.length === 0) {
			fail(npmVersion, `file ${index} in the report for ${packageName} has no path`);
		}

		return file.path;
	});

	if (!Number.isSafeInteger(packed.size) || packed.size <= 0) {
		fail(npmVersion, `the report for ${packageName} has no usable size`);
	}

	return { files: files.sort(), size: packed.size };
};
