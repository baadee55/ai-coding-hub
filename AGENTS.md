# AGENTS.md — guide for AI coding agents

This file is the entry point for **any AI coding agent** (OpenAI Codex, Google Antigravity, Gemini,
Cursor, etc.). Claude Code reads `CLAUDE.md`; other agents read this. **The full project context is in
[CLAUDE.md](CLAUDE.md) — read it first.** This file is a short pointer + the rules you must not break.

## What this project is
**AI Coding Hub** — control an AI coding CLI running on the user's own PC, from their phone, over a
Cloudflare Tunnel. The relay/UI/auth/tunnel layer is engine-agnostic; the coding engine is pluggable.

## Hard rules (do not violate)
1. **Never set `ANTHROPIC_API_KEY`** (or add it to `.env`/env). It switches Claude Code to metered API
   billing. The agent process **refuses to start** if it's present. For other engines, configure
   `strip_env` so they also run on the user's subscription, not a metered API key.
2. **Never hardcode personal values** (domains, absolute paths, tokens) into code. All per-user config
   lives in `agent/.env` and `agent/config.json` (both gitignored). Public-facing defaults derive from
   `PUBLIC_URL`.
3. **Keep secrets out of git**: `.env`, `config.json`, `*-qr.png`, tax PDFs, `*.exe` are gitignored.
4. **Commands run only under registered project paths** (`config.json` → `projects[].path`). Don't remove
   that guard (`routers/projects.ensure_allowed_path`).

## Where things live
- Per-user config: `agent/.env` (secrets/URLs), `agent/config.json` (projects + engines)
- Manual setup/config guide: [docs/CONFIGURATION.md](docs/CONFIGURATION.md)
- Engine adapters: `agent/engines/` (`claude_code.py` = dedicated/rich, `generic_cli.py` = config-driven)
- Add a new engine **without code**: add an entry under `"engines"` in `config.json` (see
  `config.example.json`). It runs via `generic_cli` (raw text output). For rich output/resume, add a
  dedicated adapter like `claude_code.py`.
- **UI language / i18n**: strings live in `ui/i18n.js` as `DICT.{ja,en}`. To localize the UI to another
  language, add a new language block (e.g. `es`, `zh`) with the same keys and translated values, then
  the 🌐 toggle / `navigator.language` picks it up. Tag any new visible HTML with `data-i18n="key"`
  (or `-html`/`-ph`/`-title`). Remember the UI version triple-sync (`APP_VERSION` / `APP_JS_VERSION` /
  `CACHE_KEY` + the `i18n.js?v=` query) when you change `ui/`.

## Verification status (be honest with the user)
Verified only on **Android + Claude Code**. iPhone and other engines (Codex/Antigravity/Gemini) are
implemented but **unverified** — help the user verify on their device/CLI and adjust the config/args.

See [CLAUDE.md](CLAUDE.md) for architecture, gotchas, and the "フォーク時に変える場所" (what to change when
forking) section.
