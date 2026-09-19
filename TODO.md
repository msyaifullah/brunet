# WIP TODO Brunet — Bruno API Support for Obsidian

An [Obsidian](https://obsidian.md) plugin that adds first-class support for [Bruno](https://www.usebruno.com/) `.bru` API request files. View, edit, and run HTTP requests directly inside your vault.

## Features

- **Rich preview** — renders `.bru` files as a formatted request card with method, URL, headers, query params, body, scripts, and docs
- **Run requests** — send HTTP requests from within Obsidian and see the response (status, headers, body) inline
- **Collections sidebar** — browse all `.bru` files in your vault grouped by folder, with per-file run buttons
- **Syntax highlighting** — CodeMirror 6 language extension highlights `.bru`, `.yml`, and `.yaml` Bruno files in the editor
- **Variable support** — resolves `{{variable}}` syntax in URLs, headers, query params, and body
- **Copy CLI command** — one-click copy of the `bru run` command for the current file

## Installation

### From Obsidian Community Plugins

1. Open **Settings → Community plugins**
2. Disable Safe mode if prompted
3. Open **Browse**, search for **Brunet**, and install
4. Enable the plugin in **Installed plugins**

### Manual

1. Download `main.js` and `manifest.json` from the [latest release](../../releases/latest) (and `styles.css` if that release includes it)
2. Copy them into your vault at `.obsidian/plugins/brunet/`
3. Enable **Brunet** in **Settings → Community plugins**

### Development

```bash
git clone https://github.com/msyaifullah/brunet.git
cd brunet
npm install
npm run dev
```

Then symlink the project folder into your vault's plugin directory and enable the plugin (replace the vault path with your own):

```bash
ln -s "$(pwd)" "$HOME/Documents/MyVault/.obsidian/plugins/brunet"
```

## Usage

### Open a request file

Click any `.bru` file in the file explorer. The plugin renders a preview with all request details and a **Send** button to execute it live.

### Run a request

- Click **Send** in the file preview, or
- Use the command palette: `Brunet: Run Request`, or
- Click the **▶** button next to a file in the Collections panel

The response (status code, headers, and body) appears inline below the request details. JSON responses are pretty-printed automatically.

### Collections panel

Open the sidebar panel via:
- The ribbon icon (B logo), or
- Command palette: `Brunet: Open Collections Panel`

Files are grouped by folder with collapsible sections. Click a row to open the file; click **▶** to run it.

### Copy CLI command

Click the **Copy CLI** button in the file preview to copy a `bru run` command for that file to your clipboard for use in a terminal.

## Supported `.bru` syntax

Brunet parses the Bruno plain-text block format:

```
meta {
  name: Get Users
  type: http
  seq: 1
}

get {
  url: https://api.example.com/users
}

headers {
  Authorization: Bearer {{token}}
  Accept: application/json
}

query {
  page: 1
  limit: 10
}

body:json {
  {
    "filter": "active"
  }
}
```

Supported block types: `meta`, HTTP method blocks (`get`, `post`, `put`, `patch`, `delete`, `head`, `options`), `headers`, `query`, `vars`, `body`, `script:pre-request`, `script:post-response`, `assert`, `docs`.

## Commands

| Command | Description |
|---|---|
| `Brunet: Run Request` | Execute the active `.bru` file |
| `Brunet: Open Preview` | Open the rich preview for the active file |
| `Brunet: Copy CLI Command` | Copy `bru run` for the active file to clipboard |
| `Brunet: Open Collections Panel` | Show the collections sidebar |

## Development

```bash
npm run dev      # watch mode (development build)
npm run build    # production build with type check
npm run version  # bump version in manifest.json and versions.json
```

**Stack:** TypeScript, esbuild, CodeMirror 6, Obsidian Plugin API

## Releasing

Brunet is already listed in the [Obsidian Community directory](https://community.obsidian.md/plugins/brunet). Updates do **not** need a new submission — only a published GitHub release.

Releases are automated via GitHub Actions. Pushing a version tag builds the plugin and creates a **draft** GitHub release with `main.js` and `manifest.json` attached.

**Tag format:** The GitHub release tag must match `manifest.json` `version` exactly (e.g. `0.4.1`, not `v0.4.1`). Obsidian installs assets from the release with that tag. This repo sets `tag-version-prefix=` in `.npmrc` so `npm version` creates the correct tags.

### Steps

1. Make sure `main` is up to date and the plugin builds:
   ```bash
   git checkout main
   git pull
   npm run build
   ```

2. Bump the version (updates `package.json`, `manifest.json`, and `versions.json`, then commits and tags):
   ```bash
   npm version 0.4.2
   # creates tag 0.4.2 (no "v" prefix; must match manifest.json version)
   ```

3. Push the commit **and** the tag (the tag is what triggers the workflow):
   ```bash
   git push origin main
   git push origin 0.4.2
   ```

4. Wait for **Release Obsidian plugin** to finish: [Actions](https://github.com/msyaifullah/brunet/actions).

5. Open **Releases**, edit the draft, add notes if needed, and **Publish**.
   Obsidian will not see the version while it is still a draft.

6. On [community.obsidian.md](https://community.obsidian.md), open Brunet in the developer dashboard:
   - **⋯ → Check for new releases** to pick up the GitHub release immediately
   - **Request review** if the automated scan fails
   The listing usually updates within 24 hours even without this step.

7. Confirm the new version on [Brunet’s community page](https://community.obsidian.md/plugins/brunet) and in Obsidian under **Settings → Community plugins**.

### First-time setup (already done)

- GitHub Actions write permissions: **Settings → Actions → General → Workflow permissions → Read and write permissions**
- Plugin submitted once via the [Obsidian Community developer dashboard](https://community.obsidian.md) (GitHub connected, repo claimed)

## License

MIT — see [LICENSE](LICENSE)
