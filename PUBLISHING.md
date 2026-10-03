# Publishing On Route to the VS Code Marketplace

## One-time setup

### 1. Push the repo to GitHub
The README uses relative image paths (`media/icon.png`, `images/*.png`). `vsce` rewrites them to
`https://github.com/iamasistiwari/on-route/raw/HEAD/...`, so **the images must be pushed to GitHub**
and the repo must be **public**, or they will be broken on the Marketplace page.

```bash
git add -A && git commit -m "chore: marketplace assets" && git push origin main
```

### 2. Create an Azure DevOps organization
1. Go to <https://dev.azure.com> and sign in with a Microsoft account.
2. Create an organization if you don't have one (any name).

### 3. Create a Personal Access Token (PAT)
1. In Azure DevOps: avatar (top right) → **User settings** → **Personal access tokens** → **New Token**.
2. Settings:
   - **Organization:** `All accessible organizations` ← required, publishing fails otherwise
   - **Expiration:** up to 1 year
   - **Scopes:** *Custom defined* → **Show all scopes** → **Marketplace → Manage**
3. Copy the token now. It is shown only once.

### 4. Create a publisher
1. Go to <https://marketplace.visualstudio.com/manage/createpublisher> (same Microsoft account).
2. Pick an **ID** (permanent, lowercase, e.g. `on-route` or `iamasistiwari`) and a display name.
3. Make sure `"publisher"` in `package.json` equals that ID exactly. It is currently `"on-route"`;
   if you choose a different ID, update `package.json` **and** the badge/marketplace links in `README.md`
   (`on-route.on-route` → `<publisher>.on-route`).

### 5. Log in with vsce
`@vscode/vsce` is already a dev dependency.

```bash
npx vsce login <publisher-id>     # paste the PAT when asked
```

## Every release

```bash
# 1. Verify
npm ci
npm run typecheck
npm test

# 2. Bump version + write CHANGELOG.md entry
npm version patch --no-git-tag-version   # or minor / major

# 3. Build a .vsix and inspect it (builds automatically via vscode:prepublish)
npm run package
npx vsce ls --no-dependencies            # list files that will ship

# 4. Test the .vsix locally
code --install-extension on-route-<version>.vsix

# 5. Publish
npm run publish                          # = vsce publish --no-dependencies

# 6. Tag the release
git commit -am "release: v<version>" && git tag v<version> && git push --follow-tags
```

`--no-dependencies` is correct: esbuild bundles `undici`, `yaml` and `zod` into `dist/extension.js`,
so `node_modules` is not shipped.

The listing appears at `https://marketplace.visualstudio.com/items?itemName=<publisher>.on-route`
within a few minutes (after a short automated verification).

### Alternative: upload manually
Instead of `vsce publish`, upload the `.vsix` at
<https://marketplace.visualstudio.com/manage/publishers/<publisher-id>> → **New extension → Visual Studio Code**.

## Optional: also publish to Open VSX
Open VSX serves VSCodium, Cursor, Windsurf and Gitpod.

```bash
npx ovsx create-namespace <publisher-id> -p <open-vsx-token>   # once; token from https://open-vsx.org/user-settings/tokens
npx ovsx publish on-route-<version>.vsix -p <open-vsx-token>
```

## Pre-publish checklist
- [ ] `publisher` in `package.json` matches your Marketplace publisher ID
- [ ] Repo is public and images are pushed to `main`
- [ ] `version` bumped and `CHANGELOG.md` updated
- [ ] `npm test` and `npm run typecheck` pass
- [ ] `.vsix` installed and smoke-tested locally
- [ ] No secrets in the package (`npx vsce ls`)

## Troubleshooting
| Error | Fix |
|---|---|
| `401 Unauthorized` / `Failed request: (401)` | PAT must use **All accessible organizations** and **Marketplace → Manage** scope. |
| `Access Denied: ... needs the following permission(s) on the resource /<publisher>` | `publisher` in `package.json` doesn't match the ID you logged in with. |
| `The extension 'x' already exists in the Marketplace` | The `name` is taken under another publisher — rename `name` in `package.json`. |
| `Images in README.md must come from an HTTPS source` / SVG errors | Only PNG/JPG via HTTPS; SVGs are only allowed from trusted badge hosts (e.g. img.shields.io). |
| `Make sure to edit the README.md file before you package` | README is still the template — not the case here. |
| Broken images on the listing | Repo is private or images aren't pushed; or pass `--githubBranch main` to `vsce package`. |
