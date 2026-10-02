#!/usr/bin/env node
// Validates docs/wiki - the only versioned source of the project's GitHub Wiki - and checks that
// what it says still matches the code. `.github/workflows/publish-wiki.yml` replaces the Wiki with
// this directory after every merge, so a page that passes here is what readers will see.
//
// Two kinds of checks, both run by the `wiki-docs` job in ci.yml (and again before publishing):
//   1. The source is well-formed: required pages, one title per page that matches its file name,
//      every page reachable from the sidebar, every link and anchor resolves (including links to
//      files in this repository), no secret-looking values, nothing `git diff --check` or the
//      publishing step would choke on.
//   2. The reference tables match the code: the environment variables the service reads, the
//      variables the Dockerfile sets, the WPCC_* constants the plugin reads, the HTTP endpoints,
//      their defaults, the requirements in the plugin header, and the variables of the egress
//      example. A setting that is added, removed or re-defaulted in code without a matching table
//      row fails here, and so does a default the docs state that cannot be checked. The readers
//      below only understand the patterns this code base uses; a line that touches `process.env`
//      or an Express route in a way they do not understand fails too, rather than being skipped.
//
// Usage: node scripts/check-wiki-docs.mjs
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_URL = 'https://github.com/solarssk/wp-critical-css';

export const REQUIRED_PAGES = [
	'Home',
	'Getting-Started',
	'Configuration',
	'Install-the-Plugin',
	'How-It-Works',
	'Security-Overview',
	'Network-Egress-Filtering',
	'Troubleshooting',
	'Upgrading-and-Releases',
	'Editing-the-Wiki',
];

const SIDEBAR = '_Sidebar';
const SPECIAL_PAGES = new Set([SIDEBAR, '_Footer']);
const PAGE_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
const SECRET_LIKE = /(?<![0-9a-fA-F])[0-9a-fA-F]{64}(?![0-9a-fA-F])/;
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp'];

const SERVICE_DIR = 'service';
const SERVER_FILE = 'service/server.js';
const PLUGIN_DIR = 'wordpress-plugin/wp-critical-css';
const PLUGIN_HEADER_FILE = 'wordpress-plugin/wp-critical-css/wp-critical-css.php';
const DOCKERFILE = 'service/Dockerfile';
const ENV_EXAMPLE_FILE = '.env.example';
const EGRESS_COMPOSE_FILE = 'docker-compose.egress.example.yml';

// ---------------------------------------------------------------------------------------------
// Markdown helpers

/** An opening or closing code fence on this line, if it is one (CommonMark: up to three spaces of
 * indent, then three or more backticks or tildes). */
function fenceOf(line) {
	const trimmed = line.trimStart();
	const character = trimmed[0];
	if (line.length - trimmed.length > 3 || (character !== '`' && character !== '~')) return null;
	let length = 0;
	while (trimmed[length] === character) length += 1;
	return length >= 3 ? { character, length, info: trimmed.slice(length).trim() } : null;
}

/** The lines of a page with the contents of fenced code blocks blanked. A block ends only at a fence
 * of the same character that is at least as long, so a longer fence can show a shorter one. */
function maskFences(text) {
	let open = null;
	return text.split('\n').map((line) => {
		const fence = fenceOf(line);
		if (open === null) {
			open = fence;
			return fence ? '' : line;
		}
		if (fence && fence.character === open.character && fence.length >= open.length && fence.info === '') open = null;
		return '';
	});
}

/** Lines of prose: fenced code blocks and inline code spans are blanked, so an example such as
 * `[text](missing)` shown in code is never mistaken for a real link. */
function proseLines(text) {
	return maskFences(text).map((line) => line.replaceAll(/`[^`\n]*`/g, ''));
}

/** The `[label](target)` and `![alt](target)` links of one line, found by scanning for the
 * brackets rather than with a regular expression (a pattern for this backtracks badly on a line
 * with many unclosed brackets). A title after the target is dropped. */
function linksOfLine(line) {
	const links = [];
	let from = 0;
	while (from < line.length) {
		const open = line.indexOf('[', from);
		const close = open === -1 ? -1 : line.indexOf(']', open + 1);
		if (close === -1) break;
		const end = line[close + 1] === '(' ? line.indexOf(')', close + 2) : -1;
		if (end === -1) {
			from = open + 1;
			continue;
		}
		const target = line.slice(close + 2, end).trim().split(/\s/, 1)[0];
		if (target) links.push({ isImage: line[open - 1] === '!', label: line.slice(open + 1, close), target, start: open, end: end + 1 });
		from = end + 1;
	}
	return links;
}

/** Heading text as GitHub slugs it: a link counts as its label, closing `#`s are not text. */
function headingText(raw) {
	let text = '';
	let from = 0;
	for (const link of linksOfLine(raw)) {
		text += raw.slice(from, link.start) + link.label;
		from = link.end;
	}
	text = (text + raw.slice(from)).trimEnd();
	let end = text.length;
	while (end > 0 && text[end - 1] === '#') end -= 1;
	return end < text.length && (end === 0 || text[end - 1] === ' ') ? text.slice(0, end).trimEnd() : text;
}

/** GitHub's heading slug: lower-case, letters/digits/`-`/`_` kept, spaces become `-`, the rest is
 * dropped (so the backticks of a code span just disappear and its text stays). */
export function slugify(heading) {
	let slug = '';
	for (const character of heading.trim().toLowerCase()) {
		if (character === ' ') {
			slug += '-';
		} else if (character === '-' || character === '_' || /[\p{L}\p{N}]/u.test(character)) {
			slug += character;
		}
	}
	return slug;
}

/** Every anchor a page offers; a repeated heading gets `-1`, `-2`, ... like GitHub does. */
export function headingAnchors(text) {
	const seen = new Map();
	const anchors = new Set();
	for (const line of maskFences(text)) {
		const match = /^#{1,6} (.+)$/.exec(line);
		if (!match) continue;
		const slug = slugify(headingText(match[1]));
		const count = seen.get(slug) ?? 0;
		seen.set(slug, count + 1);
		anchors.add(count === 0 ? slug : `${slug}-${count}`);
	}
	return anchors;
}

function h1Titles(text) {
	return proseLines(text).filter((line) => line.startsWith('# ')).map((line) => line.slice(2).trim());
}

function extractLinks(text) {
	return proseLines(text).flatMap((line) => linksOfLine(line));
}

/** The rows of the first table under `## <heading>`, as arrays of trimmed cells (header and
 * separator rows left out), or null when the section does not exist. */
export function tableRows(text, heading) {
	const lines = maskFences(text);
	const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
	if (start === -1) return null;
	const rows = [];
	for (const line of lines.slice(start + 1)) {
		if (line.startsWith('## ')) break;
		if (!line.startsWith('|')) continue;
		const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
		const isSeparator = cells.every((cell) => /^:?-+:?$/.test(cell));
		if (!isSeparator) rows.push(cells);
	}
	return rows.slice(1);
}

/** The text of a cell that is exactly one code span, or null. */
function codeValue(cell) {
	const match = /^`([^`]+)`$/.exec(cell ?? '');
	return match ? match[1] : null;
}

function mentionsCode(text, value) {
	return text.includes(`\`${value}\``);
}

/** Whether `text` says `<label> <version>` and not a longer version such as 7.40 for 7.4. */
function mentionsVersion(text, label, version) {
	const phrase = `${label} ${version}`;
	for (let index = text.indexOf(phrase); index !== -1; index = text.indexOf(phrase, index + 1)) {
		const after = index + phrase.length;
		const continues = /\d/.test(text[after] ?? '') || (text[after] === '.' && /\d/.test(text[after + 1] ?? ''));
		if (!continues) return true;
	}
	return false;
}

// ---------------------------------------------------------------------------------------------
// Reading the repository

function readText(root, relativePath, problems) {
	const path = join(root, relativePath);
	if (!existsSync(path)) {
		problems.push(`${relativePath} is missing, but scripts/check-wiki-docs.mjs reads it to compare the docs with the code. If it moved, update the path at the top of the script.`);
		return '';
	}
	return readFileSync(path, 'utf8');
}

function listFiles(directory, extensions, skip = () => false) {
	if (!existsSync(directory)) return [];
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		if (skip(path)) return [];
		if (entry.isDirectory()) return listFiles(path, extensions, skip);
		return extensions.some((extension) => entry.name.endsWith(extension)) ? [path] : [];
	});
}

function readPages(wikiRoot) {
	const pages = new Map();
	for (const entry of readdirSync(wikiRoot, { withFileTypes: true })) {
		if (entry.isFile() && entry.name.endsWith('.md')) {
			pages.set(entry.name.slice(0, -3), readFileSync(join(wikiRoot, entry.name), 'utf8'));
		}
	}
	return pages;
}

/** A whole-line comment in JavaScript or PHP: a line comment, a block comment that does not leave code
 * on its line, or a line inside a doc block (starting with a star). A private field (hash and a name)
 * is not a comment in JavaScript. */
function isJsComment(line) {
	const trimmed = line.trimStart();
	if (trimmed.startsWith('//')) return true;
	if (trimmed.startsWith('/*')) return !trimmed.includes('*/') || trimmed.endsWith('*/');
	return trimmed === '*' || trimmed.startsWith('* ') || trimmed.startsWith('*/');
}

/** As above, plus PHP's `#` comments (but not a `#[Attribute]`). */
function isPhpComment(line) {
	const trimmed = line.trimStart();
	return isJsComment(line) || (trimmed.startsWith('#') && !trimmed.startsWith('#['));
}

/** Source text without its whole-line comments: a name that only a comment mentions is not read. */
function codeOf(text, isComment) {
	return text.split('\n').filter((line) => !isComment(line)).join('\n');
}

// ---------------------------------------------------------------------------------------------
// Check 1: the wiki source itself

function titleOf(pageName) {
	return pageName.replaceAll('-', ' ');
}

/** The rules of `git diff --check`, which publish-wiki.yml runs before pushing: better to fail in
 * CI than after the merge, with no pull request left to fix it in. */
const WHITESPACE_RULES = [
	['trailing whitespace', (line) => /[ \t\r]$/.test(line)],
	['a space before a tab in its indent', (line) => /^ +\t/.test(line)],
	['a leftover conflict marker', (line) => line.startsWith('<<<<<<<') || line.startsWith('>>>>>>>') || line === '======='],
];

function checkWhitespace(name, text) {
	const lines = text.split('\n');
	const problems = [];
	for (const [what, matches] of WHITESPACE_RULES) {
		const index = lines.findIndex((line) => matches(line));
		if (index !== -1) problems.push(`docs/wiki/${name}.md line ${index + 1} has ${what}.`);
	}
	if (text.endsWith('\n\n')) problems.push(`docs/wiki/${name}.md ends with a blank line.`);
	return problems;
}

function checkPageShape(name, text) {
	const problems = checkWhitespace(name, text);
	if (!PAGE_FILE_NAME.test(name) && !SPECIAL_PAGES.has(name)) {
		problems.push(`docs/wiki/${name}.md: page names are letters, digits and hyphens only (the file name is the page's address in the Wiki).`);
	}
	if (SECRET_LIKE.test(text)) {
		problems.push(`docs/wiki/${name}.md contains a 64-character hex value, which looks like a real shared secret. Use a placeholder.`);
	}
	if (SPECIAL_PAGES.has(name)) return problems;
	const titles = h1Titles(text);
	if (titles.length !== 1) {
		problems.push(`docs/wiki/${name}.md must have exactly one "# " title, found ${titles.length}.`);
	} else if (name !== 'Home' && titles[0] !== titleOf(name)) {
		problems.push(`docs/wiki/${name}.md: the title "${titles[0]}" must be "${titleOf(name)}" (the file name with hyphens as spaces), because the Wiki shows the file name as the page title.`);
	}
	if (!text.startsWith('# ')) {
		problems.push(`docs/wiki/${name}.md must start with its "# " title.`);
	}
	return problems;
}

function checkImages(directory) {
	return readdirSync(directory, { withFileTypes: true })
		.filter((entry) => entry.name !== '.DS_Store')
		.filter((entry) => !(entry.isFile() && IMAGE_EXTENSIONS.some((extension) => entry.name.toLowerCase().endsWith(extension))))
		.map((entry) => `docs/wiki/images/${entry.name} is not a regular image file (${IMAGE_EXTENSIONS.join(', ')}).`);
}

/** What publish-wiki.yml would copy into the Wiki: only regular Markdown pages and, under images/,
 * regular image files. A symbolic link, a hidden file or anything else would be published unchecked. */
function checkLayout(wikiRoot) {
	const problems = [];
	for (const entry of readdirSync(wikiRoot, { withFileTypes: true })) {
		if (entry.name === '.DS_Store') continue;
		if (entry.isDirectory() && entry.name === 'images') {
			problems.push(...checkImages(join(wikiRoot, entry.name)));
		} else if (!(entry.isFile() && entry.name.endsWith('.md') && !entry.name.startsWith('.'))) {
			problems.push(`docs/wiki/${entry.name} is not a regular Markdown page (symbolic links, hidden files, folders other than images/ and other file types would be published unchecked).`);
		}
	}
	return problems;
}

function resolveWikiLink(file, link, pages) {
	const [target, anchor] = link.target.split('#', 2);
	if (target === '') {
		return anchor && !headingAnchors(pages.get(file)).has(anchor) ? `#${anchor} does not match a heading on this page` : null;
	}
	if (target.includes('/') || target.endsWith('.md')) {
		return `"${link.target}" is not a wiki link. Link pages by name without an extension, e.g. [text](Getting-Started), and anything else by its full https://github.com/... address`;
	}
	if (!pages.has(target)) return `links to the page "${target}", which does not exist`;
	if (anchor && !headingAnchors(pages.get(target)).has(anchor)) {
		return `links to #${anchor} in ${target}, but that page has no such heading`;
	}
	return null;
}

function resolveRepoLink(root, link) {
	const prefixes = [`${REPO_URL}/blob/main/`, `${REPO_URL}/tree/main/`];
	const prefix = prefixes.find((candidate) => link.target.startsWith(candidate));
	if (!prefix) return null;
	const [withoutAnchor, anchor] = link.target.slice(prefix.length).split('#', 2);
	let path;
	try {
		path = decodeURIComponent(withoutAnchor);
	} catch {
		return `has a link with a malformed address (${link.target})`;
	}
	const absolute = join(root, path);
	if (!existsSync(absolute)) return `links to ${path} in this repository, which does not exist`;
	if (anchor && path.endsWith('.md') && !headingAnchors(readFileSync(absolute, 'utf8')).has(anchor)) {
		return `links to #${anchor} in ${path}, but that file has no such heading`;
	}
	return null;
}

function checkLink({ root, wikiRoot, file, link, pages }) {
	if (link.isImage && !link.label) return 'has an image without alternative text';
	if (/^(?:mailto:|tel:)/i.test(link.target)) return null;
	if (/^https?:\/\//i.test(link.target)) return resolveRepoLink(root, link);
	if (link.isImage) {
		return existsSync(join(wikiRoot, link.target)) ? null : `uses the image ${link.target}, which is not under docs/wiki`;
	}
	return resolveWikiLink(file, link, pages);
}

function checkLinks(root, wikiRoot, pages) {
	const problems = [];
	for (const [file, text] of pages) {
		for (const link of extractLinks(text)) {
			const problem = checkLink({ root, wikiRoot, file, link, pages });
			if (problem) problems.push(`docs/wiki/${file}.md ${problem}.`);
		}
	}
	return problems;
}

function checkSidebar(pages) {
	const sidebar = pages.get(SIDEBAR);
	if (sidebar === undefined) return [`docs/wiki/${SIDEBAR}.md is missing.`];
	const linked = new Set(extractLinks(sidebar).map((link) => link.target.split('#', 1)[0]));
	return [...pages.keys()]
		.filter((name) => !SPECIAL_PAGES.has(name) && !linked.has(name))
		.map((name) => `docs/wiki/${SIDEBAR}.md does not link to ${name}, so readers cannot reach it from the navigation.`);
}

function checkWikiSource(root, wikiRoot) {
	if (!existsSync(wikiRoot)) return ['docs/wiki is missing.'];
	const pages = readPages(wikiRoot);
	const problems = REQUIRED_PAGES.filter((name) => !pages.has(name)).map((name) => `required page docs/wiki/${name}.md is missing.`);
	problems.push(...checkLayout(wikiRoot));
	for (const [name, text] of pages) problems.push(...checkPageShape(name, text));
	problems.push(...checkSidebar(pages), ...checkLinks(root, wikiRoot, pages));
	return problems;
}

// ---------------------------------------------------------------------------------------------
// Check 2: the reference tables against the code

const NAME = '[A-Z][A-Z0-9_]*';
const ENV_READ = new RegExp(String.raw`process\.env\.(${NAME})|process\.env\[\s*['"](${NAME})['"]\s*\]`, 'g');
// A default only counts when the literal is the whole expression: something may follow it only after
// a `)`, `;`, `,`, `]`, `}` or a comment, otherwise `|| 5000 + extra` would be read as 5000.
const AFTER_LITERAL = String.raw`(?=[ \t]*(?:[);,\]}:?\n]|//|$))`;
const ENV_DEFAULT_OR = new RegExp(String.raw`process\.env\.(${NAME})\s*(?:\|\||\?\?)\s*('[^']*'|"[^"]*"|\d[\d_]*)${AFTER_LITERAL}`, 'g');
const ENV_DEFAULT_ARG = new RegExp(String.raw`process\.env\.(${NAME})\s*,\s*(\d[\d_]*)${AFTER_LITERAL}`, 'g');
// A flag: `!== 'false'` is on unless set to false (default true), `=== 'true'` is off unless set to true.
const ENV_FLAG = new RegExp(String.raw`process\.env\.(${NAME})\s*(!==\s*'false'|===\s*'true')`, 'g');
const ENV_COMPARISON = new RegExp(String.raw`process\.env\.${NAME}\s*[!=]==?`, 'g');
const NEGATED_ENV = new RegExp(String.raw`!\s*\(\s*process\.env\.${NAME}`);
// Ways to reach the environment that the readers cannot follow: an import of `process`, an alias.
const INDIRECT_ENV = /node:process|from ['"]process['"]|require\(['"](?:node:)?process['"]\)|=\s*process\s*[;,)]/;
const ROUTE = /\bapp\.(get|post|put|patch|delete)\(\s*'([^']+)'/g;
const ROUTE_LIKE = /\b(?:app|router)\.(?:get|post|put|patch|delete|all|route)\(|\bRouter\(/;
const PHP_CONSTANT = /WPCC_[A-Z0-9_]+/g;
const PHP_DEFAULT = /\bdefine\(\s*['"](WPCC_[A-Z0-9_]+)['"]\s*,\s*('[^']*'|"[^"]*"|\d+)(?=\s*\))/g;
const REST_ROUTE = /register_rest_route\(\s*'([^']+)'\s*,\s*'([^']+)'/g;
const REST_METHOD = /'methods'\s*=>\s*(?:'([A-Z]+)'|WP_REST_Server::(READABLE|CREATABLE|EDITABLE|DELETABLE))/;
const REST_VERBS = { READABLE: 'GET', CREATABLE: 'POST', EDITABLE: 'PUT', DELETABLE: 'DELETE' };

/** A default as the docs write it: the string without its quotes, a number without `_` separators. */
function unquote(literal) {
	const quoted = literal.startsWith("'") || literal.startsWith('"');
	return quoted ? literal.slice(1, -1) : literal.replaceAll('_', '');
}

/** Records `name -> value`. An empty default is no default, and a name that the code gives two
 * different defaults is reported, instead of the last one silently winning. */
function addDefault(into, { name, value, where }, problems) {
	if (value === '') return;
	if (into.has(name) && into.get(name) !== value) {
		problems.push(`${name} has two different defaults in the code (${into.get(name)}, and ${value} in ${where}). State one.`);
	}
	into.set(name, value);
}

function collectDefaults(text, { patterns, into, where, problems }) {
	for (const pattern of patterns) {
		for (const match of text.matchAll(pattern)) addDefault(into, { name: match[1], value: unquote(match[2]), where }, problems);
	}
}

function collectFlagDefaults(code, { into, where, problems }) {
	for (const match of code.matchAll(ENV_FLAG)) {
		addDefault(into, { name: match[1], value: match[2].startsWith('!') ? 'true' : 'false', where }, problems);
	}
}

function isTouchedEnvLine(line) {
	return line.includes('process.env') || INDIRECT_ENV.test(line);
}

/** Whether every `process.env` on the line is a plain read, and every comparison of one is a flag. */
function isUnderstoodEnvLine(line) {
	if (INDIRECT_ENV.test(line) || NEGATED_ENV.test(line)) return false;
	const reads = [...line.matchAll(ENV_READ)].length;
	const flags = [...line.matchAll(ENV_FLAG)].length;
	const comparisons = [...line.matchAll(ENV_COMPARISON)].length;
	return line.split('process.env').length - 1 === reads && comparisons === flags;
}

/** The code lines that touch something (`isTouched`) in a form the readers cannot interpret
 * (`isUnderstood` is false): reported, instead of silently skipped. */
function unrecognisedLines(file, text, isTouched, isUnderstood) {
	return text.split('\n').flatMap((line, index) => {
		if (isJsComment(line) || !isTouched(line) || isUnderstood(line)) return [];
		return [`${file}:${index + 1} uses a form this check does not understand (${line.trim().slice(0, 80)}). Write it the way the rest of the code does, or extend the patterns in scripts/check-wiki-docs.mjs, so the setting is not missed.`];
	});
}

function isServiceSource(path) {
	return !path.includes('node_modules') && !path.includes(`${SERVICE_DIR}/scripts`) && !/\.test\.[cm]?js$/.test(path);
}

function readServiceEnv(root, problems) {
	const files = listFiles(join(root, SERVICE_DIR), ['.js', '.mjs', '.cjs'], (path) => !isServiceSource(path));
	if (files.length === 0) problems.push(`${SERVICE_DIR}/*.js not found, but scripts/check-wiki-docs.mjs reads the environment variables from it.`);
	const names = new Set();
	const defaults = new Map();
	for (const file of files) {
		const text = readFileSync(file, 'utf8');
		const code = codeOf(text, isJsComment);
		const where = file.slice(root.length + 1);
		for (const match of code.matchAll(ENV_READ)) names.add(match[1] ?? match[2]);
		collectDefaults(code, { patterns: [ENV_DEFAULT_OR, ENV_DEFAULT_ARG], into: defaults, where, problems });
		collectFlagDefaults(code, { into: defaults, where, problems });
		problems.push(...unrecognisedLines(where, text, isTouchedEnvLine, isUnderstoodEnvLine));
	}
	return { names, defaults };
}

function readRoutes(root, problems) {
	const text = readText(root, SERVER_FILE, problems);
	problems.push(...unrecognisedLines(SERVER_FILE, text, (line) => ROUTE_LIKE.test(line), (line) => new RegExp(ROUTE.source).test(line)));
	return new Set([...codeOf(text, isJsComment).matchAll(ROUTE)].map((match) => `${match[1].toUpperCase()} ${match[2]}`));
}

function readRestRoutes(text) {
	const calls = [...text.matchAll(REST_ROUTE)];
	return calls.map((call, index) => {
		const body = text.slice(call.index, calls[index + 1]?.index ?? text.length);
		const methods = REST_METHOD.exec(body);
		const verb = methods?.[1] ?? REST_VERBS[methods?.[2]] ?? '?';
		return `${verb} /wp-json/${call[1]}${call[2]}`;
	});
}

function readPlugin(root, problems) {
	const files = listFiles(join(root, PLUGIN_DIR), ['.php']);
	if (files.length === 0) problems.push(`${PLUGIN_DIR}/*.php not found, but scripts/check-wiki-docs.mjs reads the WPCC_* constants from it.`);
	const names = new Set();
	const defaults = new Map();
	const routes = new Set();
	for (const file of files) {
		const code = codeOf(readFileSync(file, 'utf8'), isPhpComment);
		for (const match of code.matchAll(PHP_CONSTANT)) names.add(match[0]);
		collectDefaults(code, { patterns: [PHP_DEFAULT], into: defaults, where: file.slice(root.length + 1), problems });
		for (const route of readRestRoutes(code)) routes.add(route);
	}
	return { names, defaults, routes };
}

/** The Dockerfile's instructions with backslash continuations joined and comments dropped. */
function dockerInstructions(text) {
	const instructions = [];
	let pending = '';
	for (const line of text.split('\n')) {
		const trimmed = line.trim();
		if (trimmed.startsWith('#')) continue;
		if (trimmed.endsWith('\\')) {
			pending += `${trimmed.slice(0, -1)} `;
		} else if (pending !== '' || trimmed !== '') {
			instructions.push(pending + trimmed);
			pending = '';
		}
	}
	if (pending !== '') instructions.push(pending.trim());
	return instructions;
}

/** A value at the start of `text`, quoted or not, and what follows it. */
function takeValue(text) {
	const quote = text[0];
	if (quote === '"' || quote === "'") {
		const close = text.indexOf(quote, 1);
		return close === -1 ? [text.slice(1), ''] : [text.slice(1, close), text.slice(close + 1)];
	}
	const end = text.search(/\s/);
	return end === -1 ? [text, ''] : [text.slice(0, end), text.slice(end)];
}

/** The `NAME=value` pairs of one ENV instruction (or the legacy `ENV NAME value`). */
function parseEnvPairs(rest) {
	const pairs = new Map();
	let remaining = rest.trim();
	const firstEquals = remaining.indexOf('=');
	const firstSpace = remaining.search(/\s/);
	if (firstEquals === -1 || (firstSpace !== -1 && firstSpace < firstEquals)) {
		if (firstSpace !== -1) {
			// Legacy form: the value is the rest of the line, quoted or not.
			const value = remaining.slice(firstSpace).trim();
			pairs.set(remaining.slice(0, firstSpace), value.startsWith('"') || value.startsWith("'") ? takeValue(value)[0] : value);
		}
		return pairs;
	}
	while (remaining !== '') {
		const separator = remaining.indexOf('=');
		if (separator <= 0) break;
		const [value, after] = takeValue(remaining.slice(separator + 1));
		pairs.set(remaining.slice(0, separator), value);
		remaining = after.trimStart();
	}
	return pairs;
}

/** The environment variables a Dockerfile sets, as `name -> value`. */
export function parseDockerfileEnv(text) {
	const variables = new Map();
	for (const instruction of dockerInstructions(text)) {
		if (instruction.slice(0, 3).toUpperCase() !== 'ENV' || !/\s/.test(instruction[3] ?? '')) continue;
		for (const [name, value] of parseEnvPairs(instruction.slice(4))) variables.set(name, value);
	}
	return variables;
}

/** The Dockerfile's ENV values. Only a single-stage Dockerfile is understood: with more stages it is
 * unclear which ENV reaches the image, so that fails loudly instead of guessing. */
function readImageEnvironment(root, problems) {
	const text = readText(root, DOCKERFILE, problems);
	if (dockerInstructions(text).filter((instruction) => /^FROM\s/i.test(instruction)).length > 1) {
		problems.push(`${DOCKERFILE} has more than one stage; scripts/check-wiki-docs.mjs reads the ENV of every stage as if it reached the image. Teach it which stage is the final one.`);
	}
	return parseDockerfileEnv(text);
}

function readEnvExampleKeys(root, problems) {
	const text = readText(root, ENV_EXAMPLE_FILE, problems);
	return new Set([...text.matchAll(new RegExp(`^(${NAME})=`, 'gm'))].map((match) => match[1]));
}

function readEgressVariables(root, problems) {
	const text = readText(root, EGRESS_COMPOSE_FILE, problems);
	return new Set([...text.matchAll(/\$\{(EGRESS_[A-Z0-9_]+)/g)].map((match) => match[1]));
}

function readPluginRequirements(root, problems) {
	const text = readText(root, PLUGIN_HEADER_FILE, problems);
	return {
		wordpress: /Requires at least:\s*([\d.]+)/.exec(text)?.[1],
		php: /Requires PHP:\s*([\d.]+)/.exec(text)?.[1],
	};
}

/** The rows of a page's tables as `name -> { cells, heading }`; a row whose first cell is not one
 * code span is reported. */
function documentedRows(page, pageText, headings, problems) {
	const documented = new Map();
	for (const heading of headings) {
		for (const cells of tableRows(pageText, heading) ?? []) {
			const name = codeValue(cells[0]);
			if (name === null) {
				problems.push(`docs/wiki/${page}.md ("${heading}"): the first column of each row must be one \`code\` name.`);
				continue;
			}
			if (documented.has(name)) problems.push(`docs/wiki/${page}.md lists \`${name}\` twice ("${documented.get(name).heading}" and "${heading}"). Keep one row.`);
			documented.set(name, { cells, heading });
		}
	}
	return documented;
}

/** The problem with a row's Default column, if any. `expected` is the default the source states
 * (undefined when it states none that can be read): a stated default must be the row's (unless
 * `descriptive`: a row of the image table may describe its value in a few words instead of quoting it), and
 * a default the row claims in code formatting must be one that can be checked. */
function defaultProblem({ kind, name, page, where, cells, expected, describe, descriptive = false }) {
	const cell = cells[2] ?? '';
	if (expected === undefined) {
		return cell.includes('`')
			? `${kind} ${name}: docs/wiki/${page}.md ("${where}") lists a default, but there is none this check can read in the source. Use a literal default (after ||, ?? or as the argument; \`!== 'false'\` and \`=== 'true'\` for flags), or write - in the Default column.`
			: null;
	}
	return mentionsCode(cell, expected) || (descriptive && /\s/.test(cell.trim()) && !cell.includes('`'))
		? null
		: `${kind} ${name}: ${describe} ${expected}, but docs/wiki/${page}.md ("${where}") lists a different default. Write the default in the Default column as \`${expected}\`.`;
}

/** The problem with one documented row: a row of the image table needs a variable the Dockerfile sets
 * and its value; a row of the main table needs a name the code still reads and its default (the image's
 * value wins, because a variable the image sets always arrives with it, whatever the code falls back to). */
function rowProblem({ kind, name, page, heading, where, cells, codeNames, codeDefaults, imageEnvironment }) {
	const common = { kind, name, page, where, cells };
	if (where !== heading) {
		return imageEnvironment.has(name)
			? defaultProblem({ ...common, expected: imageEnvironment.get(name), describe: `${DOCKERFILE} sets it to`, descriptive: true })
			: `${kind} ${name} is documented in docs/wiki/${page}.md ("${where}") as set by the image, but ${DOCKERFILE} does not set it.`;
	}
	if (!codeNames.has(name)) return `${kind} ${name} is documented in docs/wiki/${page}.md ("${heading}") but the code no longer reads it.`;
	const fromImage = imageEnvironment.has(name);
	const expected = fromImage ? imageEnvironment.get(name) : codeDefaults.get(name);
	return defaultProblem({ ...common, expected, describe: fromImage ? `${DOCKERFILE} sets it to` : 'the code defaults to' });
}

/** Compares a reference table with what the code defines, in both directions: every name the code
 * reads needs a row (in this table, or in `extraHeadings` for what the image sets), every row of
 * this table needs a name the code still reads, a row of the image table needs a variable the
 * Dockerfile still sets, and each default has to be the one the source states. */
function checkReferenceTable({ page, pageText, heading, extraHeadings = [], codeNames, codeDefaults, imageEnvironment = new Map(), kind }) {
	for (const section of [heading, ...extraHeadings]) {
		if (tableRows(pageText, section) === null) return [`docs/wiki/${page}.md has no "## ${section}" section.`];
	}
	const problems = [];
	const documented = documentedRows(page, pageText, [heading, ...extraHeadings], problems);
	for (const name of codeNames) {
		if (!documented.has(name)) problems.push(`${kind} ${name} is read by the code but has no row in docs/wiki/${page}.md ("${heading}").`);
	}
	for (const [name, { cells, heading: where }] of documented) {
		problems.push(rowProblem({ kind, name, page, heading, where, cells, codeNames, codeDefaults, imageEnvironment }));
	}
	return problems.filter(Boolean);
}

function checkEndpoints(pageText, codeEndpoints) {
	const rows = tableRows(pageText, 'Endpoints');
	if (rows === null) return ['docs/wiki/Configuration.md has no "## Endpoints" section.'];
	const documented = new Set(rows.map((cells) => `${codeValue(cells[0])} ${codeValue(cells[1])}`));
	const problems = [];
	for (const endpoint of codeEndpoints) {
		if (!documented.has(endpoint)) problems.push(`Endpoint ${endpoint} exists in the code but not in the "Endpoints" table of docs/wiki/Configuration.md.`);
	}
	for (const endpoint of documented) {
		if (!codeEndpoints.has(endpoint)) problems.push(`Endpoint ${endpoint} is in the "Endpoints" table of docs/wiki/Configuration.md but not in the code.`);
	}
	return problems;
}

function checkEnvExample(envKeys, serviceNames) {
	return [...envKeys]
		.filter((name) => !serviceNames.has(name))
		.map((name) => `.env.example sets ${name}, which the service does not read.`);
}

function checkRequirements(gettingStarted, requirements) {
	const problems = [];
	for (const [label, header, version] of [['WordPress', 'Requires at least', requirements.wordpress], ['PHP', 'Requires PHP', requirements.php]]) {
		if (!version) {
			problems.push(`${PLUGIN_HEADER_FILE} has no "${header}" header.`);
		} else if (!mentionsVersion(gettingStarted, label, version)) {
			problems.push(`The plugin requires ${label} ${version} (${PLUGIN_HEADER_FILE}), but docs/wiki/Getting-Started.md does not say "${label} ${version}".`);
		}
	}
	return problems;
}

function checkEgressVariables(egressPage, variables) {
	return [...variables]
		.filter((name) => !mentionsCode(egressPage, name))
		.map((name) => `${EGRESS_COMPOSE_FILE} reads ${name}, but docs/wiki/Network-Egress-Filtering.md does not document it.`);
}

function checkAgainstCode(root, pages) {
	const problems = [];
	const configuration = pages.get('Configuration') ?? '';
	const service = readServiceEnv(root, problems);
	const plugin = readPlugin(root, problems);
	const endpoints = new Set([...readRoutes(root, problems), ...plugin.routes]);
	problems.push(
		...checkReferenceTable({ page: 'Configuration', pageText: configuration, heading: 'Service settings', extraHeadings: ['Set by the image'], codeNames: service.names, codeDefaults: service.defaults, imageEnvironment: readImageEnvironment(root, problems), kind: 'Setting' }),
		...checkReferenceTable({ page: 'Configuration', pageText: configuration, heading: 'WordPress settings', codeNames: plugin.names, codeDefaults: plugin.defaults, kind: 'Constant' }),
		...checkEndpoints(configuration, endpoints),
		...checkEnvExample(readEnvExampleKeys(root, problems), service.names),
		...checkRequirements(pages.get('Getting-Started') ?? '', readPluginRequirements(root, problems)),
		...checkEgressVariables(pages.get('Network-Egress-Filtering') ?? '', readEgressVariables(root, problems)),
	);
	return problems;
}

// ---------------------------------------------------------------------------------------------

/** Every problem found in the repository at `root`; an empty array means the Wiki source is valid. */
export function checkWiki(root) {
	const wikiRoot = join(root, 'docs/wiki');
	const problems = checkWikiSource(root, wikiRoot);
	if (existsSync(wikiRoot)) problems.push(...checkAgainstCode(root, readPages(wikiRoot)));
	return problems;
}

function main() {
	const root = resolve(fileURLToPath(import.meta.url), '../..');
	const problems = checkWiki(root);
	for (const problem of problems) console.error(`docs:check: ${problem}`);
	if (problems.length > 0) {
		console.error(`docs:check: ${problems.length} problem(s). Fix docs/wiki (or the code it describes); never edit the GitHub Wiki directly.`);
		process.exitCode = 1;
		return;
	}
	console.log('docs:check: the Wiki source is valid and matches the code.');
}

/** Whether this file is the one being run. `import.meta.url` is the real path, `argv[1]` is as
 * typed, so a run through a symbolic link has to be resolved first, or the script would exit 0
 * without checking anything. */
function isEntryPoint() {
	try {
		return process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
	} catch {
		return false;
	}
}

if (isEntryPoint()) main();
