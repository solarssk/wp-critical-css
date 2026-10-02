import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { evaluateDeclaration, isAutomatedDependencyPr, isDocumentationFile, loadPullRequest } from './check-pr-docs-impact.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'check-pr-docs-impact.mjs');
const TEMPLATE_COMMENT = '<!--\nChoose exactly one option.\n- [x] Docs updated\n-->';
const CI_FILE = ['.github/workflows/ci.yml'];
const REAL_REASON = 'CI-only change, nothing user-visible';
const directories = [];

after(() => {
	for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

function body(docsUpdated, noUpdate, reason = 'explain why') {
	return `## Description\n\nSomething.\n\n## Documentation impact\n\n${TEMPLATE_COMMENT}\n\n- [${docsUpdated}] Docs updated\n- [${noUpdate}] No doc update needed - ${reason}\n\n---\n\n## Checklist\n\n- [x] Done\n`;
}

describe('evaluateDeclaration', () => {
	it('accepts "Docs updated" with a documentation file in the diff', () => {
		assert.deepEqual(evaluateDeclaration(body('x', ' '), ['service/lib.js', 'docs/wiki/Home.md']), []);
		assert.deepEqual(evaluateDeclaration(body('X', ' '), ['CHANGELOG.md']), []);
	});

	it('accepts "No doc update needed" with a real reason and no wiki change', () => {
		assert.deepEqual(evaluateDeclaration(body(' ', 'x', REAL_REASON), CI_FILE), []);
	});

	it('rejects "Docs updated" when no documentation file changed', () => {
		const problems = evaluateDeclaration(body('x', ' '), ['service/lib.js']);
		assert.equal(problems.length, 1);
		assert.match(problems[0], /changes no documentation file/);
	});

	it('rejects ticking both lines, or neither', () => {
		assert.match(evaluateDeclaration(body('x', 'x', 'a real reason here'), ['docs/a.md'])[0], /Both/);
		assert.match(evaluateDeclaration(body(' ', ' '), ['docs/a.md'])[0], /Neither/);
	});

	it('rejects a description that lost a template line or the whole section', () => {
		assert.match(evaluateDeclaration('## Documentation impact\n\n- [x] Docs updated\n', ['docs/a.md'])[0], /Keep both lines/);
		assert.match(evaluateDeclaration('- [x] Docs updated\n- [ ] No doc update needed - x\n', ['docs/a.md'])[0], /Keep both lines/);
		assert.match(evaluateDeclaration('', [])[0], /Keep both lines/);
	});

	it('only reads the declaration inside its own section', () => {
		const elsewhere = '## Description\n\n- [x] Docs updated\n- [ ] No doc update needed - x\n\n## Documentation impact\n\n- [ ] Docs updated\n- [x] No doc update needed - CI-only change, nothing user-visible\n';
		assert.deepEqual(evaluateDeclaration(elsewhere, CI_FILE), []);
		const after = '## Documentation impact\n\n- [ ] Docs updated\n- [ ] No doc update needed - x\n\n## Checklist\n\n- [x] Docs updated\n';
		assert.match(evaluateDeclaration(after, ['docs/a.md'])[0], /Neither/);
	});

	it('ignores a declaration that only exists inside an HTML comment', () => {
		const hidden = '## Documentation impact\n\n<!-- - [x] Docs updated\n- [ ] No doc update needed - nope -->\n';
		assert.match(evaluateDeclaration(hidden, ['docs/a.md'])[0], /Keep both lines/);
		assert.match(evaluateDeclaration('## Documentation impact\n\n<!-- never closed\n- [x] Docs updated', [])[0], /Keep both lines/);
	});

	it('rejects "No doc update needed" without a real reason', () => {
		for (const reason of ['', 'explain why', 'Explain why.', '..........', 'n/a', 'not needed']) {
			const problems = evaluateDeclaration(body(' ', 'x', reason), CI_FILE);
			assert.equal(problems.length, 1, `reason ${JSON.stringify(reason)}`);
			assert.match(problems[0], /specific reason/);
		}
	});

	it('accepts the reason after an en dash, an em dash or a colon', () => {
		for (const separator of ['–', '—', ':']) {
			const text = `## Documentation impact\n\n- [ ] Docs updated\n- [x] No doc update needed ${separator} ${REAL_REASON}\n`;
			assert.deepEqual(evaluateDeclaration(text, CI_FILE), [], separator);
		}
	});

	it('rejects "No doc update needed" when docs/wiki changed, also by a rename out of it', () => {
		const problems = evaluateDeclaration(body(' ', 'x', REAL_REASON), ['docs/wiki/Home.md']);
		assert.equal(problems.length, 1);
		assert.match(problems[0], /docs\/wiki changed/);
		assert.equal(evaluateDeclaration(body(' ', 'x', REAL_REASON), ['docs/guides/Home.md', 'docs/wiki/Home.md']).length, 1);
	});

	it('reports both problems when the reason is missing and docs/wiki changed', () => {
		assert.equal(evaluateDeclaration(body(' ', 'x'), ['docs/wiki/Home.md']).length, 2);
	});
});

describe('isDocumentationFile', () => {
	it('recognises documentation, and nothing else', () => {
		for (const path of ['docs/ARCHITECTURE.md', 'docs/wiki/Home.md', 'README.md', 'CHANGELOG.md', '.github/release-notes/v1.0.0.md', 'wordpress-plugin/wp-critical-css/readme.txt', '.env.example']) {
			assert.equal(isDocumentationFile(path), true, path);
		}
		for (const path of ['service/lib.js', '.github/workflows/ci.yml', 'service/Dockerfile', 'scripts/check-wiki-docs.mjs']) {
			assert.equal(isDocumentationFile(path), false, path);
		}
	});
});

describe('isAutomatedDependencyPr', () => {
	it('matches Dependabot and Renovate by their login, and nobody else', () => {
		assert.equal(isAutomatedDependencyPr({ author: 'dependabot[bot]' }), true);
		assert.equal(isAutomatedDependencyPr({ author: 'renovate[bot]' }), true);
		assert.equal(isAutomatedDependencyPr({ author: 'solarssk' }), false);
		assert.equal(isAutomatedDependencyPr({ author: 'someone', headRef: 'dependabot/npm_and_yarn/x' }), false);
	});
});

function response(status, payload) {
	return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

describe('loadPullRequest', () => {
	const pull = { body: 'the description', user: { login: 'solarssk' }, head: { ref: 'docs/x' } };

	it('reads the description, author and every page of changed files, renames under both names', async () => {
		const calls = [];
		const first = Array.from({ length: 100 }, (_, index) => ({ filename: `file-${index}.js` }));
		const fetchImpl = async (url, options) => {
			calls.push({ url, options });
			if (url.endsWith('/pulls/7')) return response(200, pull);
			if (url.endsWith('page=1')) return response(200, first);
			return response(200, [{ filename: 'docs/wiki/Home.md', previous_filename: 'docs/Home.md' }]);
		};
		const result = await loadPullRequest({ repository: 'solarssk/wp-critical-css', number: 7, token: 'token-value', fetchImpl, retryDelayMs: 0 });
		assert.equal(result.body, 'the description');
		assert.equal(result.author, 'solarssk');
		assert.deepEqual(result.files.slice(-2), ['docs/wiki/Home.md', 'docs/Home.md']);
		assert.equal(result.files.length, 102);
		assert.equal(calls[0].url, 'https://api.github.com/repos/solarssk/wp-critical-css/pulls/7');
		assert.equal(calls[0].options.headers.Authorization, 'Bearer token-value');
		assert.equal(calls.length, 3);
	});

	it('treats a missing description and author as empty', async () => {
		const fetchImpl = async (url) => response(200, url.includes('/files') ? [] : {});
		const result = await loadPullRequest({ repository: 'o/r', number: 1, token: 't', fetchImpl, retryDelayMs: 0 });
		assert.deepEqual(result, { body: '', author: '', files: [] });
	});

	it('retries a server error and a network error, then succeeds', async () => {
		let attempts = 0;
		const fetchImpl = async (url) => {
			if (url.includes('/files')) return response(200, []);
			attempts += 1;
			if (attempts === 1) return response(502, {});
			if (attempts === 2) throw new Error('socket hang up');
			return response(200, pull);
		};
		const result = await loadPullRequest({ repository: 'o/r', number: 1, token: 't', fetchImpl, retryDelayMs: 0 });
		assert.equal(attempts, 3);
		assert.equal(result.body, 'the description');
	});

	it('gives up after three attempts on a persistent server error', async () => {
		let attempts = 0;
		const fetchImpl = async () => {
			attempts += 1;
			return response(503, {});
		};
		await assert.rejects(loadPullRequest({ repository: 'o/r', number: 1, token: 't', fetchImpl, retryDelayMs: 0 }), /HTTP 503\); re-run the job/);
		assert.equal(attempts, 3);
	});

	it('does not retry a client error', async () => {
		let attempts = 0;
		const fetchImpl = async () => {
			attempts += 1;
			return response(404, {});
		};
		await assert.rejects(loadPullRequest({ repository: 'o/r', number: 1, token: 't', fetchImpl, retryDelayMs: 0 }), /HTTP 404/);
		assert.equal(attempts, 1);
	});

	it('reports a network error that never recovers', async () => {
		const fetchImpl = async () => {
			throw new Error('ECONNRESET');
		};
		await assert.rejects(loadPullRequest({ repository: 'o/r', number: 1, token: 't', fetchImpl, retryDelayMs: 0 }), /ECONNRESET/);
	});
});

describe('running the script', () => {
	function run(env, { viaSymlink = false } = {}) {
		const directory = mkdtempSync(join(tmpdir(), 'pr-docs-'));
		directories.push(directory);
		let path = SCRIPT;
		if (viaSymlink) {
			path = join(directory, 'linked-check.mjs');
			symlinkSync(SCRIPT, path);
		}
		const event = join(directory, 'event.json');
		writeFileSync(event, JSON.stringify({ pull_request: { number: 1 } }));
		const environment = { PATH: process.env.PATH, GITHUB_EVENT_PATH: event, ...env };
		return spawnSync(process.execPath, [path], { encoding: 'utf8', env: environment });
	}

	it('has nothing to check outside a pull request', () => {
		const result = run({ GITHUB_EVENT_NAME: 'push' });
		assert.equal(result.status, 0);
		assert.match(result.stdout, /not a pull request/);
	});

	it('fails, also when started through a symbolic link, when it cannot tell which pull request to read', () => {
		for (const viaSymlink of [false, true]) {
			const result = run({ GITHUB_EVENT_NAME: 'pull_request' }, { viaSymlink });
			assert.equal(result.status, 1, `viaSymlink=${viaSymlink}: ${result.stdout}${result.stderr}`);
			assert.match(result.stderr, /GITHUB_REPOSITORY, GITHUB_TOKEN/);
		}
	});
});
