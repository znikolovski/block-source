# Block Source: how it works and self-hosting

This is the maintainer guide. To add Block Source to a site, see the [README](../README.md).

A small broker on Adobe App Builder holds the GitHub credential. The plugin never sees it. The same App Builder app also serves the plugin, so a site needs no copy of it.

```
 Experience Workspace
 ┌──────────────────────────────────────────────┐
 │ canvas (site origin)   library plugin iframe │        App Builder (I/O Runtime)
 │  agent.js ◄─ bridge.html ◄─BroadcastChannel─ block-source.js ──► broker/actions/api ──► GitHub (one repo; GET, plus creating issues)
 │                            dryrun.html       │     │  checks the DA token ─► admin.da.live
 └──────────────────────────────────────────────┘     ├─ compare-index (every 10 min)
                                                      └─ usage-scan   (nightly)
```

## Repository layout

| Path | What it is |
| --- | --- |
| `plugin/tools/block-source/` | The plugin. `aio app deploy` publishes it to the app's static hosting (see `broker/hooks/build-static.js`). |
| `plugin/test/` | Plugin tests (jsdom), including an end-to-end UI test against the real broker router. |
| `broker/` | The App Builder project: `api` web action, `compare-index` and `usage-scan` scheduled actions, and static hosting for the plugin. |
| `broker/test/` | Broker tests with a fake GitHub, DA admin, IMS and aem.live. |

## Self-hosting

Sites normally use the shared deployment described in the README. To run your own copy:

### 1. Deploy the broker and the plugin

```sh
cd broker
cp .env.example .env            # set BLOCKSOURCE_ENCRYPTION_KEY (see the comment in the file)
npm install
aio login && aio app use        # select the org, project and workspace
aio app deploy
```

This deploys the actions and the plugin together:

- Plugin: `https://{namespace}.adobeio-static.net/block-source.html`
- API: `https://{namespace}.adobeio-static.net/api/v1/web/block-source/api` (the same action is also at `https://{namespace}.adobeioruntime.net/api/v1/web/block-source/api`)

The build hook copies `plugin/tools/block-source/` as-is (no bundling) and writes the API URL into the plugin's `block-source-broker` meta tag. Because the plugin and the API share an origin, the browser makes no cross-origin calls to the broker. One deployment serves every site; the site comes from the DA SDK context.

| Variable | Required | Purpose |
| --- | --- | --- |
| `BLOCKSOURCE_ENCRYPTION_KEY` | yes | 32 random bytes, base64. Wraps the per-site data keys (AES-256-GCM envelope encryption). Rotating it makes stored tokens unreadable, so admins must set them again. |
| `PUBLIC_URL` | no | Public base URL of the `api` action, used in screenshot links in issues. Defaults to `https://{namespace}.adobeio-static.net/api/v1/web/block-source/api`. |
| `BLOCKSOURCE_IMS_CLIENT_ID`, `_SECRET`, `_SCOPES` | no | OAuth server-to-server credential for the nightly usage scan. Its technical account needs read access to the site in DA. Without it, the scan is skipped and admins can run it from Settings. |

### 2. Point sites at your deployment

Follow the README setup, replacing `28538-blocksource` with your namespace in the `library` sheet path and in the canvas agent line. Two extra site config keys apply only to self-hosting:

| key | value |
| --- | --- |
| `blocksource.broker` | Another broker API URL. Defaults to the broker of the deployment that serves the plugin. |

The "in use" reference is `main` unless the plugin URL in the `library` sheet has `?ref={branch}`.

The plugin reads pages and branch code from `https://{branch}--{site}--{org}.aem.page`, which serves them with `Access-Control-Allow-Origin: *`. Sites that require authentication for preview are not supported.

### How the token is stored

The broker validates a token before saving it, and an invalid token never replaces a working one. It is stored encrypted under `tokens/{org}/{site}.json` and bound to that site, so it cannot be used for another site. The owner and repository always come from the site config or from the admin at set time, never from a request.

### How the plugin reaches the canvas

Experience Workspace puts the canvas and the plugin in shadow DOM, so neither can find the other's window. The agent opens a hidden `bridge.html` from the plugin's own origin inside the canvas. Quick edit rewrites the canvas body on every sync, so the bridge is attached to `<html>` rather than `<body>`, and the agent puts it back if it is removed. The plugin and the bridge share a `BroadcastChannel`, which the browser limits to frames of that origin under the same top-level page. Every message carries a per-tab ID from `sessionStorage`, so another Experience Workspace tab is never driven. The agent accepts messages only from its bridge frame, and only for the site and org in its own hostname.

## Block documentation conventions

See [Help authors understand your blocks](../README.md#help-authors-understand-your-blocks-optional) in the README.

## How Insights are computed

- **Used on**: from the usage scan of the site's DA content (nightly with a service account, or **Count now** / **Count again** by an administrator). Documents under `/blocks`, `/library`, `/templates`, `/drafts` and `/tools` are not counted as pages.
- **Open issues**: open issues labelled `block:{name}`, plus open issues that name the block in the title or body. Search is always limited to the site repository. Without the token's Issues permission, the Issues tab says so and the rest of the panel works.
- **In progress**: the same branches as the Versions tab, with their pull requests.
- **Who to ask**: the owners of `blocks/{name}/{name}.js` in `CODEOWNERS` (`.github/`, root or `docs/`), or the three people who changed the block most.
- **Report a problem**: from the header's **📷 Report** button, the previewing callout, or the Issues tab. The issue is raised against the branch the author is looking at: the previewed branch when a version is previewed on the canvas, otherwise the branch the page uses. The author writes a title and details. The canvas agent takes a screenshot of the block (the author can retake it or leave it out). The issue gets the label `block:{name}` and a table with the block's code at the branch head commit, the branch, the page (DA and preview links) and the author's display name (no email). Authors can raise up to 5 issues every 10 minutes.

  GitHub's API does not accept image uploads, so the broker stores the screenshot (JPEG, up to 750 KB) under `shots/{org}/{site}/` and links it from the issue through the public, unguessable `GET /shot` URL. Anyone who can see the issue can open the screenshot, and the form says so.
- **Documentation**: whether the block has a README, a content model, a written description and a sample page (see the conventions in the README).

## How the check works

When an author clicks **Check with my content**, the plugin and broker run three gates:

1. **Model** (broker): diff the content model between the in-use ref and the branch. A removed or renamed field that the content uses, or a field that became required, blocks the version.
2. **Change kind** (broker): CSS-only changes and documentation changes are safe. Any JS change needs gate 3. The broker also adds hints from DOM-shape signatures in the code (for example "needs three columns").
3. **Dry run** (plugin): decorate the author's real block HTML with the branch code in a hidden, sandboxed harness (`dryrun.html`). Then compare before and after. Lost words, links or images, an exception, a timeout or an empty result block the version. Added text is fine. The plugin tries three ways to load the code: the branch origin's harness, then a module import from the branch origin, then module source from the broker loaded as a blob.

Verdicts are **Works with your content** (preview allowed), **Does not fit** (with reasons and who to ask), or **Could not confirm** (link to the whole page on the branch only). Results are cached per session by content hash and branch head SHA.

**Preview on canvas** replaces only that block instance on the canvas. It decorates it with the branch JS and CSS and outlines it, and a banner offers **Revert**. A reload removes everything.

## Security notes

- The PAT is encrypted at rest with a per-record data key, bound to `{org}/{site}` (AAD). It is redacted from all logs and errors, and the tests verify that it never appears in responses, logs or storage.
- Every request carries the author's DA token. The broker confirms access with DA: list access for authors, config write access for admin routes. Results are cached for 60 seconds. Requests are rate-limited per caller.
- CORS is limited to `*--{site}--{org}.aem.page|live`, `da.live` and localhost.
- The GitHub client is pinned to one repository and an allow list of GET endpoints. Its only write is `POST /repos/{owner}/{repo}/issues`.
- `GET /shot` is the only route without a DA token. It serves only stored screenshot IDs (32 random hex characters) with `Content-Security-Policy: default-src 'none'` and `nosniff`.
- Branch code runs in the author's browser, in the harness and on the canvas, at the site origin. That is the same trust level as opening the branch preview URL. Only branches in the site's own repository are offered, and protected branches and branches with no commits in 90 days (`BRANCH_ACTIVITY_DAYS`) are excluded.
- Telemetry records only the event, block, branch, verdict and duration. It records no content and no user identity. A raised issue contains the author's display name, because it is posted by the machine user.

## Assumptions to confirm in the spike (plan §15)

| Item | What the code does |
| --- | --- |
| Selection from the SDK | Uses `actions.subscribeLiveDocument` when `capabilities.liveDocument === 1`. It maps `selection.blockIndex` to the nth block, skipping `metadata` and `section-metadata`. Otherwise it reads `{path}.plain.html` and shows a block picker. |
| CORS on `aem.page` for module import | Not relied on. The dry run falls back to broker-served module source in a blob URL. |
| Code sync lag | `/deployed` compares the git blob SHA of the file served by aem.live with GitHub. The History tab shows "Live code differs" while they differ. |
| Branch count | The warm compare index (`compare-index`, every 10 minutes) is used when it exists. The live scan is capped and reports truncation. |
| `.plain.html` vs editor content | The live document from the SDK is preferred. `.plain.html` is only the fallback. |
| Canvas reachability | Same-origin injection first, then `postMessage` discovery. If neither works, the author gets "Open the page on this branch". |
| Config readable by authors | If not, use the `<meta>` fallback for the broker URL. |
| PAT template URL parameters | The form links to `github.com/settings/personal-access-tokens/new` with the name, description, owner, expiry and permissions (read, plus Issues write) pre-filled. If GitHub ignores a parameter, the admin sets it by hand. |

## Local development

```sh
npm install
npm test                 # plugin (jsdom) + broker
npm run test:plugin
npm run test:broker
```

To run the plugin against a local site server (`aem up`), open Experience Workspace with `?ref=local`. In the plugin's console, run `blockSourceSetLocalRef('my-branch')` to tell it which branch the local code represents. For a local broker, run `aio app dev` and use the `http://localhost:…` URL in the meta tag.

## Limitations

- Previews are session-only by design. Adopting a version still means merging the branch.
- Blocks from other repositories (`blocksource.external`) are only named, with no history or versions.
- Telemetry and usage counters are best-effort. Concurrent writes can lose an increment.
