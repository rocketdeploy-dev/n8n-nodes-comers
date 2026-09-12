#!/usr/bin/env node
/**
 * Moves the hand-written `## Unreleased` notes into a dated section for the
 * version being released.
 *
 * This exists because the changelog here is written by people, for people: it
 * says what changed and why, not which commits landed. A generator that rebuilt
 * it from `git log` would replace that with a list nobody needs, which is what
 * the n8n CLI's release command does — it passes
 * `--hooks.after:bump="npx auto-changelog -p"` as a command-line argument, and
 * in release-it a command-line argument overrides config, so a repository cannot
 * opt out. Hence this hook, and a direct `release-it` call.
 *
 * The transformation is deliberately surgical. Everything from the previous
 * release's heading to the end of the file is carried over byte for byte: those
 * sections were written once and are not this script's business. Code blocks,
 * indentation, blank runs and trailing spaces in released notes all survive,
 * because rewriting them would be a silent edit to a published record.
 *
 * Three modes:
 *
 *   --check                    the version-independent invariants, before
 *                              release-it has touched anything
 *   --check-version <version>  everything that can be known before the bump,
 *                              so a predictable refusal leaves no changed files
 *   (no flag)                  the move itself, after the bump
 */
import { readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';

import { releaseVersionProblem } from './release-version.mjs';

const UNRELEASED_HEADING = '## Unreleased';

/** A level-two heading line, with its offset in the document. */
const headings = (changelog) => {
	const found = [];
	const pattern = /^## .*$/gmu;
	let match;

	while ((match = pattern.exec(changelog)) !== null) {
		found.push({ text: match[0], start: match.index, end: match.index + match[0].length });
	}

	return found;
};

const escapeForRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

/**
 * Whether a heading already announces this version.
 *
 * Matches `## 0.1.1`, `## 0.1.1 — 2026-09-12`, `## 0.1.1 - anything`, and not
 * `## 0.1.10`: the version has to be followed by whitespace or the line ending.
 */
const announcesVersion = (heading, version) =>
	new RegExp(`^##\\s+${escapeForRegExp(version)}(?:\\s|$)`, 'u').test(heading);

/** A real calendar date in YYYY-MM-DD, so 2026-99-99 and 2026-02-30 are refused. */
const isCalendarDate = (date) => {
	if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) {
		return false;
	}

	const [year, month, day] = date.split('-').map(Number);
	const parsed = new Date(Date.UTC(year, month - 1, day));

	return (
		parsed.getUTCFullYear() === year &&
		parsed.getUTCMonth() === month - 1 &&
		parsed.getUTCDate() === day
	);
};

/** Strips blank lines from both ends without touching anything between them. */
const trimBlankLines = (text) => text.replace(/^(?:[ \t]*\n)+/u, '').replace(/(?:\n[ \t]*)+$/u, '');

/**
 * Locates the single `## Unreleased` section and returns the notes under it,
 * along with the offsets that bound it.
 *
 * @param {string} changelog
 */
const locateUnreleased = (changelog) => {
	const all = headings(changelog);
	const matches = all.filter((heading) => heading.text.trim() === UNRELEASED_HEADING);

	if (matches.length === 0) {
		throw new Error(`CHANGELOG.md has no "${UNRELEASED_HEADING}" section to release.`);
	}

	if (matches.length > 1) {
		throw new Error(
			`CHANGELOG.md has ${matches.length} "${UNRELEASED_HEADING}" sections; there must be exactly one.`,
		);
	}

	const [unreleased] = matches;
	const next = all.find((heading) => heading.start > unreleased.start);
	const bodyEnd = next ? next.start : changelog.length;
	const notes = trimBlankLines(changelog.slice(unreleased.end, bodyEnd));

	if (notes === '') {
		throw new Error(`"${UNRELEASED_HEADING}" is empty. Write what changed before releasing.`);
	}

	return { notes, headStart: unreleased.start, tailStart: bodyEnd };
};

/**
 * The invariants that do not depend on the version.
 *
 * @param {string} changelog
 * @returns {string} the notes found under `## Unreleased`
 */
export const readUnreleasedNotes = (changelog) => locateUnreleased(changelog).notes;

/**
 * Everything that can be refused before the version is written anywhere.
 *
 * @param {{ changelog: string, version: string }} input
 */
export const assertReleasable = ({ changelog, version }) => {
	const problem = releaseVersionProblem(version);

	if (problem !== null) {
		throw new Error(`Cannot release: ${problem}.`);
	}

	locateUnreleased(changelog);

	// A heading for this version already existing means the release has been run
	// before, or the notes were dated by hand. Either way, rewriting it would
	// silently discard something.
	if (headings(changelog).some((heading) => announcesVersion(heading.text, version))) {
		throw new Error(`CHANGELOG.md already has a section for ${version}.`);
	}
};

/**
 * @param {{ changelog: string, version: string, date: string }} input
 * @returns {string} the changelog with `Unreleased` emptied and its notes dated
 */
export const finalizeChangelog = ({ changelog, version, date }) => {
	assertReleasable({ changelog, version });

	if (!isCalendarDate(date)) {
		throw new Error(`"${date}" is not a real date in YYYY-MM-DD form.`);
	}

	const { notes, headStart, tailStart } = locateUnreleased(changelog);

	// Byte for byte on both sides. Only the three joins are normalised: the one
	// before `Unreleased`, the one between it and the new section, and the one
	// before whatever followed.
	const head = changelog.slice(0, headStart).replace(/\n+$/u, '');
	const tail = changelog.slice(tailStart).replace(/^\n+/u, '');

	const rebuilt =
		`${head}\n\n${UNRELEASED_HEADING}\n\n## ${version} — ${date}\n\n${notes}\n` +
		(tail === '' ? '' : `\n${tail}`);

	return rebuilt.endsWith('\n') ? rebuilt : `${rebuilt}\n`;
};

const main = () => {
	const argv = process.argv.slice(2);
	const changelog = () => readFileSync('CHANGELOG.md', 'utf8');

	// Before release-it touches anything: is there something to release at all.
	if (argv[0] === '--check') {
		readUnreleasedNotes(changelog());
		console.log('CHANGELOG.md: Unreleased has notes to release');
		return;
	}

	// Before the bump, with the version known: every predictable refusal, so a
	// failure here leaves package.json and the lockfile untouched.
	if (argv[0] === '--check-version') {
		const version = argv[1];

		assertReleasable({ changelog: changelog(), version });
		console.log(`CHANGELOG.md: ready to release ${version}`);
		return;
	}

	const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
	const date = new Date().toISOString().slice(0, 10);

	writeFileSync('CHANGELOG.md', finalizeChangelog({ changelog: changelog(), version, date }));
	console.log(`CHANGELOG.md: Unreleased notes moved to ${version} — ${date}`);
};

if (process.argv[1] && process.argv[1].endsWith('finalize-changelog.mjs')) {
	try {
		main();
	} catch (error) {
		console.error(`Release stopped: ${error.message}`);
		process.exit(1);
	}
}
