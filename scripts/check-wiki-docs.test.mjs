import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { REQUIRED_PAGES, checkWiki, headingAnchors, parseDockerfileEnv, slugify, tableRows } from './check-wiki-docs.mjs';

const REPO = 'https://github.com/solarssk/wp-critical-css';
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'check-wiki-docs.mjs');
const roots = [];

after(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const CONFIGURATION = `# Configuration

Use \`SHARED_SECRET\` and \`WPCC_SHARED_SECRET\`, \`UV_THREADPOOL_SIZE\`, \`PORT\` and \`WPCC_BREAKPOINT\`.

## Service settings

| Variable | Required | Default | What it does |
|---|---|---|---|
| \`PORT\` | no | \`3939\` | Port. |
| \`SHARED_SECRET\` | yes | - | Secret. |
| \`SWEEP_CRON\` | no | \`0 3 * * *\` | When. |
| \`MAX_QUEUE_LENGTH\` | no | \`500\` | Ceiling. |
| \`SWEEP_ENABLED\` | no | \`true\` | Switch. |

## Set by the image

| Variable | Required | Default | What it does |
|---|---|---|---|
| \`NODE_ENV\` | no | \`production\` | Mode. |
| \`UV_THREADPOOL_SIZE\` | no | \`16\` | Pool. |
| \`PUPPETEER_CHROME_VERSION\` | no | the pinned build | Chrome. |

## WordPress settings

| Constant | Required | Default | What it does |
|---|---|---|---|
| \`WPCC_SHARED_SECRET\` | yes | - | Secret. |
| \`WPCC_BREAKPOINT\` | no | \`782\` | Pixels. |

## Endpoints

| Method | Path | Served by | What it does |
|---|---|---|---|
| \`GET\` | \`/health\` | service | Health. |
| \`POST\` | \`/generate\` | service | Queue a URL. |
| \`POST\` | \`/wp-json/wpcc/v1/critical-css\` | plugin | Receive CSS. |
`;

const PHP_FILE = 'wordpress-plugin/wp-critical-css/includes/receiver.php';
const SERVER = 'service/server.js';
const DOCKERFILE = 'service/Dockerfile';
const EGRESS = 'docker-compose.egress.example.yml';

function sidebar() {
	return REQUIRED_PAGES.map((page) => `- [${page}](${page})`).join('\n') + '\n';
}

/** A minimal, valid repository: every file the checker reads, all consistent with each other. */
function validRepository() {
	const files = new Map();
	for (const page of REQUIRED_PAGES) {
		files.set(`docs/wiki/${page}.md`, `# ${page === 'Home' ? 'Home' : page.replaceAll('-', ' ')}\n\nText.\n`);
	}
	files.set('docs/wiki/_Sidebar.md', sidebar());
	files.set('docs/wiki/Configuration.md', CONFIGURATION);
	files.set('docs/wiki/Getting-Started.md', '# Getting Started\n\nNeeds WordPress 6.0 and PHP 7.4.\n');
	files.set('docs/wiki/Network-Egress-Filtering.md', '# Network Egress Filtering\n\n## Settings\n\n| Variable | What it does |\n|---|---|\n| `EGRESS_ALLOW` | Allow-list. |\n');
	files.set('docs/DEPLOYMENT.md', '# Deployment\n\n## Releases\n');
	files.set(SERVER, [
		'// A comment may mention process.env.ONLY_IN_A_COMMENT and app.post(\'/in-a-comment\') freely.',
		'const PORT = process.env.PORT || 3939;',
		'const SHARED_SECRET = process.env.SHARED_SECRET;',
		"const SWEEP_CRON = process.env.SWEEP_CRON || '0 3 * * *';",
		"const MAX = parsePositiveInt(process.env.MAX_QUEUE_LENGTH, 500, 'MAX_QUEUE_LENGTH');",
		'const POOL = Number(process.env.UV_THREADPOOL_SIZE) || 4;',
		"const SWEEP_ENABLED = process.env.SWEEP_ENABLED !== 'false';",
		"app.get('/health', () => {});",
		"app.post('/generate', () => {});",
	].join('\n'));
	files.set(DOCKERFILE, [
		'FROM node:24',
		'# ENV COMMENTED_OUT=1',
		'ENV NODE_ENV=production',
		'ENV UV_THREADPOOL_SIZE=16',
		'ENV PUPPETEER_CHROME_VERSION=154.0.1 \\',
		'\tPUPPETEER_CACHE_DIR="/home/pptruser/.cache/puppeteer"',
	].join('\n'));
	files.set('service/server.test.js', 'process.env.ONLY_IN_A_TEST = "1";\n');
	files.set('service/scripts/ci-only.mjs', 'process.env.ONLY_IN_A_CI_SCRIPT = "1";\n');
	files.set('wordpress-plugin/wp-critical-css/wp-critical-css.php', '<?php\n/**\n * Requires at least: 6.0\n * Requires PHP:      7.4\n */\n');
	files.set(PHP_FILE, [
		'<?php',
		'/**',
		' * Mentions WPCC_ONLY_IN_A_COMMENT, which is not a constant.',
		' */',
		"if ( ! defined( 'WPCC_SHARED_SECRET' ) ) { return; }",
		"define( 'WPCC_BREAKPOINT', 782 );",
		"register_rest_route( 'wpcc/v1', '/critical-css', array( 'methods' => 'POST' ) );",
	].join('\n'));
	files.set('.env.example', 'PORT=3939\nSHARED_SECRET=placeholder\n');
	files.set(EGRESS, [
		'# A comment may mention ${EGRESS_ONLY_IN_A_COMMENT} freely.',
		'environment:',
		'  EGRESS_ALLOW: ${EGRESS_ALLOW:-} # and ${EGRESS_IN_A_TRAILING_COMMENT}',
		'command: for e in $${EGRESS_SHELL_VARIABLE:-}; do :; done',
	].join('\n'));
	return files;
}

/** Writes the repository to a temporary directory. A value `{ symlink: target }` becomes a link. */
function writeRepository(files) {
	const root = mkdtempSync(join(tmpdir(), 'wiki-docs-'));
	roots.push(root);
	for (const [path, content] of files) {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		if (typeof content === 'object') symlinkSync(content.symlink, join(root, path));
		else writeFileSync(join(root, path), content);
	}
	return root;
}

function check(mutate = () => {}) {
	const files = validRepository();
	mutate(files);
	return checkWiki(writeRepository(files));
}

function edit(files, path, from, to) {
	assert.ok(files.get(path).includes(from), `fixture ${path} does not contain ${from}`);
	files.set(path, files.get(path).replace(from, to));
}

const home = (body) => (files) => files.set('docs/wiki/Home.md', `# Home\n\n${body}`);

describe('checkWiki', () => {
	it('accepts a consistent repository', () => {
		assert.deepEqual(check(), []);
	});

	const cases = [
		['a missing wiki folder', (files) => { for (const path of [...files.keys()]) if (path.startsWith('docs/wiki/')) files.delete(path); }, 'docs/wiki'],
		['a missing required page', (files) => files.delete('docs/wiki/Troubleshooting.md'), 'required page docs/wiki/Troubleshooting.md is missing'],
		['a page whose name is not a valid address', (files) => files.set('docs/wiki/Bad_Name.md', '# Bad_Name\n'), 'letters, digits and hyphens'],
		['a page without a title', (files) => files.set('docs/wiki/Home.md', 'No heading here.\n'), 'exactly one'],
		['a page with two titles', (files) => files.set('docs/wiki/Home.md', '# Home\n\n# Again\n'), 'exactly one'],
		['a title that is not the file name', (files) => edit(files, 'docs/wiki/Troubleshooting.md', '# Troubleshooting', '# Troubles'), 'must be "Troubleshooting"'],
		['a page that does not start with its title', (files) => files.set('docs/wiki/Home.md', '\n# Home\n'), 'must start with its'],
		['a secret-looking value', (files) => files.set('docs/wiki/Home.md', `# Home\n\n${'ab12'.repeat(16)}\n`), '64-character hex'],
		['trailing whitespace', (files) => files.set('docs/wiki/Home.md', '# Home\n\nText with a trailing space. \n'), 'line 3 has trailing whitespace'],
		['a space before a tab', (files) => files.set('docs/wiki/Home.md', '# Home\n\n \tindented\n'), 'a space before a tab'],
		['a conflict marker', (files) => files.set('docs/wiki/Home.md', '# Home\n\n<<<<<<< HEAD\n'), 'a leftover conflict marker'],
		['a blank line at the end of a page', (files) => files.set('docs/wiki/Home.md', '# Home\n\n'), 'ends with a blank line'],
		['a missing sidebar', (files) => files.delete('docs/wiki/_Sidebar.md'), '_Sidebar.md is missing'],
		['a page the sidebar does not link to', (files) => edit(files, 'docs/wiki/_Sidebar.md', '- [Troubleshooting](Troubleshooting)\n', ''), 'does not link to Troubleshooting'],
		['a symbolic link among the pages', (files) => files.set('docs/wiki/Link.md', { symlink: 'Home.md' }), 'Link.md is not a regular Markdown page'],
		['a hidden file', (files) => files.set('docs/wiki/.secret.md', '# x\n'), '.secret.md is not a regular Markdown page'],
		['a file that is not a page', (files) => files.set('docs/wiki/notes.txt', 'x'), 'notes.txt is not a regular Markdown page'],
		['a folder other than images', (files) => files.set('docs/wiki/drafts/Draft.md', '# Draft\n'), 'drafts is not a regular Markdown page'],
		['a non-image file under images', (files) => files.set('docs/wiki/images/notes.txt', 'x'), 'images/notes.txt is not a regular image file'],
		['a link to a missing page', home('[x](Nope)\n'), 'page "Nope", which does not exist'],
		['a link to a missing heading', home('[x](Configuration#nope)\n'), '#nope in Configuration'],
		['an anchor missing on the same page', home('[x](#nope)\n'), '#nope does not match'],
		['a link with an extension', home('[x](Configuration.md)\n'), 'is not a wiki link'],
		['a relative path', home('[x](../README.md)\n'), 'is not a wiki link'],
		['a link to a repository file that does not exist', home(`[x](${REPO}/blob/main/docs/NOPE.md)\n`), 'docs/NOPE.md in this repository'],
		['a link to a repository heading that does not exist', home(`[x](${REPO}/blob/main/docs/DEPLOYMENT.md#nope)\n`), '#nope in docs/DEPLOYMENT.md'],
		['a repository link with a malformed escape', home(`[x](${REPO}/blob/main/docs/%E0%A4%A.md)\n`), 'malformed address'],
		['an image without alternative text', home('![](images/a.png)\n'), 'without alternative text'],
		['an image that is not in the wiki folder', home('![alt](images/a.png)\n'), 'images/a.png'],
		['a link after a fence that a longer fence was hiding', home('~~~\n```\n~~~\n[x](Nope)\n'), 'page "Nope"'],
		['a setting the code reads but the docs do not list', (files) => edit(files, SERVER, 'const PORT', 'const X = process.env.NEW_SETTING;\nconst PORT'), 'NEW_SETTING is read by the code'],
		['a setting whose row was deleted while prose still mentions it', (files) => edit(files, 'docs/wiki/Configuration.md', '| `SHARED_SECRET` | yes | - | Secret. |\n', ''), 'SHARED_SECRET is read by the code but has no row'],
		['a variable of the image whose row was deleted', (files) => edit(files, 'docs/wiki/Configuration.md', '| `UV_THREADPOOL_SIZE` | no | `16` | Pool. |\n', ''), 'UV_THREADPOOL_SIZE is read by the code but has no row'],
		['a setting the docs list but the code no longer reads', (files) => edit(files, SERVER, "const SWEEP_CRON = process.env.SWEEP_CRON || '0 3 * * *';", ''), 'SWEEP_CRON is documented'],
		['a setting only an .mjs file reads', (files) => files.set('service/extra.mjs', 'export const x = process.env.FROM_MJS;\n'), 'FROM_MJS is read by the code'],
		['a default that changed in code', (files) => edit(files, SERVER, 'process.env.PORT || 3939', 'process.env.PORT || 4000'), 'defaults to 4000'],
		['a default written with ??', (files) => edit(files, SERVER, 'process.env.PORT || 3939', 'process.env.PORT ?? 4000'), 'defaults to 4000'],
		['a quoted default that changed in code', (files) => edit(files, SERVER, "|| '0 3 * * *'", "|| '0 4 * * *'"), 'defaults to 0 4 * * *'],
		['a default passed as an argument that changed in code', (files) => edit(files, SERVER, 'MAX_QUEUE_LENGTH, 500', 'MAX_QUEUE_LENGTH, 600'), 'defaults to 600'],
		['a flag whose default flipped in code', (files) => edit(files, SERVER, "process.env.SWEEP_ENABLED !== 'false'", "process.env.SWEEP_ENABLED === 'true'"), 'SWEEP_ENABLED: the code defaults to false'],
		['a comparison of an environment variable that is not a flag', (files) => edit(files, SERVER, 'const PORT', "const MODE = process.env.PORT === 'yes';\nconst PORT"), 'does not understand'],
		['a documented default the code does not state in a readable form', (files) => edit(files, SERVER, 'process.env.PORT || 3939', 'process.env.PORT || DEFAULT_PORT'), 'PORT: docs/wiki/Configuration.md ("Service settings") lists a default, but there is none'],
		['a default in the image that changed', (files) => edit(files, DOCKERFILE, 'UV_THREADPOOL_SIZE=16', 'UV_THREADPOOL_SIZE=32'), 'service/Dockerfile sets it to 32'],
		['a default of the image quoted wrongly in the docs', (files) => edit(files, 'docs/wiki/Configuration.md', '| the pinned build |', '| `1.2.3` |'), 'service/Dockerfile sets it to 154.0.1'],
		['a variable of the image table that the Dockerfile no longer sets', (files) => edit(files, DOCKERFILE, 'ENV NODE_ENV=production\n', ''), 'NODE_ENV is documented in docs/wiki/Configuration.md ("Set by the image") as set by the image'],
		['a missing Dockerfile', (files) => files.delete(DOCKERFILE), 'service/Dockerfile is missing'],
		['an image value that overrides a code default', (files) => edit(files, DOCKERFILE, 'ENV NODE_ENV=production', 'ENV NODE_ENV=production\nENV PORT=4000'), 'PORT: service/Dockerfile sets it to 4000'],
		['a missing image section', (files) => edit(files, 'docs/wiki/Configuration.md', '## Set by the image', '## Image'), 'no "## Set by the image" section'],
		['a variable listed twice', (files) => edit(files, 'docs/wiki/Configuration.md', '| `SHARED_SECRET` | yes | - | Secret. |', '| `SHARED_SECRET` | yes | - | Secret. |\n| `PORT` | no | `3939` | Again. |'), 'lists `PORT` twice'],
		['two different defaults for one variable in the code', (files) => files.set('service/extra.js', 'const x = process.env.PORT || 4000;\n'), 'PORT has two different defaults'],
		['a negated flag', (files) => edit(files, SERVER, "process.env.SWEEP_ENABLED !== 'false'", "!(process.env.SWEEP_ENABLED === 'true')"), 'does not understand'],
		['a literal that is only the start of an expression', (files) => edit(files, SERVER, 'process.env.PORT || 3939', 'process.env.PORT || 3939 + 1'), 'PORT: docs/wiki/Configuration.md ("Service settings") lists a default, but there is none'],
		['the environment imported from node:process', (files) => edit(files, SERVER, 'const PORT', "import { env } from 'node:process';\nconst PORT"), 'does not understand'],
		['a read on a line that starts with a hash', (files) => edit(files, SERVER, 'const PORT', '#hidden = process.env.HASHED;\nconst PORT'), 'HASHED is read by the code'],
		['an equality comparison of an environment variable', (files) => edit(files, SERVER, 'const PORT', "const A = process.env.PORT == 'yes';\nconst PORT"), 'does not understand'],
		['an inequality comparison of an environment variable', (files) => edit(files, SERVER, 'const PORT', "const A = process.env.PORT != 'false';\nconst PORT"), 'does not understand'],
		['a variable read with a bracket', (files) => edit(files, SERVER, 'const PORT', "const A = process.env['BRACKET_VAR'];\nconst PORT"), 'BRACKET_VAR is read by the code'],
		['a default row that says nothing', (files) => edit(files, 'docs/wiki/Configuration.md', '| `PORT` | no | `3939` |', '| `PORT` | no | - |'), 'PORT: the code defaults to 3939'],
		['a default that is not in code formatting', (files) => edit(files, 'docs/wiki/Configuration.md', '| `PORT` | no | `3939` |', '| `PORT` | no | 3939 |'), 'PORT: the code defaults to 3939'],
		['a default that only contains the right digits', (files) => edit(files, 'docs/wiki/Configuration.md', '| `PORT` | no | `3939` |', '| `PORT` | no | `13939` |'), 'PORT: the code defaults to 3939'],
		['an image default quoted without code formatting', (files) => edit(files, 'docs/wiki/Configuration.md', '| `UV_THREADPOOL_SIZE` | no | `16` |', '| `UV_THREADPOOL_SIZE` | no | 16 |'), 'service/Dockerfile sets it to 16'],
		['a Dockerfile with more than one stage', (files) => edit(files, DOCKERFILE, 'FROM node:24', 'FROM node:24 AS build\nFROM node:24'), 'more than one stage'],
		['a service setting row without a code name', (files) => edit(files, 'docs/wiki/Configuration.md', '| `PORT` |', '| PORT |'), 'one `code` name'],
		['environment variables read by destructuring', (files) => edit(files, SERVER, 'const PORT', 'const { HIDDEN } = process.env;\nconst PORT'), 'server.js:2 uses a form this check does not understand'],
		['environment variables read with optional chaining', (files) => edit(files, SERVER, 'const PORT', 'const x = process.env?.HIDDEN;\nconst PORT'), 'does not understand'],
		['environment variables read through a template literal', (files) => edit(files, SERVER, 'const PORT', 'const x = process.env[`HIDDEN`];\nconst PORT'), 'does not understand'],
		['a variable .env.example sets but the service never reads', (files) => edit(files, '.env.example', 'PORT=3939', 'PORT=3939\nSTALE=1'), '.env.example sets STALE'],
		['a constant the plugin uses but the docs do not list', (files) => edit(files, PHP_FILE, "define( 'WPCC_BREAKPOINT', 782 );", "define( 'WPCC_BREAKPOINT', 782 );\ndefine( 'WPCC_EXTRA', 1 );"), 'WPCC_EXTRA is read by the code'],
		['a constant declared with const', (files) => edit(files, PHP_FILE, "define( 'WPCC_BREAKPOINT', 782 );", "define( 'WPCC_BREAKPOINT', 782 );\nconst WPCC_EXTRA = 1;"), 'WPCC_EXTRA is read by the code'],
		['a constant default that changed in the plugin', (files) => edit(files, PHP_FILE, "'WPCC_BREAKPOINT', 782", "'WPCC_BREAKPOINT', 800"), 'defaults to 800'],
		['a constant default in double quotes that changed', (files) => edit(files, PHP_FILE, "'WPCC_BREAKPOINT', 782", '"WPCC_BREAKPOINT", 800'), 'defaults to 800'],
		['a route the docs do not list', (files) => edit(files, SERVER, "app.post('/generate'", "app.post('/purge', () => {});\napp.post('/generate'"), 'POST /purge exists in the code'],
		['a documented route the code does not have', (files) => edit(files, SERVER, "app.get('/health', () => {});", ''), 'GET /health is in the'],
		['a route written with double quotes', (files) => edit(files, SERVER, "app.post('/generate'", 'app.post("/hidden", () => {});\napp.post(\'/generate\''), 'does not understand'],
		['a route on a router', (files) => edit(files, SERVER, "app.post('/generate'", "router.get('/hidden', () => {});\napp.post('/generate'"), 'does not understand'],
		['a route declared with app.route', (files) => edit(files, SERVER, "app.post('/generate'", "app.route('/hidden').get(() => {});\napp.post('/generate'"), 'does not understand'],
		['a REST route the docs do not list', (files) => edit(files, PHP_FILE, "'/critical-css'", "'/other'"), 'POST /wp-json/wpcc/v1/other exists in the code'],
		['a second REST route with its own method', (files) => files.set(PHP_FILE, `${files.get(PHP_FILE)}\nregister_rest_route( 'wpcc/v1', '/other', array( 'methods' => 'GET' ) );\n`), 'GET /wp-json/wpcc/v1/other exists in the code'],
		['a plugin requirement the docs do not state', (files) => edit(files, 'wordpress-plugin/wp-critical-css/wp-critical-css.php', '7.4', '8.1'), 'PHP 8.1'],
		['a longer version that only starts like the required one', (files) => edit(files, 'docs/wiki/Getting-Started.md', 'PHP 7.4.', 'PHP 7.40.'), 'does not say "PHP 7.4"'],
		['a plugin header without a requirement', (files) => files.set('wordpress-plugin/wp-critical-css/wp-critical-css.php', '<?php\n'), 'has no "Requires at least" header'],
		['an egress variable the docs do not describe', (files) => edit(files, EGRESS, 'environment:', 'environment:\n  EGRESS_ALLOW_NEW: ${EGRESS_ALLOW_NEW:-}'), 'reads EGRESS_ALLOW_NEW'],
		['an egress variable the docs describe but the active lines no longer read', (files) => edit(files, EGRESS, '  EGRESS_ALLOW: ${EGRESS_ALLOW:-} # and ${EGRESS_IN_A_TRAILING_COMMENT}\n', '# EGRESS_ALLOW: ${EGRESS_ALLOW:-}\n'), 'EGRESS_ALLOW is documented in docs/wiki/Network-Egress-Filtering.md ("Settings") but'],
		['an egress row without a variable', (files) => edit(files, 'docs/wiki/Network-Egress-Filtering.md', '| `EGRESS_ALLOW` |', '| `EGRESS_OLD` | Old. |\n| `EGRESS_ALLOW` |'), 'EGRESS_OLD is documented'],
		['an egress page without its Settings section', (files) => edit(files, 'docs/wiki/Network-Egress-Filtering.md', '## Settings', '## Options'), 'no "## Settings" section'],
		['an image that points out of the wiki folder at an existing file', (files) => {
			files.set('README.md', 'readme\n');
			files.set('docs/wiki/Home.md', '# Home\n\n![outside](../../README.md)\n');
		}, 'uses the image ../../README.md, which is not a file under docs/wiki/images'],
		['an image that is a page', home('![page](Home.md)\n'), 'uses the image Home.md'],
		['an image that climbs out of images/ and back', (files) => {
			files.set('docs/wiki/images/a.png', 'png');
			files.set('docs/wiki/Home.md', '# Home\n\n![page](images/../Home.md)\n');
		}, 'uses the image images/../Home.md'],
		['a repository link that leaves the repository', home(`[x](${REPO}/blob/main/../outside.md)\n`), 'outside this repository'],
		['a source file that moved', (files) => files.delete(SERVER), 'service/server.js is missing'],
		['a missing table', (files) => edit(files, 'docs/wiki/Configuration.md', '## Endpoints', '## Routes'), 'no "## Endpoints" section'],
	];

	for (const [name, mutate, expected] of cases) {
		it(`rejects ${name}`, () => {
			const problems = check(mutate);
			assert.ok(problems.some((problem) => problem.includes(expected)), `expected a problem containing "${expected}", got:\n${problems.join('\n')}`);
		});
	}

	it('accepts underscored and double-quoted defaults, and words in a Default cell with no default in code', () => {
		const problems = check((files) => {
			edit(files, SERVER, 'process.env.PORT || 3939', 'process.env.PORT || 3_939');
			edit(files, SERVER, "|| '0 3 * * *'", '|| "0 3 * * *"');
			edit(files, 'docs/wiki/Configuration.md', '| `SHARED_SECRET` | yes | - |', '| `SHARED_SECRET` | yes | none, required |');
			edit(files, 'docs/wiki/Configuration.md', '| `PORT` | no | `3939` |', '| `PORT` | no | `3939` |');
		});
		assert.deepEqual(problems, []);
	});

	it('ignores links and headings inside code', () => {
		assert.deepEqual(check(home('```md\n# Not a title\n[x](Nope)\n```\n\nUse `[y](Nowhere)` like this.\n')), []);
	});

	it('lets a longer fence show a shorter one', () => {
		assert.deepEqual(check(home('````md\n```\n# Not a title\n```\n[x](Nope)\n````\n')), []);
	});

	it('accepts anchors on the same page, in another page and in repository files', () => {
		const body = `## Part one\n\n[a](#part-one) [b](Configuration#service-settings) [c](${REPO}/blob/main/docs/DEPLOYMENT.md#releases) [d](mailto:a@example.com)\n`;
		assert.deepEqual(check(home(body)), []);
	});

	it('follows GitHub for headings that hold code', () => {
		const files = (mutate) => (map) => {
			map.set('docs/wiki/Configuration.md', `${CONFIGURATION}\n## The \`foo\` flag\n`);
			mutate(map);
		};
		assert.deepEqual(check(files(home('[x](Configuration#the-foo-flag)\n'))), []);
		assert.ok(check(files(home('[x](Configuration#the--flag)\n'))).some((problem) => problem.includes('#the--flag')));
	});

	it('accepts an image that exists in the wiki folder, and macOS folder metadata', () => {
		const problems = check((files) => {
			files.set('docs/wiki/images/a.png', 'png');
			files.set('docs/wiki/.DS_Store', 'junk');
			files.set('docs/wiki/Home.md', '# Home\n\n![alt](images/a.png)\n');
		});
		assert.deepEqual(problems, []);
	});

	it('accepts a footer page without a title or a sidebar entry', () => {
		assert.deepEqual(check((files) => files.set('docs/wiki/_Footer.md', 'Footer text.\n')), []);
	});

	it('does not count a constant that only a comment mentions', () => {
		const problems = check((files) => files.set(SERVER, `${files.get(SERVER)}\n// process.env.NEVER_READ and app.get('/never')\n`));
		assert.deepEqual(problems, []);
	});
});

describe('running the script', () => {
	function run(files, { viaSymlink = false } = {}) {
		const root = writeRepository(files);
		mkdirSync(join(root, 'scripts'));
		copyFileSync(SCRIPT, join(root, 'scripts/check-wiki-docs.mjs'));
		let path = join(root, 'scripts/check-wiki-docs.mjs');
		if (viaSymlink) {
			path = join(root, 'linked-check.mjs');
			symlinkSync(join(root, 'scripts/check-wiki-docs.mjs'), path);
		}
		return spawnSync(process.execPath, [path], { encoding: 'utf8' });
	}

	it('exits 0 on a valid repository', () => {
		const result = run(validRepository());
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /valid and matches the code/);
	});

	it('exits 1 on a broken repository, also when started through a symbolic link', () => {
		for (const viaSymlink of [false, true]) {
			const files = validRepository();
			files.delete('docs/wiki/Troubleshooting.md');
			const result = run(files, { viaSymlink });
			assert.equal(result.status, 1, `viaSymlink=${viaSymlink}: ${result.stdout}${result.stderr}`);
			assert.match(result.stderr, /required page docs\/wiki\/Troubleshooting.md is missing/);
		}
	});
});

describe('parseDockerfileEnv', () => {
	it('reads single, multiple, continued, quoted and legacy ENV instructions, and skips comments', () => {
		const text = [
			'# ENV COMMENTED=1',
			'FROM node:24',
			'ENV ONE=1',
			'env TWO=2 THREE="three words"',
			"ENV FOUR='4' \\",
			'\t# a comment inside the continuation',
			'\tFIVE=5',
			'ENV LEGACY a legacy value',
			'RUN echo "ENV NOT_AN_INSTRUCTION=1"',
			'',
		].join('\n');
		assert.deepEqual(Object.fromEntries(parseDockerfileEnv(text)), { ONE: '1', TWO: '2', THREE: 'three words', FOUR: '4', FIVE: '5', LEGACY: 'a legacy value' });
	});

	it('reads an instruction that is not closed and an empty file', () => {
		assert.deepEqual(Object.fromEntries(parseDockerfileEnv('ENV QUOTED="open')), { QUOTED: 'open' });
		assert.equal(parseDockerfileEnv('').size, 0);
	});

	it('reads the quoted legacy form, only treats a space before the first = as the legacy form, and lets a later ENV win', () => {
		const text = 'ENV QUOTED "two words"\nENV EQ a=b c\nENV TWICE=1\nENV TWICE=2\n';
		assert.deepEqual(Object.fromEntries(parseDockerfileEnv(text)), { QUOTED: 'two words', EQ: 'a=b c', TWICE: '2' });
	});

	it('reads an instruction that ends with a backslash', () => {
		assert.deepEqual(Object.fromEntries(parseDockerfileEnv('ENV LAST=1 \\')), { LAST: '1' });
	});

	it('reads the real Dockerfile', () => {
		const real = readFileSync(join(dirname(SCRIPT), '../service/Dockerfile'), 'utf8');
		const variables = parseDockerfileEnv(real);
		assert.equal(variables.get('NODE_ENV'), 'production');
		assert.ok(variables.size > 1);
	});
});

describe('markdown helpers', () => {
	it('slugifies like GitHub', () => {
		assert.equal(slugify('2. Configure WordPress'), '2-configure-wordpress');
		assert.equal(slugify('Optional: network-level egress filtering'), 'optional-network-level-egress-filtering');
		assert.equal(slugify('Roll back'), 'roll-back');
		assert.equal(slugify('Zażółć `code`'), 'zażółć-code');
	});

	it('numbers repeated headings', () => {
		assert.deepEqual([...headingAnchors('# A\n## B\n## B\n## B\n')], ['a', 'b', 'b-1', 'b-2']);
	});

	it('keeps the text of code spans, links and closing hashes in a heading', () => {
		const text = '## The `foo` flag\n## `a`\n## See [the guide](Guide) now ##\n## Trailing # hash\n';
		assert.deepEqual([...headingAnchors(text)], ['the-foo-flag', 'a', 'see-the-guide-now', 'trailing--hash']);
	});

	it('does not read headings inside fenced code', () => {
		assert.deepEqual([...headingAnchors('## Real\n```\n## Fake\n```\n')], ['real']);
	});

	it('reads the rows of a table and stops at the next section', () => {
		const text = '## One\n\n| A | B |\n|---|:-:|\n| x | y |\n| z | w |\n\n## Two\n\n| A |\n|---|\n| q |\n';
		assert.deepEqual(tableRows(text, 'One'), [['x', 'y'], ['z', 'w']]);
		assert.equal(tableRows(text, 'Three'), null);
	});
});
