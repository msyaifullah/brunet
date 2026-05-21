# Brunet — Bruno API Support for Obsidian

An [Obsidian](https://obsidian.md) plugin that adds first-class support for [Bruno](https://www.usebruno.com/) `.bru` API request files. View, edit, and run HTTP requests directly inside your vault.

## Features

- **Rich preview** — renders `.bru` files as a formatted request card with method, URL, headers, query params, body, scripts, and docs
- **Run requests** — send HTTP requests from within Obsidian and see the response (status, headers, body) inline
- **Collections sidebar** — browse all `.bru` files in your vault grouped by folder, with per-file run buttons
- **Syntax highlighting** — CodeMirror 6 language extension highlights `.bru`, `.yml`, and `.yaml` Bruno files in the editor
- **Variable support** — resolves `{{variable}}` placeholders in URLs, headers, query params, and body
- **Copy CLI command** — one-click copy of the `bru run <file>` command for terminal use

## Installation

### From Obsidian Community Plugins *(coming soon)*

1. Open **Settings → Community plugins**
2. Disable Safe mode if prompted
3. Search for **Brunet** and install

### Manual

1. Download `main.js` and `manifest.json` from the [latest release](../../releases/latest) (and `styles.css` if that release includes it)
2. Copy them into your vault at `.obsidian/plugins/brunet/`
3. Enable **Brunet** in **Settings → Community plugins**

### Development

```bash
git clone https://github.com/masykurisyaifullah/obsidian-brunet
cd obsidian-brunet
npm install
npm run dev
```

Then symlink the project folder into your vault's `.obsidian/plugins/` directory and enable the plugin.

```bash
ln -s $(pwd) /path/to/your/vault/.obsidian/plugins/obsidian-brunet
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

Click the **Copy CLI** button in the file preview to copy `bru run <filename>` to your clipboard for use in a terminal.

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
| `Brunet: Copy CLI Command` | Copy `bru run <file>` to clipboard |
| `Brunet: Open Collections Panel` | Show the collections sidebar |

## Development

```bash
npm run dev      # watch mode (development build)
npm run build    # production build with type check
npm run version  # bump version in manifest.json and versions.json
```

**Stack:** TypeScript, esbuild, CodeMirror 6, Obsidian Plugin API

## Releasing

Releases are automated via GitHub Actions. When a version tag is pushed, the workflow builds the plugin and creates a draft GitHub release with `main.js` and `manifest.json` attached.

**Tag format:** The GitHub release tag must match `manifest.json` `version` exactly (e.g. `0.3.4`, not `v0.3.4`). Obsidian installs assets from the release with that tag. This repo sets `tag-version-prefix=` in `.npmrc` so `npm version` creates the correct tags.

### Steps

1. Bump the version (updates `package.json`, `manifest.json`, and `versions.json`, then commits and tags):
   ```bash
   npm version <new-version>
   # e.g. npm version 0.3.5  →  creates tag 0.3.5 (no "v" prefix)
   ```

2. Push the commit and tag:
   ```bash
   git push origin main --tags
   ```

3. Go to the **Releases** tab on GitHub, edit the draft, add release notes, and publish.

### First-time setup

Enable write permissions for GitHub Actions: **Settings → Actions → General → Workflow permissions → Read and write permissions**.

## License

MIT — see [LICENSE](LICENSE)
