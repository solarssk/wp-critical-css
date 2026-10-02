#!/usr/bin/env node
// Checks that a pull request's "Documentation impact" declaration (see
// .github/pull_request_template.md) agrees with what the pull request changes. Run by the
// `wiki-docs` job in ci.yml on pull requests only.
//
//   - exactly one of "Docs updated" / "No doc update needed - <reason>" is ticked, and both
//     template lines are still there;
//   - "Docs updated" needs a documentation file in the diff;
//   - "No doc update needed" needs a real reason, and cannot be ticked when docs/wiki changed.
//
// The description and the changed files are read from the GitHub API when the job runs, not from
// the event payload: a re-run of a job replays the payload of the original event, so a description
// fixed after the first run would otherwise keep failing until a new commit was pushed.
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const API = 'https://api.github.com';
const FILES_PER_PAGE = 100;
const MAX_FILE_PAGES = 30; // the API lists at most 3000 files of a pull request
const ATTEMPTS = 3;
const MIN_REASON_LENGTH = 10;

const HEADING = '## documentation impact';
const DOCS_UPDATED = /^- \[([ xX])\] Docs updated\b.*$/m;
const NO_DOC_UPDATE = /^- \[([ xX])\] No doc update needed\b(.*)$/m;

/** The description without its HTML comments, so a line left inside the template's own comment
 * can never count as a declaration. */
function withoutComments(body) {
	let text = '';
	let position = 0;
	while (position < body.length) {
		const open = body.indexOf('<!--', position);
		if (open === -1) break;
		text += body.slice(position, open);
		const close = body.indexOf('-->', open + 4);
		position = close === -1 ? body.length : close + 3;
	}
	return text + body.slice(position);
}

/** The "Documentation impact" section of the description, without its HTML comments, or null: only
 * lines inside it count, so a similar line elsewhere in the description is not a declaration. */
function declarationSection(body) {
	const lines = withoutComments(body).split('\n');
	const start = lines.findIndex((line) => line.trim().toLowerCase() === HEADING);
	if (start === -1) return null;
	const rest = lines.slice(start + 1);
	const end = rest.findIndex((line) => line.startsWith('## ') || line.trim() === '---');
	return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}

/** A reason is real when it has enough letters and digits of its own: punctuation, "n/a" and the
 * template's own placeholder do not count. */
function isRealReason(reason) {
	const significant = [...reason.toLowerCase()].filter((character) => /[\p{L}\p{N}]/u.test(character)).join('');
	return significant.length >= MIN_REASON_LENGTH && significant !== 'explainwhy';
}

function reasonOf(rest) {
	let start = 0;
	while (start < rest.length && ' \t-–—:'.includes(rest[start])) start += 1;
	return rest.slice(start).trim();
}

/** A file whose change counts as a documentation update. */
export function isDocumentationFile(path) {
	return path.startsWith('docs/') || path.endsWith('.md') || path.endsWith('readme.txt') || path === '.env.example';
}

/** Problems with the declaration in `body` given the pull request's changed file paths. */
export function evaluateDeclaration(body, changedFiles) {
	const text = declarationSection(body) ?? '';
	const docs = DOCS_UPDATED.exec(text);
	const none = NO_DOC_UPDATE.exec(text);
	if (!docs || !none) {
		return ['Keep both lines of the "Documentation impact" section from the template, "- [ ] Docs updated" and "- [ ] No doc update needed - <reason>", and tick one.'];
	}
	const docsTicked = docs[1] !== ' ';
	const noneTicked = none[1] !== ' ';
	if (docsTicked === noneTicked) {
		return [docsTicked
			? 'Both "Docs updated" and "No doc update needed" are ticked. Tick exactly one.'
			: 'Neither "Docs updated" nor "No doc update needed" is ticked. Tick exactly one.'];
	}
	if (docsTicked) {
		return changedFiles.some((path) => isDocumentationFile(path))
			? []
			: ['"Docs updated" is ticked, but the pull request changes no documentation file (docs/, any .md, readme.txt, .env.example). Update the docs, or tick "No doc update needed" with a reason.'];
	}
	const problems = [];
	if (!isRealReason(reasonOf(none[2]))) {
		problems.push('"No doc update needed" needs a specific reason after the dash, for example "CI-only change, nothing user-visible". Replace the template\'s placeholder.');
	}
	if (changedFiles.some((path) => path.startsWith('docs/wiki/'))) {
		problems.push('docs/wiki changed, so tick "Docs updated" instead of "No doc update needed".');
	}
	return problems;
}

/** By the author's login only: a branch name is the contributor's own choice, so a name such as
 * `dependabot/x` must not exempt a human's pull request. */
export function isAutomatedDependencyPr({ author }) {
	return author === 'dependabot[bot]' || author === 'renovate[bot]';
}

async function pause(milliseconds) {
	await new Promise((done) => setTimeout(done, milliseconds));
}

async function getJson(url, { token, fetchImpl, retryDelayMs }) {
	let failure = 'no answer';
	for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
		try {
			const response = await fetchImpl(url, {
				headers: {
					Accept: 'application/vnd.github+json',
					Authorization: `Bearer ${token}`,
					'User-Agent': 'wp-critical-css-docs-check',
					'X-GitHub-Api-Version': '2022-11-28',
				},
			});
			if (response.ok) return await response.json();
			failure = `HTTP ${response.status}`;
			if (response.status < 500) break;
		} catch (error) {
			failure = error.message;
		}
		if (attempt < ATTEMPTS) await pause(retryDelayMs * attempt);
	}
	throw new Error(`could not read ${url} from the GitHub API (${failure}); re-run the job`);
}

/** The pull request as it is right now: its description, author and changed file paths. */
export async function loadPullRequest({ repository, number, token, fetchImpl = fetch, retryDelayMs = 1000 }) {
	const options = { token, fetchImpl, retryDelayMs };
	const base = `${API}/repos/${repository}/pulls/${number}`;
	const pullRequest = await getJson(base, options);
	const files = [];
	for (let page = 1; page <= MAX_FILE_PAGES; page += 1) {
		const batch = await getJson(`${base}/files?per_page=${FILES_PER_PAGE}&page=${page}`, options);
		// A renamed file counts under both names: moving a page out of docs/wiki is a docs change too.
		files.push(...batch.flatMap((file) => (file.previous_filename ? [file.filename, file.previous_filename] : [file.filename])));
		if (batch.length < FILES_PER_PAGE) break;
	}
	return {
		body: pullRequest.body ?? '',
		author: pullRequest.user?.login ?? '',
		files,
	};
}

async function main() {
	const eventPath = process.env.GITHUB_EVENT_PATH;
	if (process.env.GITHUB_EVENT_NAME !== 'pull_request' || !eventPath) {
		console.log('docs:pr-check: not a pull request; nothing to check.');
		return;
	}
	const number = JSON.parse(readFileSync(eventPath, 'utf8')).pull_request?.number;
	const repository = process.env.GITHUB_REPOSITORY;
	const token = process.env.GITHUB_TOKEN;
	if (!number || !repository || !token) {
		throw new Error('GITHUB_REPOSITORY, GITHUB_TOKEN and a pull request event are required');
	}
	const pullRequest = await loadPullRequest({ repository, number, token });
	if (isAutomatedDependencyPr(pullRequest)) {
		console.log('docs:pr-check: automated dependency pull request; no documentation declaration expected.');
		return;
	}
	const problems = evaluateDeclaration(pullRequest.body, pullRequest.files);
	for (const problem of problems) console.error(`docs:pr-check: ${problem}`);
	if (problems.length > 0) {
		console.error('docs:pr-check: fix the pull request description and re-run this job; no new commit is needed.');
		process.exitCode = 1;
		return;
	}
	console.log('docs:pr-check: the documentation declaration agrees with the diff.');
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

if (isEntryPoint()) {
	try {
		await main();
	} catch (error) {
		console.error(`docs:pr-check: ${error.message}`);
		process.exitCode = 1;
	}
}
