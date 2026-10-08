# Parity fixtures: what `critical@8.0.0` did with a page and its stylesheets

These fixtures freeze the behaviour of the part of `critical` that this project re-implements itself
(page fetch -> stylesheet discovery -> `url()` rebasing -> one concatenated css string, and the layout copy
of the page that is handed to penthouse), recorded while `critical` was still installed. They let the
replacement be tested byte for byte in plain unit tests: no `critical`, no Chrome, no network.

* 307 cases: **254 parity cases** (directly under this directory: the new layer must produce what `critical`
  produced) and **53 deliberate-deviation cases** (under `_deviations/`: it must differ on purpose, see "Deviations").
  Every expectation is decided (see "Decisions"); a case the new layer treats differently from `critical` is always a deviation.
* One pure-function table, `_units/stylesheet-path.json` (18 rows).
* Every case was recorded twice in a row and the two recordings were identical (the recorder aborts otherwise).
  The whole tree was also rebuilt from the case inputs, twice, from an empty directory, with byte-identical
  results, and re-recorded by an independent second recorder (Node 26 and Node 24) with the same bytes.
* Nothing here is third-party content: the pages and stylesheets are synthetic, in WordPress-theme style.

## Provenance

| | |
|---|---|
| Recorded from | `critical@8.0.0` (with `got@15.1.0`, `oust@2.0.4`, `postcss-url@10.1.4`, `cheerio@1.2.0`), the versions in `service/package-lock.json` at the time |
| Function | `getDocument(pageUrl, { request: {} })` exported by `critical/file.js` (for the `html` cases `getDocumentFromSource(html, { request: {} })`). This is exactly what `generate({ src })` / `generate({ html })` call first, with `critical`'s own defaults (`strict: false`, `ignoreInlinedStyles: false`, no `rebase`, no `base`) and **without** the SSRF hooks that `server.js` adds (the servers are loopback). |
| What is captured | `document.css` (the stylesheets joined as `critical` joins them), `document.virtualPath`, `document.stylesheets`, `document.stylesheetsMedia`, or the thrown error's message; for the `layout` cases also the layout copy (the temp html file `document.url` points at); for `_units/` the return value of `getStylesheetPath()` |
| What is not captured | penthouse, Chrome, the postcss step, CleanCSS |
| Servers | two plain `node:http` servers on `127.0.0.1:18981` ({{site}}, also reachable as {{alias}}) and `127.0.0.1:18982` ({{cdn}}), started fresh for every recording; they honour `status`, `type`, `headers` (redirects), compress when the client asks and the route says so, and answer HEAD like GET unless a route says otherwise |
| Environment | Node 26.0.0, macOS arm64; recorder run with an empty working directory and an isolated `TMPDIR` (see "Things that depend on the machine"). Re-recorded with Node 24.18.0 as well (same major as the Docker image): identical. A Linux run was not possible (no Node image available offline). |
| Recorder | a throw-away script that is **not** part of the repository (it imports `critical`, which is being removed). Algorithm in "Adding a case". |

## Layout

```
service/fixtures/parity/
  README.md
  .gitattributes               "* -text" (git must never convert these files) and linguist-generated (see "Line endings and git")
  <case-name>/                 254 parity cases
    case.json                  input description + what critical produced ("expect") + what the new layer must do ("thin", deviations only)
    page.html                  the page (any file name; referenced by a route, or by "html")
    *.css, ...                 stylesheets and other bodies the routes serve
    expected.css               EXACT bytes of critical's document.css (only when expect.kind is "css")
    expected-layout.html       EXACT bytes of the layout copy (only when "layout" is true)
  _deviations/<case-name>/     53 cases where the new layer must deliberately differ
    (same files as above, plus)
    critical.txt               what critical did, incl. every request it made, and what the new layer must do
    expected-thin.css          what the new layer must produce, when it differs from expected.css (see thin)
    expected-thin-layout.html  the layout copy the new layer must produce, when it differs (see thin.layout)
  _units/stylesheet-path.json  pure-function table (see "Pure-function table")
```

The case names carry the area: `discovery-`, `media-`, `inline-`, `data-uri-`, `href-`, `page-url-`,
`page-` (page shapes), `redirect-`, `base-`, `rebase-`, `content-`, `transport-`, `failure-`, `layout-`, `html-entry-`,
`wordpress-` (one realistic homepage combining most of the above).

## Placeholders

The fixed origins appear in files as placeholders, so the case files do not hard-code them:

| placeholder | value |
|---|---|
| `{{site}}` | `http://127.0.0.1:18981` |
| `{{cdn}}` | `http://127.0.0.1:18982` |
| `{{alias}}` | `http://localhost:18981`: the **same server** as `{{site}}`, reached under another hostname |
| `{{site_host}}` | `127.0.0.1:18981` (for protocol-relative `//` URLs) |
| `{{cdn_host}}` | `127.0.0.1:18982` |
| `{{alias_host}}` | `localhost:18981` |

Rules a test must follow:

1. In **input** files (`page.html`, stylesheets, any route `body`/`file`) and in `case.json`
   (`pageUrl`, route keys, route `headers`/`body`, `thin.derive`) substitute the six tokens (plain string replace) before use.
   Substitute on bytes, not on decoded text, for the two files that are not valid UTF-8
   (`transport-invalid-utf8-bytes/l1.css`, `page-not-utf8-latin1-bytes/page.html`).
2. **`expected.css`, `expected-thin.css`, `expected-layout.html` and `expected-thin-layout.html` are raw: never
   substitute in them.** They legitimately contain the literal origins (`url(http://127.0.0.1:18982/assets/img/a.png)`,
   `<link href="http://127.0.0.1:18981/...">` in a layout copy), because that is what `critical` produced.
3. In the *recorded results inside `case.json`* (`expect.stylesheets`, `expect.message`) the origins were turned
   **back** into placeholders (full origins first, then the bare `host:port` forms). Substitute them forward before
   comparing with the new layer's output, or compare after reversing the new layer's.

### Two notions of "the same host" (keep both, name them apart)

1. **Stylesheet same-host rule**: **hostname + port with the scheme ignored** and default ports dropped (what the URL parser
   reports as `host`). `critical` compares it when it rebases `url()`s (`getStylesheetPath()`, the `_units` table), and the
   stylesheet failure policy uses the same notion: the host of the LAST URL requested for a stylesheet (after its redirects)
   against the host of the FINAL page URL; same host -> the job fails, another host -> the sheet is skipped with one warning.
2. **Allowed page host**: production's `isAllowedUrl(url, ALLOWED_HOSTNAME)` from `lib.js`, a **hostname** comparison, pins the
   page's own redirects. The page-loading code takes it as an injectable predicate (`isPageHostAllowed(url)`). The two loopback
   origins `{{site}}` and `{{cdn}}` share the hostname `127.0.0.1`, which a hostname comparison cannot tell apart, so a fixture
   test injects a `host:port` predicate for `redirect-page-off-host` (production's hostname predicate would follow that redirect);
   `redirect-page-off-host-alias-hostname` fails under both, so it can also run with the production predicate
   (`isAllowedUrl(url, '127.0.0.1')`).

The three origins differ like this:

| pair | `host` (hostname:port) | hostname only | port only |
|---|---|---|---|
| `{{site}}` vs `{{cdn}}` | different | **same** | different |
| `{{site}}` vs `{{alias}}` | different | different | **same** |

Everything that treats `{{cdn}}` as another host (the rebasing of CDN sheets, the `*-cdn` cases) therefore needs the
`host:port` comparison of the stylesheet rule, and `redirect-page-off-host` needs the injected `host:port` page predicate. The cases
that are "another host" under a hostname comparison as well are the three that use `{{alias}}`:
`rebase-sheet-on-alias-hostname`, `failure-stylesheet-404-alias-hostname` and `redirect-page-off-host-alias-hostname`
(they also catch a comparison on the port alone). The scheme and default-port rules cannot be shown with plain-http
servers; they are in `_units/stylesheet-path.json`.

## `case.json`

```jsonc
{
  "description": "one sentence: the behaviour this case isolates",
  "pageUrl": "{{site}}/blog/hello-world/",        // the URL given to getDocument ... or instead:
  "html": "page.html",                            // ... a file holding the html given to the `html:` entry point
  "layout": true,                                 // optional: also capture the layout copy (expected-layout.html)
  "down": ["cdn"],                                // optional: origins that are NOT listening ("site" also takes {{alias}} down)
  "routes": {                                     // what the two servers answer
    "/": { "status": 200, "type": "text/html; charset=UTF-8", "file": "page.html" },
    "{{cdn}}/assets/main.css": { "status": 200, "type": "text/css", "file": "main.css", "encoding": "gzip" },
    "/old.css": { "status": 302, "type": "text/plain", "body": "Redirecting", "headers": { "location": "/new.css" } }
  },
  "thin": { "kind": "fail|skip|differs|same", "note": "...", "derive": { "routes": {} }, "cssFile": "expected-thin.css",
            "layout": "literal", "layoutFile": "expected-thin-layout.html" },   // _deviations/ only, see "Reading the new layer's expectation"
  "expect": { ... }                               // written by the recorder
}
```

**`routes`** maps a URL to a response.

* Key: `{{site}}/...`, `{{cdn}}/...`, `{{alias}}/...`, or a path starting with `/` (= relative to `{{site}}`). Matching is on
  origin + path + query string, **exactly** as written (fragments are never sent). No route matches ->
  `404`, `text/plain`, body `Not Found`.
* `status` (integer) and `type` (the `Content-Type` value; `null` = send no Content-Type header at all) are
  always present. The body is `file` (a file in the case directory), or `body` (inline string), or empty.
* `headers`: extra response headers (used for `location`).
* `encoding` (`gzip` | `deflate` | `br`): the recorder compressed the body when the client's `Accept-Encoding`
  allowed it. A fake transport in a unit test can ignore it (it exists so `critical`'s decompression path was
  exercised while recording; the new client's decompression is a separate real-HTTP test).
* `head`: `{ "status": ... }` (optionally `type`/`headers`) overrides the answer to **HEAD** requests only.
  `critical` sends HEAD probes before GET; the new layer sends GET only, so a fake transport ignores `head`
  (it exists to reproduce servers that reject HEAD).
* `down`: requests to a listed origin must fail as a **connection error** (connection refused), not as a 404.

**`expect`** (the recorded result of `getDocument`):

```jsonc
// kind "css"
{ "kind": "css",
  "cssFile": "expected.css",                 // exact bytes of document.css
  "virtualPath": "/blog/hello-world/index.html",   // pathname of the final page URL, "index.html" appended after a trailing "/"; "" for the html entry point
  "stylesheets": [ "{{site}}/a.css", "css/b.css", { "inline": ".x{color:red}" } ],
  "stylesheetsMedia": [ "", "", "(max-width: 600px)" ],
  "layoutFile": "expected-layout.html" }     // only with "layout": true
// kind "error"  (critical threw; the message is informational, the new layer's own message will differ)
{ "kind": "error", "message": "Error: File not found: css/gone.css\n  Current working directory: <cwd>\n  ..." }
```

* `stylesheets` is the discovery result **after** critical's filtering and de-duplication, **before** any
  fetching, in document order: a string is the `href` value exactly as written in the page (after HTML entity
  decoding, untouched otherwise: relative stays relative, blanks are kept); `{ "inline": text }` is the text of an
  inline `<style>` or of a decoded `data:` stylesheet (critical does not tell them apart). Sheets that later fail
  to load are still listed.
* `stylesheetsMedia[i]` is the media query to wrap sheet `i` in (`@media <q> { ... }`), `""` for none.
  `all`, `screen`, `print` (and an empty attribute) never wrap; `print` sheets are dropped unless `onload`
  contains `media`; any other value, including `ALL`, `Screen`, `PRINT`, is wrapped verbatim.
* `message` has the machine's working directory replaced by `<cwd>` and the origins by placeholders.

Joining: critical joins the stylesheets (including empty ones) with `os.EOL`, recorded on POSIX, so with a
single `"\n"`. A sheet's own trailing newline therefore gives a blank line between sheets, and an empty/emptied
sheet gives an extra empty element (`"\n\n"`). `content-join-separator-and-trailing-newlines` shows it. On Windows
critical would join with CRLF; the new layer must always use `"\n"`.

### Test recipe

```js
const dir = path.join(FIXTURES, name);               // or path.join(FIXTURES, '_deviations', name)
const c = JSON.parse(readFileSync(path.join(dir, 'case.json'), 'utf8'));
const sub = (s) => s.replaceAll('{{site}}', SITE).replaceAll('{{cdn}}', CDN).replaceAll('{{alias}}', ALIAS)
  .replaceAll('{{site_host}}', SITE_HOST).replaceAll('{{cdn_host}}', CDN_HOST).replaceAll('{{alias_host}}', ALIAS_HOST);
```

The page-loading code has a transport half and a policy half. Only the transport half is faked:

1. **The seam: a one-hop `request(url)`.** The page-fetch module takes its network access as an injectable function (the way
   `ssrf-chromium.js` and `ssrf-proxy.js` take `lookup` / `connect`). `request(url, { signal, headers })` performs exactly ONE HTTP
   exchange and resolves to `{ status, headers, body }` (`headers` a `Headers` or a plain object, `body` an iterable of byte chunks);
   it does not follow redirects and judges neither status, content-type nor size. A test replaces only this function with a fake that
   replays `c.routes`: find the route whose substituted key equals the absolute URL (origin + path + query, exact) and answer `status`, the
   `Content-Type` header from `type` (no header when `null`), the extra `headers` (lower-case names, e.g. `location`) and the body
   bytes (`file` or `body`, tokens substituted; an `encoding` is not applied). An origin in `c.down` -> the rejection the real transport
   gives for a refused connection. No route -> `404`, `text/plain`, `Not Found`. `head` and `encoding` are ignored: HEAD is never sent,
   and decompression is a real-HTTP test.
2. **The policy is the module's own code and is never faked.** The redirect loop (manual, at most 5 hops, every hop checked), the
   refusal of schemes other than http(s), the status rule, the content-type rules, the size caps, the UTF-8 decoding, the page-host
   pin (the injected `isPageHostAllowed(url)`) and the stylesheet failure rules all run for real on top of the fake `request`. These
   are what the `fail` / `skip` rows of the deviations table test. Do not fake the whole fetcher instead: that fake would have to
   re-implement these rules (about 25 lines) and the rows would then only test the fake.

   Decoding is part of that policy: the module must decode bodies with `Buffer.toString('utf8')`. `response.text()` and `TextDecoder`
   strip a leading BOM, which `content-utf8-bom-*` pin, and invalid bytes must become U+FFFD (`transport-invalid-utf8-bytes`).

Then run the code under test on `sub(c.pageUrl)` (cases with `html`: on the substituted file content), with the page predicate
described in "Two notions of the same host", and compare with the expectation read as below:

* the css must equal the bytes of the expected css file (raw, no substitution); where the module exposes them, the discovery result of
  a **parity** case must equal `c.expect.stylesheets` / `stylesheetsMedia` (after substitution) and the page path `c.expect.virtualPath`;
* `c.layout` -> the layout copy built from the page text and that css must equal the expected layout file;
* a case in `_deviations/` -> run it on the case's own `routes` and `pageUrl`, **not on the derived variant:** `thin.derive` exists only
  so the recorder could obtain `expected-thin.css` from `critical`; its route keys contain placeholders too. The recorded `expect`
  of a deviation (`stylesheets`, `virtualPath`, and `expected.css` unless `thin` points at it) is what `critical` did and is not asserted.

### Reading the new layer's expectation

A case is a deviation exactly when its directory is `_deviations/<name>/`, and exactly when its `case.json` has a `thin` object; there is
no separate flag. Every case, parity or deviation, is read the same way:

```js
// -> { reject: true } | { reject: false, css, layout, warnings }; css and layout are raw bytes, never substituted
function newLayerExpectation(dir, c) {
	const raw = (file) => readFileSync(path.join(dir, file));
	const t = c.thin;                                    // undefined for a parity case
	if (t?.kind === 'fail' || (!t && c.expect.kind === 'error')) return { reject: true };
	return {
		reject: false,
		css: raw(t?.cssFile ?? c.expect.cssFile),        // differs: thin.cssFile; skip: thin.cssFile when present, else expect.cssFile; same and parity: expect.cssFile
		layout: t?.layoutFile ? raw(t.layoutFile) : c.expect.layoutFile ? raw(c.expect.layoutFile) : null,
		warnings: t?.kind === 'skip' ? 1 : 0,            // a skipped stylesheet logs exactly one warning; nothing else does
	};
}
```

## Deviations (`_deviations/`)

Cases where the new layer must NOT reproduce what critical did. `expected.css` / `expect` still record
critical's behaviour (assert them only where `thin` says so: a `skip` without `thin.cssFile`, and `same`), and `thin` says what the
new layer must do. Its keys are the same in every deviation: `kind` and `note` (why the new layer differs) always; `derive` and
`cssFile` together (the css differs from `expected.css`; `cssFile` is always `expected-thin.css`); `layout: "literal"` and `layoutFile`
together (the layout copy differs; `layoutFile` is always `expected-thin-layout.html`, only with `"layout": true`). The checker enforces this.

| `thin.kind` | meaning |
|---|---|
| `fail` | the job must fail (reject). critical processed or dropped something that must now be a hard error. |
| `skip` | the job must succeed, the failing stylesheet (on another host, or with a refused scheme) is skipped with one `logSafe`'d warning. Expected css: `thin.cssFile` if present, else `expect.cssFile` (critical dropped the sheet as well). |
| `differs` | the job must succeed with css equal to `thin.cssFile` (`expected-thin.css`). |
| `same` | the css behaves as `expect`; only the layout copy differs (`thin.layoutFile`). |

`expected-thin.css` is not invented: it is critical's own output for the same page with the routes of
`thin.derive.routes` patched (a patch merges into the route; a `null` member deletes that member; a `null` route
deletes the route), i.e. for a healthy server, for a missing sheet, or for a rewritten page.
`expected-thin-layout.html` is the one exception: the recorder builds it from critical's own page text and css
with the single intended difference (the css injected literally). `critical.txt` lists, in order, every request critical made.

The decisions the rows rely on (the project's decisions for the replacement layer; the ones about a single odd input are in "Decisions"):

* a stylesheet that fails to load on the page's own host (after redirects) fails the whole job, one on any other host is skipped
  with a warning; an error body is never used as css and a `text/html` / `application/xhtml+xml` stylesheet response is rejected (soft 404);
* a non-2xx page response is a hard failure, so is a page that is not html or xhtml (a missing content-type too), and page redirects
  must stay on the allowed host;
* at most 5 redirects per request and at most 100 stylesheets per page;
* GET only (no HEAD probes), `<base href>` handled as the HTML standard says, the local filesystem is never consulted;
* the css is injected into the layout copy literally;
* no source map is ever read or written (postcss runs with `map: false`), which also drops a `sourceMappingURL` comment from the css.

| case | what critical does | new layer | source |
|---|---|---|---|
| `failure-stylesheet-404-absolute-same-host`, `failure-stylesheet-404-protocol-relative-same-host`, `failure-stylesheet-500-with-body-absolute-same-host`, `failure-stylesheet-200-html-body-same-host`, `failure-stylesheet-valid-css-served-as-text-html-same-host`, `failure-stylesheet-redirect-to-404-same-host`, `failure-stylesheet-redirect-loop-same-host`, `failure-stylesheet-head-ok-get-500-body-same-host` | drops the sheet silently; for the last one and the 200-html ones uses the error/HTML body as css or empties the sheet | `fail` | decision (same-host failure fails the job; error bodies are not css; text/html stylesheets are rejected) |
| `failure-stylesheet-404-absolute-cdn`, `failure-stylesheet-404-protocol-relative-cdn`, `failure-stylesheet-connection-refused-cdn`, `failure-stylesheet-connection-refused-protocol-relative-cdn`, `failure-stylesheet-redirect-to-404-cdn`, `failure-stylesheet-404-alias-hostname` | drops the sheet silently | `skip` (css = `expected.css`) | decision (off-host failure is skipped) |
| `failure-stylesheet-head-ok-get-500-body-cdn`, `failure-stylesheet-200-html-body-cdn`, `failure-stylesheet-valid-css-served-as-text-html-cdn`, `failure-stylesheet-redirect-loop-cdn` | uses the error/HTML/mistyped body as css, or (loop) the body of the last 302 response: the css parser rejects it and an EMPTY sheet element stays in the join | `skip` + `expected-thin.css` (= sheet missing: one `"\n"` shorter than `expected.css`) | decision |
| `failure-stylesheet-head-405-same-host`, `failure-stylesheet-head-405-cdn`, `failure-stylesheet-head-405-root-relative` | decides from a HEAD probe: drops the sheet, or throws for the root-relative one, although GET works | `differs` (sheet included) | decision (GET only) |
| `page-head-405-get-redirects` | the HEAD probe failed, so it never learns the redirect target: a relative href is resolved against the wrong directory and the job throws | `differs` (final URL taken from the GET) | decision (GET only) |
| `failure-page-404-with-body`, `failure-page-404-empty-body`, `failure-page-403-bot-challenge-page`, `failure-page-503-maintenance-page`, `failure-page-302-without-location`, `failure-page-redirect-to-404` | processes the error page as the page (a bot-challenge or maintenance page's css is delivered) | `fail` | decision (non-2xx page is a hard failure) |
| `redirect-page-chain-6-hops`, `redirect-page-chain-7-hops`, `redirect-page-chain-11-hops`, `redirect-page-chain-25-hops`, `redirect-page-loop`, `redirect-stylesheet-chain-6-hops` | follows up to about 20 hops (got stops at 10 per request, but critical's HEAD probe takes the first 10 and the GET restarts from the last URL it saw); a loop or 25 hops does not fail: the last 3xx response body is used and the css is empty | `fail` | decision (max 5 redirects; the 5-hop siblings `redirect-page-chain-5-hops` and `redirect-stylesheet-chain-5-hops` are parity cases) |
| `redirect-page-off-host`, `redirect-page-off-host-alias-hostname` | follows a page redirect to another origin | `fail` | decision (page redirects stay on the allowed host); the first differs from the page only by PORT (it needs the injected `host:port` page predicate), the second only by HOSTNAME (see "Two notions of "the same host"") |
| `content-101-stylesheets` | no limit | `fail` | decision (max 100 sheets; `content-100-stylesheets` is a parity case) |
| `base-href-relative-path`, `base-href-relative-root-sheet` | `TypeError: The "path" argument must be of type string` as soon as a non-absolute href must be resolved while a relative `<base href>` exists | `differs` | decision (`<base href>` per the HTML standard) |
| `base-href-absolute-base-dir-not-found` | only considers a base candidate whose directory URL answers a HEAD with 2xx; otherwise `FileNotFoundError` | `differs` | decision (`<base href>` per the HTML standard) |
| `base-href-after-other-attribute` | recognises `<base>` only when `href` is its first attribute (regex), so ignores `<base target="_blank" href="/foo/">` | `differs` | decision (`<base href>` per the HTML standard) |
| `base-href-absolute-only-under-page-dir` | the relative sheet is not under the base, so it falls back to probing the page directory (HEAD base 404, then GET page-dir) and includes the sheet from there | `fail` (the base URL is the only candidate; its 404 fails the job) | decision (`<base href>` per the HTML standard, no guessing) |
| `layout-dollar-sequences-in-css` | injects the css into the layout copy as a replacement template: `$&`, `$1`, `$$`, `` $` ``, `$'` in the css are expanded and the layout copy no longer matches the css | `same` css, layout copy per `expected-thin-layout.html` (css injected literally) | decision (literal injection) |
| `failure-page-content-type-json`, `failure-page-content-type-text-plain`, `failure-page-content-type-missing` | processes the page whatever its content-type | `fail` | decision (the page content-type must be html or xhtml; a missing one fails too) |
| `failure-stylesheet-redirect-cdn-to-site-404` | silently drops the redirected sheet | `fail` | decision (the host of the last URL requested decides: here the page host) |
| `failure-stylesheet-redirect-site-to-cdn-404`, `href-ftp-scheme-dropped` | drops the sheet silently | `skip` (css = `expected.css`) | decision (the first: the last URL requested is on the CDN; the second: a scheme other than http(s) is refused, which counts as a failure on another host) |
| `href-whitespace-only-fetches-the-page-itself` | `href="   "` resolves to the page itself, the page html is fetched as a stylesheet and parses to an empty sheet | `differs` | decision (an href that is blank after trimming is skipped and never fetched) |
| `data-uri-base64-uppercase-token` | `;BASE64` is not recognised, the base64 text is used as css and parses to an empty sheet | `differs` | decision (the base64 token is case-insensitive) |
| `data-uri-uppercase-scheme` | `DATA:` is not recognised, it is treated as a file path and the job fails | `differs` | decision (the URL scheme is case-insensitive: `DATA:` is decoded exactly like `data:`) |
| `content-comments-kept-sourcemap-comment-dropped` | keeps a `/*# sourceMappingURL=... */` comment, together with the other comments | `differs` (every other comment stays, the `sourceMappingURL` one is gone) | decision (postcss runs with `map: false`, so it never decodes an inline map or looks for a map file on the local disk; it removes the comment as a side effect) |

## Decisions

Each of these was an open question when the fixtures were recorded and is now decided. The case carries the accepted behaviour: where
the new layer differs from `critical` it is under `_deviations/` with a `thin` block (see the deviations table), otherwise it is a
parity case. One line per decision:

| case | what critical does | accepted behaviour (rule) |
|---|---|---|
| `failure-page-content-type-json`, `failure-page-content-type-text-plain`, `failure-page-content-type-missing` | processes the page whatever its content-type | the job fails: the page content-type must be html or xhtml, and a MISSING content-type fails too (WordPress always sends one); for stylesheets `text/html` and `application/xhtml+xml` are rejected while `text/plain`, `application/octet-stream` and a missing type are tolerated |
| `failure-stylesheet-redirect-site-to-cdn-404`, `failure-stylesheet-redirect-cdn-to-site-404` | drops the sheet silently in both | the host (hostname + port, scheme ignored, default ports dropped) of the LAST URL requested for the stylesheet is compared with the host of the FINAL page URL: the first failed on the CDN and is skipped with one warning, the second failed on the page host and fails the job |
| `href-whitespace-only-fetches-the-page-itself` | fetches the page html as a stylesheet | an href that is blank after trimming is skipped and never fetched |
| `data-uri-base64-uppercase-token` | does not recognise `;BASE64` and uses the base64 text as css | the base64 token is case-insensitive: the payload is decoded |
| `data-uri-no-comma` | throws `malformed data: URI`: the job fails | the job fails: a data: stylesheet without a comma in the owner's own page is malformed (parity case) |
| `data-uri-uppercase-scheme` | does not recognise `DATA:`, treats it as a file path and fails the job | deliberate deviation: the URL scheme is case-insensitive, so a `DATA:` href is decoded exactly like `data:` (one rule, no special failure; `;BASE64` is case-insensitive too); `expected-thin.css` is critical's output for the lower-case twin with the same payload |
| `data-uri-malformed-percent-escape` | decodes leniently (`%ZZ` stays literal) | the same: a malformed percent escape decodes leniently and never throws out of discovery (parity case) |
| `href-ftp-scheme-dropped` | drops an `ftp://` stylesheet silently | a scheme other than http or https is refused, which counts as a failure on another host: the sheet is skipped with one warning and the job succeeds (a `skip` deviation: the warning is new behaviour) |
| `rebase-dollar-sequences-in-url`, `rebase-uppercase-data-scheme-in-url` | corrupt the url (`$&` is expanded by `postcss-url`'s string replace) or rewrite `DATA:` / `Data:` into a bogus path (the scheme test is case-sensitive) | bug-compatible: `postcss-url` stays for the rebasing, so a `DATA:` inside a css `url()` (not a `<link href>`, see the row above) and `$&` keep the recorded output; replacing it (or fixing these two) is out of scope (parity cases) |

Also decided, with no recorded case because `critical` cannot produce the new layer's output for the same page: the text of a
`<style>` element is ALWAYS css and is never reinterpreted as a data: URI (`critical` decodes a `<style>` whose text starts with `data:`,
because its check is on the value wherever it came from). A unit test of the discovery module pins it.

## Layout copy (`"layout": true`)

penthouse is given a copy of the page, not the page: `critical` writes the page to a temp file with the whole joined
css injected as `<style>...</style>` right after **every** start tag its regex (`/(<head(?:\s[^>]*)?>)/gi`) takes for `<head ...>`.
`expected-layout.html` is that file. Its page text is the page as fetched (UTF-8 decoded), so it contains the literal origins.
What the cases show (all of it follows from the regex, not from an HTML parser): case-insensitive, attributes allowed
(`layout-head-uppercase-with-attributes`); `<header>`, `<headline>`, `<head-x>` do not match (`layout-header-element-not-matched`);
matches inside comments and script strings count (`layout-head-in-comment-and-script-string`); a page without a `<head>` start tag
gets no injection (`layout-no-head-element`); a second `<head>` gets a second copy of the css (`layout-two-head-tags`);
a `>` inside an attribute value ends the match early (`layout-head-attribute-containing-gt`). `wordpress-typical-homepage` and
`html-entry-smoke-page` carry a layout copy as well. The only deliberate difference is `layout-dollar-sequences-in-css`.

## The `html:` entry point (`"html"` instead of `"pageUrl"`)

`generate({ html })` is what the offline container smoke test uses. There is no page URL: `virtualPath` is `""`, nothing
is rebased in an inline `<style>` or a `data:` stylesheet (the css is used as written, even if it would not parse), a link
must be absolute and is fetched, and because there is no page host **every** relative `url()` in a fetched sheet becomes an
absolute URL, also for `{{site}}` sheets (`html-entry-absolute-link-makes-urls-absolute`). A relative link throws
(`html-entry-relative-link-fails`): there is nothing to resolve it against.

## Pure-function table

`_units/stylesheet-path.json`: critical's `getStylesheetPath()` for a remote stylesheet, i.e. what it hands to `postcss-url`
as the stylesheet's location. `page` and `stylesheet` are absolute URLs (the stylesheet URL is the final one, after
redirects); `expected` is the return value: the pathname when the stylesheet is on the page host (hostname + port, scheme
ignored, default ports dropped), the complete URL otherwise. Raw: no placeholders in this file. A new
`stylesheetPath(sheetUrl, docUrl)` can be tested against it row by row.

## Things critical does that look like bugs but are part of the parity set

These are in the main cases on purpose: if the new layer keeps `postcss-url` and the discovery rules the
output is identical; if it replaces them, these are the places to look.

* **`url()` rebasing** (`rebase-*`): only `scheme://` and `//` count as remote. `url(mailto:..)`, `tel:`, `javascript:`,
  `about:`, `blob:` are rewritten into bogus paths (`rebase-odd-schemes`); `URL(`/`Url(` in upper/mixed case is not
  recognised at all (`rebase-uppercase-url-function`); bare strings in `image-set("a.png" 1x)` are untouched;
  `url(...)` text inside a string value is rebased too (`rebase-url-in-string`); `\(` in an unquoted url becomes `/(`
  (`rebase-escaped-parentheses-in-path`); leading blanks inside `url(  x)` are kept, trailing ones dropped
  (`rebase-whitespace-inside-url`), blanks inside quotes are dropped (`rebase-percent23-and-leading-blank-in-quotes`);
  `url(#id)` inside a CDN sheet becomes an absolute `<sheet url>#id` while same-host sheets keep it
  (`rebase-cdn-sheet-data-and-fragment`); `@import` is never touched; a quoted `AlphaImageLoader(src='...')` is rebased,
  an unquoted one is not (`rebase-alpha-image-loader`); a stylesheet URL whose path ends in `/` is rebased as if it were
  `<path>temp.css` (`rebase-sheet-path-ends-with-slash`); a `<base href>` does not change the rebasing, urls stay relative to the
  page URL (`base-href-with-urls-in-sheet-and-inline-style`).
* **A css parse error empties that sheet silently** (`content-syntax-error-*`, `inline-style-html-comment-wrapped`):
  the sheet still counts in the join. `@media (...) {` wrapping happens before parsing, so an unclosed block in a
  media-conditional sheet is still an error (`content-syntax-error-inside-media-wrapper`).
* **Discovery** (`discovery-*`, `media-*`): `rel` is a case-insensitive *substring* match (`x-stylesheet-hint`
  matches); `as="STYLE"` (value) does not match but `AS="style"` (attribute name) does; content of `<template>` and
  inline `<svg><style>` IS discovered, `<noscript>` content is not (nor is the content of `<title>`, `<iframe>`,
  `<noembed>`, `<noframes>`, `<xmp>`, `<textarea>`, `<script>`); the `type` attribute of `<link>` and `<style>` is
  never looked at; de-duplication is on the raw string, so `/x.css` and `{{site}}/x.css` are both included
  (`discovery-dedupe-is-by-raw-string`); a `media="print"` sheet whose `onload` merely contains the letters "media" is kept
  (`media-print-onload-substring-in-word`) while `this.MEDIA` is not (`media-print-onload-uppercase-media-dropped`);
  `media="PRINT"`, `ALL`, `Screen` are wrapped; `media=" screen "` is wrapped with its blanks.
* **Page and stylesheet responses** (`page-*`, `transport-*`): `Content-Type` is never looked at (text/plain,
  octet-stream or no type are all used as css; an XHTML page is parsed as HTML; a missing or upper-case page type is fine); a
  failed HEAD of the *page* is ignored (`page-head-405-get-200`, `page-head-404-get-200`); a 204 is an empty sheet.
* **Page URLs** (`page-url-*`): an empty path segment counts as one directory level (`page-url-double-slash`, `/blog//post/`), which a browser
  would not do.
* **Decoding**: always UTF-8, `Content-Type` charset is ignored (`transport-charset-header-ignored`), a BOM is kept
  where it is (`content-utf8-bom-*`), invalid bytes become U+FFFD (`transport-invalid-utf8-bytes`), a base64 `data:` payload
  is decoded as UTF-8 (`data-uri-base64-utf8-payload`), `data:` payloads that are not valid base64 do not throw
  (`data-uri-malformed-base64`; the `inline` text in `expect` is lossy there).
* **`$&`, `$1`, `$$`, `` $` ``, `$'`** in css are copied literally into `document.css` (`content-dollar-*`). (`critical`
  expands them only when it builds the layout copy, see `layout-dollar-sequences-in-css`.)
* **Relative hrefs** (`href-relative-*`) only work because some candidate directory URL answers 2xx (the page URL
  itself does in these cases). They resolve against the final URL after redirects (`redirect-page-302-relative-href`).
  A relative href padded with blanks works too (`discovery-href-whitespace-padded-relative`).

## Things that depend on the machine (and how the recorder neutralised them)

* The recorder ran in an empty temporary working directory with an isolated `TMPDIR` and aborts if any recorded
  non-URL href exists on the machine, so no recording depends on the machine's files; the error messages that mention the
  working directory have it replaced by `<cwd>`. The new layer never reads local files: for relative and root-relative
  hrefs it only builds URLs.
* `{{alias}}` needs `localhost` to resolve to the loopback interface (it does everywhere the recorder ran).
* The join uses `os.EOL` (see above), so the recording is POSIX-specific.
* critical's `got` client retries 5xx and refused connections twice with back-off and has no timeout of its own:
  the recorder was slow for those cases (about 12-25 s each; the results are deterministic). It also waits for a
  `Retry-After` header (measured with `got@15.1.0` alone: a 503 with `Retry-After: 4` held the request for 8 s), so
  none of the fixtures sends one.

## Line endings and git

* Files that **must** keep their bytes: `content-crlf-line-endings/{crlf.css,expected.css}` and
  `content-crlf-page-html/page.html` (CRLF); `content-utf8-bom-first-stylesheet/{bom.css,expected.css}` and
  `content-utf8-bom-page/page.html` (U+FEFF at the start), `content-utf8-bom-second-stylesheet/{bom.css,expected.css}`
  (U+FEFF at the start of `bom.css`, in the middle of `expected.css`); `transport-invalid-utf8-bytes/l1.css` and
  `page-not-utf8-latin1-bytes/page.html` (not valid UTF-8). Everything else is LF only.
* `.gitattributes` in this directory sets `* -text`: git never converts anything below it (`git check-attr text` reports
  `unset`), so a checkout with `core.autocrlf=true` (Windows) cannot rewrite the LF files and break the byte comparisons.
  It also sets `linguist-generated=true`: the files are recorded by a tool, so GitHub collapses their diffs by default.
* `expected.css` for a case with no css is a zero-byte file.

## Editors, linters and scanners

This directory is test data, not source: it contains deliberately broken css, empty files, a 200 KB sheet and
HTML without the usual metadata. It must be excluded from SonarCloud (`sonar.exclusions` in
`sonar-project.properties`, e.g. `service/fixtures/**`; that file is outside this directory and has to be changed with
the change that adds the fixtures) and from any linter or formatter run (a formatter that "fixes" a fixture silently
invalidates its `expected.css`).

## Not covered by fixtures

These need unit or integration tests of their own, the recorded data cannot replace them: the size caps (html 10 MiB, 5 MiB
per sheet, 16 MiB in total) including the decoded-byte cap on a compression bomb; the 30 s total and 15 s idle deadlines; the
User-Agent; the nesting-depth guard (511 / 512 / 513 levels); the rejection of an `application/xhtml+xml` stylesheet (only `text/html` is recorded); per hop, the refusal of a private literal address, userinfo and
non-http(s) schemes; TLS verification; whether inline and `data:` sheets count towards the 100; the removal of the temp
directory on every path; the local policy proxy; and the `<base href>` that critical's regex sees inside a comment or a script string
(a parser does not).

## Adding a case

1. Create `<name>/` with `case.json` (`description`, `pageUrl` or `html`, `routes`, optional `down` / `layout`; for `_deviations/` also
   `thin`) and the files its routes serve. Use the placeholders; keep a case to one behaviour; write the description as one sentence.
2. Record it with `critical@8.0.0` (see below) so `expect`, `expected.css` (and `critical.txt`/`expected-thin.css`/`expected-layout.html`
   for deviations and layout cases) are written by the tool, never by hand.
3. Review the result: it is what `critical` did, not necessarily what is right. If the new layer must differ, move
   the case to `_deviations/` and add `thin`. If the new layer's output is something `critical` cannot produce for the same
   page, say so in the README instead of writing the expectation by hand.
4. Add the case to the README table it belongs to (the deviations and decisions tables are checked against the `case.json` files).

The recorder was a ~500-line script, not kept in the repository because `critical` is being removed. To rebuild
it in a scratch directory: `npm install critical@8.0.0`; chdir into an empty directory and point `TMPDIR` at
another empty one **before** importing `critical/file.js`; for each case start one `node:http` server per origin
on the fixed ports (abort if a port is busy; the `{{site}}` server also answers requests whose `Host` header is
`localhost:18981` as `{{alias}}`, with its own route table), serving the routes with the substitutions above; call
`getDocument(sub(pageUrl), { request: {} })` (or `getDocumentFromSource(sub(html), { request: {} })`; catch errors and keep
`error.message`); read the layout copy from `doc.url` before cleanup when `layout` is set; after the call resolves wait ~150 ms
before `document.cleanup()` (critical writes placeholder files without awaiting them and its cleanup does not await its
unlinks, so an immediate cleanup can raise an unhandled `ENOENT` rejection that kills the process); write
`String(document.css)` as UTF-8 to `expected.css`; write `virtualPath`, `stylesheets` (Buffers as `{ inline }`),
`stylesheetsMedia` with the origins turned back into placeholders; evaluate every `_units` row with `getStylesheetPath(
{ virtualPath: '/index.html', urlObj: urlParse(page) }, { remote: true, urlObj: urlParse(stylesheet) })`; record every case
twice and refuse any difference.
