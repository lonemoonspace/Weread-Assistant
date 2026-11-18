import { computed } from "../../vendor/vue.esm-browser.prod.js";

// 把文字按搜索词切开，命中的部分用 <mark> 显示（逐段输出文字，不拼 HTML）
export function pieces(text, query) {
  const source = String(text || "");
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return [{ text: source, hit: false }];
  }
  const lower = source.toLowerCase();
  const result = [];
  let from = 0;
  for (let at = lower.indexOf(needle); at >= 0; at = lower.indexOf(needle, from)) {
    if (at > from) {
      result.push({ text: source.slice(from, at), hit: false });
    }
    result.push({ text: source.slice(at, at + needle.length), hit: true });
    from = at + needle.length;
  }
  if (from < source.length) {
    result.push({ text: source.slice(from), hit: false });
  }
  return result;
}

export const Highlighted = {
  props: { text: String, query: { type: String, default: "" } },
  setup(props) {
    return { parts: computed(() => pieces(props.text, props.query)) };
  },
  template: `<template v-for="(part, index) in parts" :key="index"><mark v-if="part.hit">{{ part.text }}</mark><template v-else>{{ part.text }}</template></template>`,
};
