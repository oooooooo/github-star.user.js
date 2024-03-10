// ==UserScript==
// @name        Twinkle Twinkle GitHub Star
// @namespace   Violentmonkey Scripts
// @description star
// @match       *://*/*
// @exclude     https://*.youtube.com/*
// @grant       GM_xmlhttpRequest
// @version     0.9.0
// @author      oooooooo
// ==/UserScript==
(async () => {
  'use strict'

  const YOUR_ACCESS_TOKEN = ''

  const githubOfficialLinks = [
    '_private',
    'about',
    'apps',
    'blog',
    'codespaces',
    'collections',
    'enterprise',
    'explore',
    'features',
    'marketplace',
    'new',
    'organizations',
    'settings',
    'site',
    'sponsors',
    'trending',
    'topics'
  ]

  const getStar = (repoName) => {
    const apiUrl = `https://api.github.com/repos/${repoName}`

    return new Promise((resolve, reject) => {
      // eslint-disable-next-line no-undef
      GM_xmlhttpRequest({
        method: 'GET',
        url: apiUrl,
        headers: {
          Authorization: `token ${YOUR_ACCESS_TOKEN}`
        },
        onload: (response) => {
          const data = JSON.parse(response.responseText)
          const stars = data.stargazers_count
          resolve(stars)
        },
        onerror: (response) => {
          reject(new Error(`Request failed: ${response.status} ${response.statusText}`))
        }
      })
    })
  }

  const skipLink = (repoName) => {
    for (const link of githubOfficialLinks) {
      const regexLink = RegExp(`^${link}/`)
      if (repoName.match(regexLink)) { return true }
    }
    return false
  }

  const updateStars = []

  const links = document.getElementsByTagName('a')
  for (let i = 0; i < links.length; i++) {
    const match = links[i].href.match(/github\.com\/(?<repo>[a-zA-Z0-9-]+\/[a-zA-Z0-9-]+)$/)
    if (!match) { continue }
    if (match.input.match(/https:\/\/gist\.github\.com/)) { continue }

    const repoName = match.groups.repo
    if (skipLink(repoName)) { continue }

    let date, star
    const item = localStorage.getItem(repoName)
    if (item) {
      [date, star] = item.split(',')

      if (star === '-404') {
        console.log(repoName, '404')
      }

      if (Date.now() - Number(date) >= 24 * 60 * 60 * 1000) {
        updateStars.push(repoName)
      }
    } else {
      date = Date.now()
      star = await getStar(repoName)
      // Page Not Found
      if (star === undefined) {
        console.log(repoName, 'Not Found')
        star = -404
      }
      localStorage.setItem(repoName, `${date},${star}`)
    }
    links[i].insertAdjacentHTML('afterend', ' <font color="#FFD700">★</font>' + Number(star).toLocaleString('en-US'))
  }
  console.log(updateStars)
})()
