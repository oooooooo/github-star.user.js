// ==UserScript==
// @name        GitHub Star
// @namespace   https://github.com/oooooooo
// @description Show GitHub repository star counts next to repo links on any web page.
// @match       *://*/*
// @exclude     https://*.youtube.com/*
// @grant       GM_xmlhttpRequest
// @grant       GM_getValue
// @grant       GM_setValue
// @grant       GM_deleteValue
// @grant       GM_listValues
// @grant       GM_registerMenuCommand
// @connect     api.github.com
// @sandbox     DOM
// @inject-into content
// @version     0.18.0
// @author      oooooooo
// @license     MIT
// @homepageURL https://github.com/oooooooo/github-star
// @supportURL  https://github.com/oooooooo/github-star/issues
// @updateURL   https://raw.githubusercontent.com/oooooooo/github-star/main/github-star.user.js
// @downloadURL https://raw.githubusercontent.com/oooooooo/github-star/main/github-star.user.js
// ==/UserScript==
(() => {
	// The token is stored via the userscript manager (GM_setValue) rather than
	// hardcoded, so it survives auto-updates and is never committed to source.
	// Set or change it from the userscript menu: "Set GitHub access token".
	// Create one at https://github.com/settings/personal-access-tokens with
	// read-only access to starring.
	const TOKEN_KEY = "githubAccessToken";
	// Read the token from GM storage on every use instead of caching it at
	// load time: GM storage is shared across tabs, so a token set or cleared in
	// another tab must take effect here too (a stale copy made "Clear" refuse
	// to delete a token set elsewhere, and kept sending a deleted token).
	// eslint-disable-next-line no-undef
	const getAccessToken = () => GM_getValue(TOKEN_KEY, "");

	// Apply a token change without a disruptive full reload: clear the
	// rate-limit back-off and any failed lookups, then re-scan the page.
	const applyToken = (token) => {
		if (token) {
			// eslint-disable-next-line no-undef
			GM_setValue(TOKEN_KEY, token);
		} else {
			// eslint-disable-next-line no-undef
			GM_deleteValue(TOKEN_KEY);
		}
		rateLimitedUntil = 0;
		// eslint-disable-next-line no-undef
		GM_deleteValue(RATE_LIMIT_KEY);
		for (const [repo, star] of resolved) {
			if (star === null) {
				resolved.delete(repo);
			}
		}
		scan(document);
	};

	// The saved token is never passed to prompt()/confirm() (not even masked
	// or as a suffix): if the script ends up in the page's JS world, a hostile
	// page that has replaced window.prompt would otherwise receive the saved
	// token just from the user opening this dialog, even on Cancel.
	// eslint-disable-next-line no-undef
	GM_registerMenuCommand("Set GitHub access token", () => {
		const status = getAccessToken()
			? "A token is configured."
			: "No token is set.";
		const input = prompt(
			`GitHub personal access token (read-only; raises the API rate limit).\n${status} Enter a new token to replace it; Cancel or blank keeps the current setting.`,
			"",
		);
		// Cancel or blank input must not touch the saved token: with an empty
		// default, treating blank as "clear" would make an accidental OK wipe it.
		const token = input?.trim();
		if (!token) {
			return;
		}
		applyToken(token);
	});

	// eslint-disable-next-line no-undef
	GM_registerMenuCommand("Clear GitHub access token", () => {
		if (!getAccessToken()) {
			alert("No GitHub access token is set.");
			return;
		}
		if (!confirm("Remove the saved GitHub access token?")) {
			return;
		}
		applyToken("");
	});

	// Owner slugs that are really GitHub's own pages, not user/org repos.
	const githubOfficialLinks = new Set([
		"_private",
		"about",
		"apps",
		"blog",
		"codespaces",
		"collections",
		"enterprise",
		"explore",
		"features",
		"marketplace",
		"new",
		"organizations",
		"settings",
		"site",
		"sponsors",
		"trending",
		"topics",
	]);

	const DAY_MS = 24 * 60 * 60 * 1000;

	// The star cache and rate-limit state live in the userscript manager's
	// storage (GM_*Value), not localStorage: localStorage is per-origin, so
	// each site kept its own copy of the cache (duplicate API requests for the
	// same repo) and its own back-off record (each site re-tripped the same
	// global rate limit). GM storage is shared across every site the script
	// runs on. The "ghstar:" prefix keeps entries distinct from other script
	// values such as the access token.
	const cacheKey = (repoName) => `ghstar:${repoName}`;

	// Reserved key (no slash, so it can't collide with an "owner/repo" entry)
	// recording the epoch-ms until which the API rate limit is in effect.
	const RATE_LIMIT_KEY = "ghstar:rateLimitedUntil";

	// Read a cached "date,star" entry. Older versions cached per-site in
	// localStorage (originally under the bare "owner/repo" key, later under
	// "ghstar:owner/repo"); adopt those into GM storage so upgrading doesn't
	// invalidate the cache — otherwise every repo on the page would be
	// re-requested at once and trip the GitHub API rate limit (which is exactly
	// what made stars disappear after the prefix change). Returns
	// { date, star } (both numbers) or null.
	const readCache = (repoName) => {
		const key = cacheKey(repoName);
		// eslint-disable-next-line no-undef
		let raw = GM_getValue(key, null);
		if (raw === null) {
			// Guard the localStorage access itself: in sandboxed iframes merely
			// touching localStorage throws a SecurityError, and that must not
			// kill the script.
			try {
				const legacy =
					localStorage.getItem(key) ?? localStorage.getItem(repoName);
				// Only adopt legacy values that look like our "<timestamp>,<n>" format.
				if (legacy !== null && /^\d+,-?\d+$/.test(legacy)) {
					raw = legacy;
					// eslint-disable-next-line no-undef
					GM_setValue(key, legacy);
					localStorage.removeItem(key);
					localStorage.removeItem(repoName);
				}
			} catch {
				// No localStorage here (sandboxed iframe) — nothing to migrate.
			}
		}
		if (raw === null) {
			return null;
		}
		const [date, star] = raw.split(",");
		return { date: Number(date), star: Number(star) };
	};

	const getStar = (repoName) => {
		const apiUrl = `https://api.github.com/repos/${repoName}`;
		const token = getAccessToken();

		return new Promise((resolve, reject) => {
			// eslint-disable-next-line no-undef
			GM_xmlhttpRequest({
				method: "GET",
				url: apiUrl,
				// Only send the Authorization header when a token is set. Sending
				// `token ` with an empty value makes GitHub reject *every* request
				// with 401; omitting it falls back to unauthenticated access
				// (lower rate limit, but it works out of the box).
				headers: token ? { Authorization: `token ${token}` } : {},
				// Without a timeout, a connection that never completes fires neither
				// onload nor onerror, leaving this promise pending forever — which
				// permanently leaks one of the concurrency slots draining the queue.
				timeout: 10 * 1000,
				ontimeout: () => {
					reject(new Error(`Request timed out: ${apiUrl}`));
				},
				onload: (response) => {
					// A missing repo (404) is "no stars", not an error. Anything else
					// non-2xx (401 bad token, 403 rate limit, 5xx) is a genuine failure
					// and must not be mistaken for a zero-star repo.
					if (response.status === 404) {
						resolve(undefined);
						return;
					}
					if (response.status < 200 || response.status >= 300) {
						const err = new Error(
							`Request failed: ${response.status} ${response.statusText}`,
						);
						err.status = response.status;
						// A real rate-limit (429, or 403 with the quota exhausted):
						// record when it resets so we can back off until then.
						const headers = response.responseHeaders || "";
						const remaining = headers.match(/x-ratelimit-remaining:\s*(\d+)/i);
						if (
							response.status === 429 ||
							(response.status === 403 &&
								remaining &&
								Number(remaining[1]) === 0)
						) {
							const reset = headers.match(/x-ratelimit-reset:\s*(\d+)/i);
							const retry = headers.match(/retry-after:\s*(\d+)/i);
							err.rateLimitReset = reset
								? Number(reset[1]) * 1000
								: retry
									? Date.now() + Number(retry[1]) * 1000
									: Date.now() + 60 * 60 * 1000;
						}
						reject(err);
						return;
					}
					try {
						const data = JSON.parse(response.responseText);
						resolve(data.stargazers_count);
					} catch (parseError) {
						// A 200 with an unparseable body (proxy / error page) must
						// reject, not throw out of this callback: an uncaught throw here
						// would leave the promise pending forever and stall the queue.
						reject(parseError);
					}
				},
				onerror: (response) => {
					reject(
						new Error(
							`Request failed: ${response.status} ${response.statusText}`,
						),
					);
				},
			});
		});
	};

	const setStar = async (repoName) => {
		const date = Date.now();
		let star = await getStar(repoName);
		if (star === undefined) {
			star = -404;
		}
		// Cache the miss (-404) too, otherwise every page load re-requests
		// non-existent repos and burns through the API rate limit.
		// eslint-disable-next-line no-undef
		GM_setValue(cacheKey(repoName), `${date},${star}`);
		return star;
	};

	const skipLink = (repoName) =>
		githubOfficialLinks.has(repoName.split("/")[0]);

	// Inject the star badge via a CSS ::after pseudo-element so that we never
	// add or remove DOM nodes in the page. Frameworks (React/Vue/etc.) crash
	// when a third party inserts sibling nodes into DOM they manage; setting a
	// data-* attribute on an existing element is far less invasive.
	const STYLE_ID = "gh-star-style";
	if (!document.getElementById(STYLE_ID)) {
		const style = document.createElement("style");
		style.id = STYLE_ID;
		style.textContent = `
			a[data-gh-stars]::after {
				content: " \\2605" attr(data-gh-stars);
				color: #e3b341;
				font-weight: 600;
				white-space: nowrap;
			}
		`;
		(document.head || document.documentElement).appendChild(style);
	}

	// Evict cache entries we haven't refreshed in a long time so GM storage
	// doesn't grow without bound as you browse more repos over time.
	const MAX_CACHE_AGE = 90 * DAY_MS;
	// eslint-disable-next-line no-undef
	for (const key of GM_listValues()) {
		if (!key.startsWith("ghstar:") || key === RATE_LIMIT_KEY) {
			continue;
		}
		// eslint-disable-next-line no-undef
		const ts = Number(String(GM_getValue(key, "")).split(",")[0]);
		if (!ts || Date.now() - ts > MAX_CACHE_AGE) {
			// eslint-disable-next-line no-undef
			GM_deleteValue(key);
		}
	}

	// Once the API rate-limits us, further requests just fail too. Remember when
	// the limit resets (persisted in GM storage, so neither a reload nor another
	// site retries and fails again within the window) and serve cache until then.
	// eslint-disable-next-line no-undef
	let rateLimitedUntil = Number(GM_getValue(RATE_LIMIT_KEY, 0)) || 0;
	const isRateLimited = () => Date.now() < rateLimitedUntil;

	// Resolve a repo's star count from cache, or fetch it. Returns a number,
	// or null when there's nothing to show (uncached fetch failure).
	const resolveStar = async (repoName) => {
		const cached = readCache(repoName);
		if (cached && Date.now() - cached.date < DAY_MS) {
			return cached.star; // fresh cache hit — no request needed
		}
		if (isRateLimited()) {
			return cached ? cached.star : null; // serve cache, don't hit the API
		}
		try {
			return await setStar(repoName);
		} catch (e) {
			// A transient failure (rate limit, network error) must not erase an
			// existing badge: fall back to the stale cached value when we have one.
			console.error(repoName, e);
			if (e?.rateLimitReset) {
				rateLimitedUntil = e.rateLimitReset;
				// eslint-disable-next-line no-undef
				GM_setValue(RATE_LIMIT_KEY, String(rateLimitedUntil));
			}
			return cached ? cached.star : null;
		}
	};

	const applyStar = (anchors, star) => {
		if (star === null || Number(star) === -404) return;
		// No node insertion: just tag the anchor; the ::after rule renders the badge.
		const label = Number(star).toLocaleString("en-US");
		for (const el of anchors) {
			el.setAttribute("data-gh-stars", label);
		}
	};

	// Repos already resolved this page session (value = star | null) and repos
	// whose lookup is in flight (value = anchors waiting for the result). Both
	// dedupe work, so a repo that appears many times — or reappears via a later
	// DOM mutation — is fetched at most once.
	const resolved = new Map();
	const pending = new Map();
	const queue = [];
	const CONCURRENCY = 5;
	let active = 0;

	// Drain the queue with bounded concurrency: fast on link-heavy pages without
	// firing every request at once.
	const pump = () => {
		while (active < CONCURRENCY && queue.length > 0) {
			const repoName = queue.shift();
			active += 1;
			resolveStar(repoName)
				.then((star) => {
					resolved.set(repoName, star);
					applyStar(pending.get(repoName), star);
					pending.delete(repoName);
				})
				.finally(() => {
					active -= 1;
					pump();
				});
		}
	};

	// Anchoring the host (^https://github.com/) both fixes false matches on
	// look-alike domains (e.g. fakegithub.com) and excludes gist.github.com for
	// free; the [\w.-] class allows repos containing "." or "_".
	const REPO_RE = /^https?:\/\/github\.com\/(?<repo>[\w.-]+\/[\w.-]+)\/?$/;

	const considerAnchor = (a) => {
		// Skip SVG <a> (href is not a string) and anchors we already badged.
		if (typeof a.href !== "string") return;
		if (a.dataset && a.dataset.ghStars !== undefined) return;
		const match = a.href.match(REPO_RE);
		if (!match) return;
		// GitHub repo names are case-insensitive, so "Foo/Bar" and "foo/bar"
		// should share one lookup and cache entry.
		const repoName = match.groups.repo.toLowerCase();
		if (skipLink(repoName)) return;
		if (resolved.has(repoName)) {
			applyStar([a], resolved.get(repoName));
			return;
		}
		const waiting = pending.get(repoName);
		if (waiting) {
			waiting.push(a); // a fetch is already queued; ride along
			return;
		}
		pending.set(repoName, [a]);
		queue.push(repoName);
		pump();
	};

	const scan = (root) => {
		if (root.tagName === "A") {
			considerAnchor(root);
		} else if (root.querySelectorAll) {
			for (const a of root.querySelectorAll("a")) {
				considerAnchor(a);
			}
		}
	};

	scan(document);

	// Many sites add repo links after load (SPA navigation, infinite scroll);
	// watch for them so their badges appear too. Batch bursts of mutations into
	// one idle pass so busy pages (chat apps, feeds) aren't scanned per-mutation.
	const pendingScans = [];
	let scanScheduled = false;
	const scheduleIdle =
		typeof requestIdleCallback === "function"
			? requestIdleCallback
			: (cb) => setTimeout(cb, 200);
	const flushScans = () => {
		scanScheduled = false;
		const nodes = pendingScans.splice(0);
		for (const node of nodes) {
			scan(node);
		}
	};
	const observer = new MutationObserver((mutations) => {
		for (const mutation of mutations) {
			for (const node of mutation.addedNodes) {
				if (node.nodeType === 1) {
					pendingScans.push(node);
				}
			}
		}
		if (!scanScheduled && pendingScans.length > 0) {
			scanScheduled = true;
			scheduleIdle(flushScans);
		}
	});
	observer.observe(document.body || document.documentElement, {
		childList: true,
		subtree: true,
	});
})();
