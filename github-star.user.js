// ==UserScript==
// @name        GitHub Star
// @namespace   https://github.com/oooooooo
// @description Show GitHub repository star counts next to repo links on any web page.
// @match       *://*/*
// @exclude     https://*.youtube.com/*
// @grant       GM_xmlhttpRequest
// @connect     api.github.com
// @version     0.12.0
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
				headers: {
					Authorization: `token ${YOUR_ACCESS_TOKEN}`,
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

	const links = document.getElementsByTagName("a");
	for (let i = 0; i < links.length; i++) {
		const match = links[i].href.match(
			/github\.com\/(?<repo>[a-zA-Z0-9-]+\/[a-zA-Z0-9-]+)$/,
		);
		if (!match) {
			continue;
		}
		if (match.input.match(/https:\/\/gist\.github\.com/)) {
			continue;
		}

		const repoName = match.groups.repo;
		if (skipLink(repoName)) {
			continue;
		}
		//console.log(match.input)

		const cached = readCache(repoName);
		let star;
		if (cached && Date.now() - cached.date < DAY_MS) {
			// Fresh cache hit — no request needed.
			star = cached.star;
		} else {
			try {
				star = await setStar(repoName);
			} catch (e) {
				// A transient failure (rate limit, network error) must neither abort
				// the loop nor erase an existing badge: fall back to the stale cached
				// value when we have one, otherwise skip just this link.
				console.error(repoName, e);
				if (!cached) continue;
				star = cached.star;
			}
		}
		if (star === -404) continue;
		// No node insertion: just tag the anchor; the ::after rule renders the badge.
		links[i].setAttribute(
			"data-gh-stars",
			Number(star).toLocaleString("en-US"),
		);
	}
})();
