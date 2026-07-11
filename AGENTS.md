# Agents

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

A single-file userscript (`github-star.user.js`, Violentmonkey/Tampermonkey) that finds GitHub repository links on any web page and appends a ★ star-count badge. There is no build step, package.json, or test framework. Lint/format with Biome (default config via `npx`).

## Commands

- Syntax check: `node --check github-star.user.js`
- Lint/format: `npx @biomejs/biome check github-star.user.js` (must pass before reporting done)
- There are no automated tests. Behavior is verified with ad-hoc Node harnesses in the scratchpad: mock `GM_*` functions, `localStorage`, `document`/anchors, and `MutationObserver` as globals, then `eval()` the script source and assert on `setAttribute` calls and storage contents. See git history (test scenarios are described in commit messages) for the pattern.

## Working rules

- **Do not `git commit` until the user explicitly asks.** Implement, verify, report, then wait.
- Changes must pass `npx @biomejs/biome check github-star.user.js`.
- Commit messages follow Conventional Commits (`type(scope): description`, imperative lowercase description; body explains why).
- Bump `@version` on every functional change — installed clients only auto-update when the version increases (`@updateURL` points at raw `main`).

## Architecture

Everything lives in one IIFE in `github-star.user.js`. The flow: scan anchors → match repo URLs → resolve star counts (cache or GitHub API) → tag anchors with `data-gh-stars`, rendered by an injected CSS `::after` rule.

Key design decisions (each fixed a real regression — do not undo casually):

- **Never insert DOM nodes.** Badges are rendered purely via CSS `::after` on a `data-gh-stars` attribute. Inserting sibling nodes crashes React/Vue-managed pages.
- **Cache and rate-limit state live in GM storage (`GM_*Value`), not localStorage.** localStorage is per-origin, which duplicated the cache per site and made every site re-trip GitHub's global rate limit. `readCache()` still migrates legacy localStorage entries (bare `owner/repo` and `ghstar:owner/repo` keys) in place — removing that migration invalidates existing caches and causes a request storm that hits the rate limit and makes all stars vanish (this happened once).
- **Failures must never erase badges or stall the queue.** Fetch errors fall back to the stale cached value; 404s are cached as the `-404` sentinel so missing repos aren't re-requested; a real rate limit (429, or 403 with `X-RateLimit-Remaining: 0`) persists a back-off deadline (`ghstar:rateLimitedUntil`) honored across reloads and sites. Every async path in `GM_xmlhttpRequest` must settle the promise (`onload` JSON parse is wrapped, `ontimeout`/`onerror` reject) — an unsettled promise permanently leaks one of the 5 concurrency slots.
- **Lookups are deduplicated and bounded.** `resolved`/`pending` maps ensure each repo (lowercased — GitHub is case-insensitive) is fetched at most once per page session; a queue drained by `pump()` caps concurrency at 5. Dynamically added links are picked up by a MutationObserver whose bursts are batched through `requestIdleCallback`.
- **The access token comes from `GM_getValue`, set via the "Set GitHub access token" menu command.** When empty, the `Authorization` header must be omitted entirely — sending `token` with an empty value makes GitHub 401 every request.
- **`githubOfficialLinks` is an optimization, not a correctness list.** Unknown official paths simply 404 once and get cached as `-404`, so the list doesn't need to be exhaustive.
