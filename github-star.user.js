// ==UserScript==
// @name        GitHub Star
// @namespace   https://github.com/oooooooo
// @description Show GitHub repository star counts next to repo links on any web page.
// @match       *://*/*
// @exclude     https://*.youtube.com/*
// @grant       GM_xmlhttpRequest
// @connect     api.github.com
// @version     0.13.0
// @author      oooooooo
// @homepageURL https://github.com/oooooooo/github-star
// @supportURL  https://github.com/oooooooo/github-star/issues
// @updateURL   https://raw.githubusercontent.com/oooooooo/github-star/main/github-star.user.js
// @downloadURL https://raw.githubusercontent.com/oooooooo/github-star/main/github-star.user.js
// ==/UserScript==
(async () => {
	// https://github.com/settings/personal-access-tokens
	// - Read access to starring
	const YOUR_ACCESS_TOKEN = "";

	const githubOfficialLinks = [
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
	];

	const DAY_MS = 24 * 60 * 60 * 1000;

	// Namespace localStorage keys so the cache never collides with (or is
	// clobbered by) other scripts or the page itself.
	const cacheKey = (repoName) => `ghstar:${repoName}`;

	// Read a cached "date,star" entry. Older versions stored entries under the
	// bare "owner/repo" key; migrate those in place so upgrading doesn't
	// invalidate the whole cache — otherwise every repo on the page would be
	// re-requested at once and trip the GitHub API rate limit (which is exactly
	// what made stars disappear after the prefix change). Returns
	// { date, star } (both numbers) or null.
	const readCache = (repoName) => {
		const key = cacheKey(repoName);
		let raw = localStorage.getItem(key);
		if (raw === null) {
			const legacy = localStorage.getItem(repoName);
			// Only adopt legacy values that look like our "<timestamp>,<n>" format.
			if (legacy !== null && /^\d+,-?\d+$/.test(legacy)) {
				raw = legacy;
				localStorage.setItem(key, legacy);
				localStorage.removeItem(repoName);
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

		return new Promise((resolve, reject) => {
			// eslint-disable-next-line no-undef
			GM_xmlhttpRequest({
				method: "GET",
				url: apiUrl,
				// Only send the Authorization header when a token is set. Sending
				// `token ` with an empty value makes GitHub reject *every* request
				// with 401; omitting it falls back to unauthenticated access
				// (lower rate limit, but it works out of the box).
				headers: YOUR_ACCESS_TOKEN
					? { Authorization: `token ${YOUR_ACCESS_TOKEN}` }
					: {},
				onload: (response) => {
					// A missing repo (404) is "no stars", not an error. Anything else
					// non-2xx (401 bad token, 403 rate limit, 5xx) is a genuine failure
					// and must not be mistaken for a zero-star repo.
					if (response.status === 404) {
						resolve(undefined);
						return;
					}
					if (response.status < 200 || response.status >= 300) {
						reject(
							new Error(
								`Request failed: ${response.status} ${response.statusText}`,
							),
						);
						return;
					}
					const data = JSON.parse(response.responseText);
					resolve(data.stargazers_count);
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
			console.log(repoName, "Not Found");
			star = -404;
		}
		// Cache the miss (-404) too, otherwise every page load re-requests
		// non-existent repos and burns through the API rate limit.
		localStorage.setItem(cacheKey(repoName), `${date},${star}`);
		return star;
	};

	const skipLink = (repoName) => {
		for (const link of githubOfficialLinks) {
			const regexLink = RegExp(`^${link}/`);
			if (repoName.match(regexLink)) {
				return true;
			}
		}
		return false;
	};

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

	// Resolve a repo's star count from cache, or fetch it. Returns a number,
	// or null when there's nothing to show (uncached fetch failure).
	const resolveStar = async (repoName) => {
		const cached = readCache(repoName);
		if (cached && Date.now() - cached.date < DAY_MS) {
			return cached.star; // fresh cache hit — no request needed
		}
		try {
			return await setStar(repoName);
		} catch (e) {
			// A transient failure (rate limit, network error) must not erase an
			// existing badge: fall back to the stale cached value when we have one.
			console.error(repoName, e);
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

	// Collect matching links, grouping anchors by repo so each repo is looked
	// up at most once even when it appears many times on the page. Anchoring
	// the host (^https://github.com/) both fixes false matches on look-alike
	// domains (e.g. fakegithub.com) and excludes gist.github.com for free; the
	// widened character class [\w.-] now allows repos containing "." or "_".
	const targets = new Map(); // repoName -> anchor[]
	const links = document.getElementsByTagName("a");
	for (let i = 0; i < links.length; i++) {
		const match = links[i].href.match(
			/^https?:\/\/github\.com\/(?<repo>[\w.-]+\/[\w.-]+)\/?$/,
		);
		if (!match) {
			continue;
		}
		const repoName = match.groups.repo;
		if (skipLink(repoName)) {
			continue;
		}
		const anchors = targets.get(repoName);
		if (anchors) {
			anchors.push(links[i]);
		} else {
			targets.set(repoName, [links[i]]);
		}
	}

	// Look repos up with bounded concurrency: fast on link-heavy pages without
	// firing every request at once.
	const CONCURRENCY = 5;
	const repoNames = [...targets.keys()];
	let cursor = 0;
	const worker = async () => {
		while (cursor < repoNames.length) {
			const repoName = repoNames[cursor++];
			applyStar(targets.get(repoName), await resolveStar(repoName));
		}
	};
	await Promise.all(
		Array.from({ length: Math.min(CONCURRENCY, repoNames.length) }, worker),
	);
})();
