// ==UserScript==
// @name        GitHub Star
// @namespace   https://github.com/oooooooo
// @description Show GitHub repository star counts next to repo links on any web page.
// @match       *://*/*
// @exclude     https://*.youtube.com/*
// @grant       GM_xmlhttpRequest
// @version     0.11.0
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
					const data = JSON.parse(response.responseText);
					const stars = data.stargazers_count;
					resolve(stars);
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
		} else {
			localStorage.setItem(repoName, `${date},${star}`);
		}
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

		let date;
		let star;
		const item = localStorage.getItem(repoName);
		if (item) {
			[date, star] = item.split(",");

			if (Date.now() - Number(date) >= 24 * 60 * 60 * 1000) {
				star = await setStar(repoName);
			}
		} else {
			star = await setStar(repoName);
		}
		if (star === -404) continue;
		// No node insertion: just tag the anchor; the ::after rule renders the badge.
		links[i].setAttribute(
			"data-gh-stars",
			Number(star).toLocaleString("en-US"),
		);
	}
})();
