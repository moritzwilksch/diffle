# Changelog

All notable changes to this project are documented in this file.

## [0.2.2](https://github.com/moritzwilksch/diffle/compare/v0.2.1...v0.2.2) - 2026-10-06

### Features

- _(help)_ Link docs and GitHub from the help screens ([#288](https://github.com/moritzwilksch/diffle/pull/288))

### Bug fixes

- _(lsp)_ Hit-test words inside word-level diff marks ([#293](https://github.com/moritzwilksch/diffle/pull/293))

## [0.2.1](https://github.com/moritzwilksch/diffle/compare/v0.2.0...v0.2.1) - 2026-10-06

### Features

- _(compare)_ Compare two named ranges like git range-diff ([#286](https://github.com/moritzwilksch/diffle/pull/286))

## [0.2.0](https://github.com/moritzwilksch/diffle/compare/v0.1.9...v0.2.0) - 2026-10-06

### Features

- _(session)_ [**breaking**] Reload a refs comparison on request instead of recomputing it ([#267](https://github.com/moritzwilksch/diffle/pull/267))
- _(lsp)_ Highlight occurrences on hovering ([#275](https://github.com/moritzwilksch/diffle/pull/275))
- _(tree)_ Fold all files down to the active file ([#276](https://github.com/moritzwilksch/diffle/pull/276))
- _(lsp)_ Match symbols by word-start prefixes, case-insensitively ([#278](https://github.com/moritzwilksch/diffle/pull/278))
- _(lsp)_ Peek the highlighted reference in context ([#282](https://github.com/moritzwilksch/diffle/pull/282))

### Bug fixes

- _(settings)_ Trim dialog prose to essentials ([#272](https://github.com/moritzwilksch/diffle/pull/272))
- _(ui)_ Reflow header and comment forms gracefully at narrow widths ([#273](https://github.com/moritzwilksch/diffle/pull/273))
- _(ui)_ Ease guarded button arm, disarm, and feedback labels ([#271](https://github.com/moritzwilksch/diffle/pull/271))
- _(lsp)_ List references when going to a definition from itself ([#280](https://github.com/moritzwilksch/diffle/pull/280))

### Documentation

- Use https://diffle.app for installer script ([#264](https://github.com/moritzwilksch/diffle/pull/264))
- _(readme)_ Refresh light and dark screenshots ([#270](https://github.com/moritzwilksch/diffle/pull/270))
- _(readme)_ Refresh screenshots, re-accept e2e snapshots ([#274](https://github.com/moritzwilksch/diffle/pull/274))
- _(readme)_ Refresh screenshots, re-accept keyboard help snapshot ([#283](https://github.com/moritzwilksch/diffle/pull/283))

### Testing

- Drop low-value tests, give each rule one owner ([#284](https://github.com/moritzwilksch/diffle/pull/284))

### Build and CI

- Add git-cliff for release notes generation ([#265](https://github.com/moritzwilksch/diffle/pull/265))
- Give tests a Windows timeout budget and stop autocrlf rewrites ([#285](https://github.com/moritzwilksch/diffle/pull/285))
- Give tests a Windows timeout budget and stop autocrlf rewrites ([#285](https://github.com/moritzwilksch/diffle/pull/285))

## [0.1.9](https://github.com/moritzwilksch/diffle/compare/v0.1.8...v0.1.9) - 2026-10-01

### Features

- _(screenshot)_ Add a capture runner and fix e2e verb papercuts ([#242](https://github.com/moritzwilksch/diffle/pull/242))
- Add `diffle show` to view a single commit ([#243](https://github.com/moritzwilksch/diffle/pull/243))
- _(review)_ Copy a file's path from its header ([#253](https://github.com/moritzwilksch/diffle/pull/253))
- _(tree)_ Mark a whole directory viewed from its tree row ([#255](https://github.com/moritzwilksch/diffle/pull/255))
- Add commit details in range comparison view ([#245](https://github.com/moritzwilksch/diffle/pull/245))

### Documentation

- Link website ([#247](https://github.com/moritzwilksch/diffle/pull/247))
- _(agents)_ Restrict e2e runs to explicit requests, e2e edits ([#254](https://github.com/moritzwilksch/diffle/pull/254))
- _(readme)_ Trim to installation, core workflows, user-visible limits ([#257](https://github.com/moritzwilksch/diffle/pull/257))
- Mention pierre ([#262](https://github.com/moritzwilksch/diffle/pull/262))

### Testing

- Wait out patch prewarm before rewriting worktree files ([#258](https://github.com/moritzwilksch/diffle/pull/258))
- _(cli)_ Spawn each help text once, outside test timeouts ([#261](https://github.com/moritzwilksch/diffle/pull/261))

### Build and CI

- Build a SEA ([#244](https://github.com/moritzwilksch/diffle/pull/244))
- _(sea)_ Wait for the local release server instead of sleeping ([#252](https://github.com/moritzwilksch/diffle/pull/252))
- Add update-snapshots workflow ([#256](https://github.com/moritzwilksch/diffle/pull/256))
- Wait until e2e test is done in update-snapshots ([#259](https://github.com/moritzwilksch/diffle/pull/259))
- Fix octo-sts subject ([#260](https://github.com/moritzwilksch/diffle/pull/260))

## [0.1.8](https://github.com/moritzwilksch/diffle/compare/v0.1.7...v0.1.8) - 2026-09-30

### Features

- _(comments)_ Render suggestions as a diff from the quoted lines ([#231](https://github.com/moritzwilksch/diffle/pull/231))
- _(review)_ Show binary images as images, with swipe, onion skin and difference views ([#233](https://github.com/moritzwilksch/diffle/pull/233))
- _(review)_ Gv toggles viewed on the file above the cursor ([#240](https://github.com/moritzwilksch/diffle/pull/240))

### Bug fixes

- Improve allowed origin help message ([#226](https://github.com/moritzwilksch/diffle/pull/226))
- _(cli)_ Reject unknown revisions before opening the browser ([#232](https://github.com/moritzwilksch/diffle/pull/232))
- _(review)_ Bring an off-screen file comment into view and focus it ([#235](https://github.com/moritzwilksch/diffle/pull/235))
- _(header)_ Walk the compare menu with j / k and the arrows ([#234](https://github.com/moritzwilksch/diffle/pull/234))
- _(review)_ Prewarm syntax highlighting ahead of scrolling ([#236](https://github.com/moritzwilksch/diffle/pull/236))
- _(client)_ Disable font ligatures ([#237](https://github.com/moritzwilksch/diffle/pull/237))
- _(review)_ Comment on the cursor's line when its number is pressed ([#239](https://github.com/moritzwilksch/diffle/pull/239))

### Testing

- _(fixture)_ Add a deterministic fixture repository ([#214](https://github.com/moritzwilksch/diffle/pull/214))

## [0.1.7](https://github.com/moritzwilksch/diffle/compare/v0.1.6...v0.1.7) - 2026-09-22

### Features

- _(client)_ Bundle Inter and JetBrains Mono ([#215](https://github.com/moritzwilksch/diffle/pull/215))
- _(header)_ Add `HistoryNav` component for back and forward jump navigation ([#222](https://github.com/moritzwilksch/diffle/pull/222))

### Bug fixes

- _(screenshot-change)_ Render design fonts and capture at 2x ([#210](https://github.com/moritzwilksch/diffle/pull/210))
- _(header)_ Show the s shortcut in the diff layout tooltip ([#220](https://github.com/moritzwilksch/diffle/pull/220))

### Refactors

- _(github)_ Talk to GitHub with a token instead of gh ([#221](https://github.com/moritzwilksch/diffle/pull/221))

### Other

- Update screenshots in readme ([#219](https://github.com/moritzwilksch/diffle/pull/219))

## [0.1.6](https://github.com/moritzwilksch/diffle/compare/v0.1.5...v0.1.6) - 2026-09-18

### Features

- _(settings)_ Show the installed version in the settings dialog ([#195](https://github.com/moritzwilksch/diffle/pull/195))
- _(cli)_ Default to working mode without revisions ([#206](https://github.com/moritzwilksch/diffle/pull/206))
- _(ui)_ Restyle segmented controls with a raised selected pill ([#209](https://github.com/moritzwilksch/diffle/pull/209))
- Revamp search behavior ([#208](https://github.com/moritzwilksch/diffle/pull/208))
- Revamp search behavior 2 ([#211](https://github.com/moritzwilksch/diffle/pull/211))

### Bug fixes

- _(review)_ Keep the draft comment's lines tinted and name them in the composer ([#199](https://github.com/moritzwilksch/diffle/pull/199))
- _(review)_ Keep the cursor still when marking a file viewed by mouse ([#198](https://github.com/moritzwilksch/diffle/pull/198))
- _(review)_ Land the held row at the document end in one frame ([#200](https://github.com/moritzwilksch/diffle/pull/200))
- _(review)_ Follow the pointer between words inside one token ([#197](https://github.com/moritzwilksch/diffle/pull/197))
- _(review)_ Select a file when its header is clicked ([#202](https://github.com/moritzwilksch/diffle/pull/202))
- _(lsp)_ Scroll the focused reference out from under its sticky header ([#201](https://github.com/moritzwilksch/diffle/pull/201))
- Nix CI ([#207](https://github.com/moritzwilksch/diffle/pull/207))
- _(review)_ Show a note for a diff without hunks instead of an empty body ([#174](https://github.com/moritzwilksch/diffle/pull/174))

## [0.1.5](https://github.com/moritzwilksch/diffle/compare/v0.1.4...v0.1.5) - 2026-09-15

### Features

- Add nix flake ([#156](https://github.com/moritzwilksch/diffle/pull/156))
- _(ModePicker)_ Default to merge base and remove offset input tooltip ([#163](https://github.com/moritzwilksch/diffle/pull/163))
- _(comments)_ Comment on a whole file, not only on lines ([#160](https://github.com/moritzwilksch/diffle/pull/160))
- _(skills)_ Add symlink for `screenshot-change` skill ([#178](https://github.com/moritzwilksch/diffle/pull/178))
- _(screenshot-change)_ Add video recording support to skill ([#183](https://github.com/moritzwilksch/diffle/pull/183))

### Bug fixes

- _(ui)_ Stop marking Working as expanded in the compare menu ([#159](https://github.com/moritzwilksch/diffle/pull/159))
- _(snapshot)_ Honor linguist-generated gitattributes ([#158](https://github.com/moritzwilksch/diffle/pull/158))
- _(review)_ Show a placeholder when a binary file is expanded ([#173](https://github.com/moritzwilksch/diffle/pull/173))
- _(server)_ Name the rejected header in 403 responses ([#184](https://github.com/moritzwilksch/diffle/pull/184))
- _(review)_ Move to the next unviewed file after v, not the next open one ([#177](https://github.com/moritzwilksch/diffle/pull/177))
- _(review)_ Hold the viewport across split/unified and theme toggles ([#175](https://github.com/moritzwilksch/diffle/pull/175))
- _(tooltip)_ Show tooltips for ellipsized tree rows and titles in shadow roots ([#179](https://github.com/moritzwilksch/diffle/pull/179))
- _(hover)_ Keep the type tooltip open while the pointer is on it ([#176](https://github.com/moritzwilksch/diffle/pull/176))

### Testing

- Make the watcher and highlight tests fast and deterministic ([#181](https://github.com/moritzwilksch/diffle/pull/181))

### Build and CI

- Fix Assign Labels workflow on forks ([#157](https://github.com/moritzwilksch/diffle/pull/157))
- Get rid of id-token: write ([#162](https://github.com/moritzwilksch/diffle/pull/162))

## [0.1.4](https://github.com/moritzwilksch/diffle/compare/v0.1.3...v0.1.4) - 2026-09-11

### Features

- _(cli)_ Add proxy-managed request validation mode ([#154](https://github.com/moritzwilksch/diffle/pull/154))

## [0.1.3](https://github.com/moritzwilksch/diffle/compare/v0.1.2...v0.1.3) - 2026-09-11

### Bug fixes

- _(client)_ Support reverse proxy path prefixes ([#143](https://github.com/moritzwilksch/diffle/pull/143))
- _(cli)_ Show bind address in startup message ([#142](https://github.com/moritzwilksch/diffle/pull/142))

## [0.1.2](https://github.com/moritzwilksch/diffle/compare/v0.1.1...v0.1.2) - 2026-09-11

### Features

- _(lsp)_ Add schema hovers for configuration files ([#138](https://github.com/moritzwilksch/diffle/pull/138))

### Refactors

- Use zod for types ([#135](https://github.com/moritzwilksch/diffle/pull/135))

## [0.1.1](https://github.com/moritzwilksch/diffle/compare/v0.1.0...v0.1.1) - 2026-09-11

### Features

- Add completion command ([#114](https://github.com/moritzwilksch/diffle/pull/114))
- _(lsp)_ Surface loading progress and server diagnostics ([#113](https://github.com/moritzwilksch/diffle/pull/113))

### Bug fixes

- _(client)_ Move focus to the review pane after a mode switch ([#101](https://github.com/moritzwilksch/diffle/pull/101))
- _(ui)_ Resolve several small ui papercuts ([#119](https://github.com/moritzwilksch/diffle/pull/119))
- _(lsp)_ Bound stderr log with its own scroll ([#121](https://github.com/moritzwilksch/diffle/pull/121))
- _(ui)_ Replace slow native tooltips with a fast host ([#122](https://github.com/moritzwilksch/diffle/pull/122))

### Refactors

- _(client)_ Migrate styling to Tailwind CSS ([#109](https://github.com/moritzwilksch/diffle/pull/109))
- Rework github integration ([#125](https://github.com/moritzwilksch/diffle/pull/125))

### Documentation

- Change npm badge link in README ([#93](https://github.com/moritzwilksch/diffle/pull/93))

### Build and CI

- Run the tests and the build on Windows, macOS and arm64 ([#60](https://github.com/moritzwilksch/diffle/pull/60))

## [0.1.0](https://github.com/moritzwilksch/diffle/compare/v0.0.2...v0.1.0) - 2026-09-09

### Features

- GitHub high-contrast syntax themes ([#40](https://github.com/moritzwilksch/diffle/pull/40))
- _(cli)_ `diffle pr` takes a PR number or url ([#39](https://github.com/moritzwilksch/diffle/pull/39))
- Add export endpoint and UI for single comment prompt copy ([#85](https://github.com/moritzwilksch/diffle/pull/85))
- _(client)_ Gate symbol popups with tree-sitter syntax ([#76](https://github.com/moritzwilksch/diffle/pull/76))
- _(lsp)_ Open definitions outside the snapshot read-only ([#79](https://github.com/moritzwilksch/diffle/pull/79))
- Improve compare view ([#89](https://github.com/moritzwilksch/diffle/pull/89))

### Bug fixes

- Empty default mark as viewed ([#31](https://github.com/moritzwilksch/diffle/pull/31))
- _(tests)_ Fix flaky test ([#66](https://github.com/moritzwilksch/diffle/pull/66))
- _(store)_ Reopen a viewed file whose blob changes on refresh ([#74](https://github.com/moritzwilksch/diffle/pull/74))
- Highlight every line of a range comment ([#78](https://github.com/moritzwilksch/diffle/pull/78))
- _(client)_ Open collapsed files from the file tree ([#77](https://github.com/moritzwilksch/diffle/pull/77))
- _(review)_ Toggle files from the full header ([#83](https://github.com/moritzwilksch/diffle/pull/83))
- _(test)_ Signal the cli directly in clone cleanup test ([#86](https://github.com/moritzwilksch/diffle/pull/86))

### Refactors

- Simplify cli, get rid of `diffle branch` ([#81](https://github.com/moritzwilksch/diffle/pull/81))

### Documentation

- Simplify and restructure `README.md` ([#33](https://github.com/moritzwilksch/diffle/pull/33))
- Remove host binding security warning from README ([#34](https://github.com/moritzwilksch/diffle/pull/34))
- Add installation instructions to README ([#37](https://github.com/moritzwilksch/diffle/pull/37))
- Condense and update AGENTS.md architecture and invariants ([#65](https://github.com/moritzwilksch/diffle/pull/65))

### Build and CI

- Verify package-lock.json stays in sync with package.json ([#35](https://github.com/moritzwilksch/diffle/pull/35))
- Add oxlint linting and fix linter violations ([#38](https://github.com/moritzwilksch/diffle/pull/38))
- Add GitHub release notes changelog config ([#90](https://github.com/moritzwilksch/diffle/pull/90))

### Other

- Remove native focus ring from `.review .codeview` ([#55](https://github.com/moritzwilksch/diffle/pull/55))
- Add oxfmt as the formatter, checked in CI ([#43](https://github.com/moritzwilksch/diffle/pull/43))
- Add PR title lint workflow and update AGENTS.md ([#73](https://github.com/moritzwilksch/diffle/pull/73))

## [0.0.2](https://github.com/moritzwilksch/diffle/releases/tag/v0.0.2) - 2026-09-08
