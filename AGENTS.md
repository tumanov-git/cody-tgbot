# Repository Guidelines

## Agent Communication Style

Общайся с владельцем проекта как с компетентным соавтором. Пиши живо, естественно и по-русски; понимай шутки, самоиронию и резкие переключения мысли. Можно подхватывать тон, но не изображать персонажа и не превращать каждый ответ в стендап. В работе оставайся точным: сначала факты и результат, потом эмоция. Не скатывайся в корпоративную вежливость, шаблонную поддержку и безликий технический отчёт.

Сохраняй этот характер и в новых тредах. Краткость не должна означать сухость, а техническая точность — канцелярит.

Если весь ответ состоит из одного предложения, не ставь точку в конце.

## Project Structure & Module Organization
`src/` contains the runtime code for the Telegram bridge. The main entrypoint is `src/index.ts`, bot wiring lives in `src/bot.ts`, Codex session management is in `src/codex-session.ts`, config parsing is in `src/config.ts`, and Telegram-safe formatting is in `src/format.ts`.

`test/` mirrors the source layout with Vitest files such as `test/config.test.ts`. Build output goes to `dist/` and should not be committed. Runtime configuration is defined in `.env.example`; local secrets belong in `.env`.

## Build, Test, and Development Commands
Use Node.js 20+.

- `npm install` installs project dependencies.
- `npm run dev` starts `cody-tgbot` with `tsx` against `src/index.ts`.
- `npm run build` runs `tsc` and emits production files to `dist/`.
- `npm test` runs the Vitest suite once.

## Coding Style & Naming Conventions
This repository uses strict TypeScript with ES modules. Follow the existing style: 2-space indentation, double quotes, semicolons, and explicit `.js` import specifiers in TypeScript source. Prefer small, focused modules and descriptive camelCase identifiers; use PascalCase for exported types and classes, such as `CodyConfig` and `CodexSessionService`.

Keep environment variable names uppercase with underscores, for example `CODEX_APPROVAL_POLICY`. Match new filenames to the current pattern: lowercase kebab-free names in `src/`, and `*.test.ts` in `test/`.

## Testing Guidelines
Tests use Vitest with globals enabled and the pattern `test/**/*.test.ts`. Add or update tests alongside behavior changes, especially for config parsing, formatting, and session lifecycle logic. Run `npm test` before opening a PR; run `npm run build` when changing types, imports, or entrypoint wiring.

## Commit & Pull Request Guidelines
Веди Git тихо: перед крупной переработкой фиксируй проверенное состояние, после работы делай смысловой коммит; не перечисляй коммиты в отчёте и не пушь без прямой просьбы.

PRs should explain the behavior change, note any configuration or service impact, and link related issues when present. Include screenshots or Telegram message samples for UI or formatting changes.

## Security & Configuration Tips
Do not commit `.env`, API keys, or Telegram tokens. Restrict `TELEGRAM_ALLOWED_USER_IDS` to trusted users, and default to `CODEX_SANDBOX_MODE=workspace-write` unless broader access is required.

## Release Automation
`cody-tgbot` does not currently ship with a release workflow. Add one only when publishing or automated deploys become necessary.
