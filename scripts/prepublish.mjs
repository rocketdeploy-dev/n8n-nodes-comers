#!/usr/bin/env node
/**
 * Runs on `npm publish`, before npm builds the tarball.
 *
 * Two jobs, and deliberately no others: make sure `dist` reflects the sources
 * being published, and make sure the tarball contains what it should. It does
 * not bump a version, write a changelog, commit or tag — the publish pipeline
 * must never modify the repository it is publishing from.
 *
 * It also refuses to publish from a developer's machine. A local publish
 * carries no provenance attestation, and n8n requires one, so a package
 * published by hand could never become a verified community node — and the
 * version number would already be taken.
 */
import { execFileSync } from 'node:child_process';
import process from 'node:process';

if (!process.env.GITHUB_ACTIONS) {
	console.error(
		[
			'Refusing to publish from outside GitHub Actions.',
			'',
			'npm requires a provenance attestation for verified n8n community nodes,',
			'and only the publish workflow can produce one.',
			'',
			'To release: run `npm run release` to bump the version and push the tag.',
			'The tag starts .github/workflows/publish.yml, which publishes.',
		].join('\n'),
	);
	process.exit(1);
}

const run = (script) => {
	console.log(`prepublish: npm run ${script}`);
	execFileSync('npm', ['run', script], { stdio: 'inherit' });
};

run('build');
run('pack:check');
