/**
 * What an exported tour bundles and the licences it must carry with it: `export/notices.json`,
 * written by the export build (`vite.export.config.ts`) and inlined by the client into every
 * exported file.
 */
export interface ExportNotices {
  /** One line each, in the order listed: `react 19.2.0 (MIT)`, `Inter (OFL-1.1)`. */
  bundled: string[];
  /** Each distinct licence text once, with what it covers: packages by `name version`, fonts by name. */
  licences: { covers: string[]; text: string }[];
}
