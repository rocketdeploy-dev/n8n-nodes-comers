#!/usr/bin/env node
/**
 * Runs the official n8n community-package scanner against this working copy.
 *
 * `npx @n8n/scan-community-package <name>` downloads the package from npm and
 * needs a provenance attestation, so it can only judge something already
 * published. The scanner exports the analysis itself, which is what this calls,
 * so the same rules gate the package before it is released rather than after.
 *
 * `SOURCE_FILE_PATTERNS` is the scanner's own list of what belongs to a
 * published package: package.json plus the node and credential sources.
 */
import path from 'node:path';
import process from 'node:process';

import {
	analyzePackage,
	SOURCE_FILE_PATTERNS,
} from '@n8n/scan-community-package/scanner/scanner.mjs';

const packageDir = path.resolve(process.argv[2] ?? '.');
const result = await analyzePackage(packageDir, SOURCE_FILE_PATTERNS);

if (result.passed) {
	console.log(`n8n community package scan passed for ${packageDir}`);
	process.exit(0);
}

console.error(`n8n community package scan failed: ${result.message}`);

if (result.details) {
	console.error(result.details);
}

process.exit(1);
