---
title: Versions
---

<script setup lang="ts">
import { useData, withBase } from 'vitepress'

const { theme } = useData()
</script>

# Versions

This site follows `main`. A self-hosted instance runs whatever commit it was deployed from,
so each release also keeps a copy of the documentation exactly as it was when the release
went out. Pick the latest release on or before the day you deployed.

<ul v-if="theme.snapshots.length > 0">
  <li v-for="label in theme.snapshots" :key="label">
    <a :href="withBase(`/v/${label}/`)" target="_self">{{ label }}</a>
  </li>
</ul>
<p v-else>No release has kept a copy yet. The first one appears here after the next release.</p>

Releases are labelled by date. What each one changed in the published packages is in the
[GitHub releases](https://github.com/AKogut/flakemetry/releases). A copy is taken when a
version pull request is merged, so it matches the packages that release put on npm and the
platform as it was on `main` at that moment. A second release on the same day replaces that
day's copy.
