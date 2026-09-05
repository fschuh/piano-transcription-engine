/**
 * Extracts every module specifier a source file imports or re-exports,
 * including bare side-effect imports such as `import "react";`. A boundary
 * check that only looked for `from "…"` would let a side-effect import of
 * forbidden code through unnoticed.
 */
const patterns = [
  /(?:^|[\s;}])(?:import|export)\s[^;]*?\sfrom\s*["']([^"']+)["']/g,
  /(?:^|[\s;}])import\s*\(\s*["']([^"']+)["']\s*\)/g,
  /(?:^|[\s;}])import\s*["']([^"']+)["']/g,
];

export function moduleSpecifiersOf(source) {
  const specifiers = [];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      if (match[1] !== undefined) specifiers.push(match[1]);
    }
  }
  return specifiers;
}
