# Editing the Wiki

These pages are **not edited in the Wiki**. Their only source is the `docs/wiki/` folder of the repository, and a workflow publishes it to this Wiki after every merge to `main` that changes that folder. Whatever is typed into the Wiki's own editor is overwritten by the next publish.

That makes the documentation reviewable like code, versioned with the release it describes, and checked on every pull request.

## Change a page

1. Create a branch (`docs/<slug>`) and edit the file in `docs/wiki/`. Each page is plain Markdown.
2. Check it locally. It needs only Node 24, no install:

   ```bash
   node scripts/check-wiki-docs.mjs
   ```

3. Open a pull request. Under **Documentation impact** tick *Docs updated*.
4. After the merge, the **Publish wiki** workflow replaces the Wiki with the folder's contents. It runs when a push to `main` changes `docs/wiki/` (or the workflow itself), and you can start it by hand from the Actions tab, on `main` only.

## Page conventions

- **The file name is the page's address.** `Getting-Started.md` is the page "Getting Started". Use letters, digits and hyphens only.
- **The first line is the title**, `# Getting Started` - the file name with spaces - and it is the only `# ` heading on the page. (`Home` may use any title.)
- **Link pages by name, with no extension:** `[Configuration](Configuration)`, or to a heading with `[text](Configuration#endpoints)`. A link to another folder or a `.md` file would break in the Wiki.
- **Link repository files by their full address:** `https://github.com/solarssk/wp-critical-css/blob/main/docs/DEPLOYMENT.md#releases`. CI checks that the file, and the heading, exist.
- **Images** go under `docs/wiki/images/` (by convention; CI only requires the file to exist under `docs/wiki/`) and need alt text.
- **No real secrets or real hosts in examples.** Use placeholders and `example.com`.
- **New page:** create the file, add it to `_Sidebar.md`, and - if the Wiki cannot do without it - add its name to `REQUIRED_PAGES` in `scripts/check-wiki-docs.mjs`.

## What CI checks

The `wiki-docs` job in `ci.yml` runs on every pull request and on every push to `main` (the declaration check only on pull requests, and not for Dependabot or Renovate):

| Check | What fails it |
|---|---|
| Structure | A required page is missing; a page name with characters other than letters, digits and hyphens; a page with no title, a title that is not its file name, or a second `# ` heading; a page the sidebar does not link to; trailing whitespace, a space before a tab, a conflict marker or a blank line at the end of a page (what `git diff --check` rejects when publishing); anything in `docs/wiki/` that is not a regular Markdown page or an image under `images/` (symbolic links and hidden files would be published unchecked). |
| Links | A link to a page, heading or repository file that does not exist; a relative link that would break in the Wiki; an image without alt text. |
| Secrets | A 64-character hex value, which looks like a real shared secret. |
| Reference tables | The tables on [Configuration](Configuration) no longer match the code, see below. |
| Requirements | [Getting Started](Getting-Started) does not state the WordPress and PHP versions the plugin header requires. |
| Egress variables | A variable of `docker-compose.egress.example.yml` is not documented on [Network Egress Filtering](Network-Egress-Filtering). |
| The checkers | The unit tests of the two checker scripts fail. |
| Documentation impact (pull requests) | The pull request's *Documentation impact* section contradicts its diff, see below. |

### The reference tables follow the code

[Configuration](Configuration) holds three tables whose rows are compared with the source on every run:

- **Service settings** against the environment variables `service/*.js` reads (`process.env.NAME`), including each default that can be read from the code;
- **WordPress settings** against the `WPCC_*` constants the plugin defines or checks, including their defaults;
- **Endpoints** against the routes in `service/server.js` and the plugin's REST route.

Add an environment variable, a constant or a route, and the build fails until its row exists. Remove one, and it fails until the row is gone. Variables the image sets (and the code reads) can go in the **Set by the image** table instead of **Service settings**. Change a default, and it fails until the **Default** column says so, written as `` `value` `` in code formatting. `.env.example` may only set variables the service actually reads. The checker only understands the forms this code base uses (`process.env.NAME`, `app.get('/path', ...)`); a line that touches `process.env` or a route in another form fails the job instead of being skipped, so the setting is never missed silently.

### The documentation declaration

Every pull request description has a **Documentation impact** section with two lines. Tick exactly one: *Docs updated*, or *No doc update needed* followed by a specific reason. CI compares your choice with the diff: *Docs updated* needs a documentation file in the change, and *No doc update needed* cannot be ticked when `docs/wiki/` changed. CI reads the description when the job runs, so after fixing a wrong description you only have to re-run the failed job.

## Publishing

`.github/workflows/publish-wiki.yml` runs on a push to `main` that touches `docs/wiki/`, and on demand. It re-runs the same check, so a source CI would reject is never published, clones the Wiki, makes it match `docs/wiki/` exactly (pages deleted from the folder are deleted from the Wiki), and commits as `github-actions[bot]`. The Wiki is a separate git repository; pushing to it uses the workflow's own `GITHUB_TOKEN`, so no extra secret is needed. The Wiki's git repository only exists once its first page has been created by hand in the repository's Wiki tab; until then the first publish fails with a message saying so.
