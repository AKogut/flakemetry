<script setup lang="ts">
import { useData } from 'vitepress'

import type { ThemeConfig } from '../config'

const { theme } = useData<ThemeConfig>()
</script>

<template>
  <div v-if="theme.docsVersion" class="version-banner" role="note">
    <span>This is the documentation of the {{ theme.docsVersion }} release.</span>
    <a :href="theme.latestUrl" target="_self">Read the latest</a>
  </div>
</template>

<style scoped>
.version-banner {
  position: fixed;
  top: 0;
  right: 0;
  left: 0;
  z-index: var(--vp-z-index-layout-top);
  display: flex;
  gap: 0.75rem;
  align-items: center;
  justify-content: center;
  height: var(--vp-layout-top-height);
  padding: 0 1rem;
  font-size: 0.875rem;
  color: var(--vp-c-warning-1);
  background: var(--vp-c-warning-soft);
  border-bottom: 1px solid var(--vp-c-divider);
}

.version-banner a {
  font-weight: 600;
  color: var(--vp-c-brand-1);
  white-space: nowrap;
}

@media (max-width: 640px) {
  .version-banner span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}
</style>
