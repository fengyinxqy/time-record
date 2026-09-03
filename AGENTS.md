# Repository Guidelines

## Project Structure & Module Organization

This is a Tauri 2 desktop time-tracking app with a React/TypeScript frontend and a Rust backend. Frontend code is in `src/`: `App.tsx` owns the timer and history views, while focused modules such as `timer.ts`, `projectModel.ts`, and `viewMode.ts` contain testable domain logic. Their Vitest specs sit beside them as `*.test.ts`. Styling is in `src/App.css`; static assets are in `public/` and `src/assets/`.

The native layer lives in `src-tauri/`: `src/lib.rs` registers Tauri commands and window/tray behavior, `db.rs` manages SQLite persistence, and `domain.rs` contains Rust domain helpers. Tauri configuration and capabilities are under `src-tauri/`. Product notes belong in `docs/plans/`; exploratory UI sketches belong in `sketches/`.

## Build, Test, and Development Commands

- `npm install` installs frontend and Tauri CLI dependencies.
- `npm run dev` starts the Vite frontend for browser-focused UI work.
- `npm run tauri -- dev` starts the full desktop application with the Rust backend.
- `npm run build` type-checks TypeScript and creates the frontend bundle in `dist/`.
- `npm test` runs the Vitest suite once; use `npm run test:watch` while changing frontend logic.
- `cargo test --manifest-path src-tauri/Cargo.toml` runs Rust unit tests.
- `cargo fmt --check --manifest-path src-tauri/Cargo.toml` verifies Rust formatting.

## Coding Style & Naming Conventions

Use TypeScript with two-space indentation, double quotes, trailing commas, and semicolons, matching existing files. Use `PascalCase` for React components and types, `camelCase` for functions and values, and focused lowercase module names such as `historyModel.ts`. Keep presentation in `App.tsx`/`App.css` and move reusable calculations into small modules with tests.

Use Rust's standard `rustfmt` style (four spaces). Keep Tauri commands explicit, use `snake_case` Rust identifiers, and preserve `#[serde(rename_all = "camelCase")]` for frontend-facing data.

## Testing Guidelines

Add or update colocated Vitest tests for frontend logic; name behavior clearly, for example `it("clips an active segment to now")`. Cover date boundaries, active timers, and data grouping when changing time-recording behavior. Add `#[cfg(test)]` unit tests beside Rust domain/database code, then run both test suites before requesting review.

## Commit & Pull Request Guidelines

Recent history follows Conventional Commit-style prefixes: `feat:`, `fix:`, and `docs:`. Write concise imperative subjects, for example `fix: persist paused timer segments`. Keep each commit scoped to one change.

Pull requests should explain the user-visible change, list validation commands run, link the relevant issue or plan when available, and include screenshots for UI changes. Do not commit generated `dist/`, `target/`, local `.env` files, or runtime SQLite data.
