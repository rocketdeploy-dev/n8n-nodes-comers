#!/usr/bin/env node
/**
 * Checks what `npm publish` would actually upload.
 *
 * `files` and `.gitignore` interact in ways that are easy to get wrong in both
 * directions: a missing icon breaks the node in the editor, and a stray file
 * publishes something that was never meant to leave the machine. This asserts
 * both ends against the tarball npm builds, not against the working copy.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import process from 'node:process';

const manifest = JSON.parse(readFileSync('package.json', 'utf8'));

const packed = JSON.parse(
	execFileSync('npm', ['pack', '--dry-run', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }),
);
const files = packed[0].files.map((file) => file.path).sort();

const failures = [];
const require = (condition, message) => {
	if (!condition) failures.push(message);
};

// Everything n8n is told to load has to be in the tarball, or the package
// installs and then fails to register.
for (const entry of [...manifest.n8n.nodes, ...manifest.n8n.credentials]) {
	require(files.includes(entry), `package.json n8n entry is not in the tarball: ${entry}`);
}

// The editor renders these; without them the node shows a broken image.
for (const icon of [
	'dist/nodes/ComersTrigger/comers.svg',
	'dist/nodes/ComersTrigger/comers.dark.svg',
	'dist/credentials/comers.svg',
	'dist/credentials/comers.dark.svg',
]) {
	require(files.includes(icon), `icon is not in the tarball: ${icon}`);
}

require(files.includes('LICENSE'), 'LICENSE is not in the tarball');
require(files.includes('README.md'), 'README.md is not in the tarball');

const forbidden = [
	[/(^|\/)test\//, 'tests'],
	[/\.test\.(ts|js)$/, 'test files'],
	[/\.tsbuildinfo$/, 'the TypeScript build cache'],
	[/(^|\/)\.env/, 'environment files'],
	[/\.(log|sqlite|db)$/, 'logs or local databases'],
	[/(^|\/)\.n8n/, 'local n8n state'],
	[/(^|\/)node_modules\//, 'node_modules'],
	[/(^|\/)\.vscode\//, 'editor configuration'],
	[/(^|\/)scripts\//, 'repository scripts'],
];

for (const file of files) {
	for (const [pattern, what] of forbidden) {
		require(!pattern.test(file), `the tarball contains ${what}: ${file}`);
	}

	// Compiled output and its declarations only: a stray .ts means sources are
	// being shipped, which is how test fixtures escape into a package.
	require(
		!file.endsWith('.ts') || file.endsWith('.d.ts'),
		`the tarball contains TypeScript source: ${file}`,
	);
}

if (failures.length > 0) {
	console.error('Tarball check failed:');
	for (const failure of failures) console.error(`  - ${failure}`);
	process.exit(1);
}

console.log(`Tarball check passed: ${files.length} files, ${packed[0].size} bytes`);
for (const file of files) console.log(`  ${file}`);
