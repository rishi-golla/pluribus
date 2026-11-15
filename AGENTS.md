# Project notes

## Web app (`web/`)

- Stack: Next.js 16 (App Router, Turbopack, Cache Components), React 19, TypeScript, Tailwind CSS v4, lucide-react.
- This Next.js version differs from older releases. Read the bundled docs in `web/node_modules/next/dist/docs/` before using an API.
- Commands (run inside `web/`):
  - `npm run dev` for the dev server
  - `npm run lint`
  - `npx tsc --noEmit` for typechecking
  - `npm run build` for a production build; the landing page should report as `(Static)`
- Design tokens live in the `@theme` block of `web/src/app/globals.css`. Tailwind's default `text-*` line heights are overridden to 1.4 to match the mockups.
- Charts use a seeded, deterministic series generator so prerendered output is stable. Avoid `Math.random()` and `Date.now()` in rendered components.

## Design references

- Approved mockups are in `mockups/previous/` (PNG) with their HTML sources in `mockups/_src/previous/`. They are kept locally and are not committed.
- To check fidelity, screenshot the production build at 1440px wide and 2x scale with headless Chrome, then diff it against the mockup PNG.

## Dependencies

- Pin new dependencies to releases published at least 7 days ago.
