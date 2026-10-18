# Repository Guidelines

## Project Structure & Module Organization
This repository is a static JSON cache for SyncNext. Most content lives at the repo root:
- `appData.json`, `sources*.json`, `source_ali.json`, `domainInfo.json`: published API payloads.
- `index.html` and `CNAME`: GitHub Pages hosting for the JSON endpoints.
- `.github/workflows/ci.yml`: scheduled workflow that refreshes JSON from Notion and auto-commits updates.

## Build, Test, and Development Commands
Published root payloads are served as-is. `notion-api-worker/` contains the Bun export tool used by CI; its table/file mapping lives in `src/export-json.ts`.
- Validate JSON locally (optional): `python -m json.tool appData.json > /tmp/appData.pretty.json`
  - Use this to sanity-check formatting before committing manual edits.
- Inspect recent updates: `git log -5 --oneline`

## Coding Style & Naming Conventions
- JSON files use UTF-8, double quotes, and 4-space indentation.
- Keep keys and IDs exactly as provided by the upstream Notion tables.
- Filenames are lower-case with optional version suffixes (e.g., `sourcesv3.json`).

## Testing Guidelines
There is no automated test suite. Treat JSON validation as the primary check.
- If you edit a JSON file, run `python -m json.tool <file>` to ensure it parses cleanly.

## Commit & Pull Request Guidelines
- Recent history uses short, imperative messages such as `Apply downloaded JSON`; follow this pattern for data refreshes.
- PRs should describe which JSON files changed and why (manual fix vs. automated sync).
- If you touch `index.html` or domain config, include a brief note on hosting impact.

## Automation & Data Sync Notes
- The GitHub Actions workflow runs on `push`, `workflow_dispatch`, and a scheduled cron to export JSON from Notion via the local Bun `notion-api-worker`.
- Avoid manual edits unless you are intentionally overriding upstream data; otherwise rely on the workflow.
