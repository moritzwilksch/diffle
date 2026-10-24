# Large-repository benchmarks

Scripts that measure diffle on a big repository, and what they found on the Linux kernel
(`torvalds/linux`, 96,386 files, 6,300 directories, 10 MB index).

| Script       | Measures                                                                                                                                       |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `server.ts`  | startup, `/api/snapshot`, patches in client-sized batches, the unbatched `/api/patch`, a repository search                                     |
| `churn.ts`   | snapshots announced and CPU spent (diffle plus its git children) while a command writes to the worktree                                        |
| `browser.ts` | the client in Chromium: first line, time until it stops fetching, long tasks, heap, keypress latency; `--profile` prints the hottest functions |
| `diffle.ts`  | shared: serve a review, read `/proc` (Linux only)                                                                                              |

## Reproduce

```sh
git clone --depth 1 https://github.com/torvalds/linux.git ../linux
git -C ../linux fetch --depth 1 origin tag v7.3 tag v7.0 tag v6.0
git -C ../linux fetch --shallow-exclude=v7.3 origin master   # the 7.4 merge window
pixi run build-release

npx tsx scripts/bench/server.ts ../linux merge-window -- v7.3..HEAD
npx tsx scripts/bench/browser.ts ../linux merge-window --max-seconds 600 -- v7.3..HEAD
(cd ../linux && make defconfig)
npx tsx scripts/bench/churn.ts ../linux make --cmd 'make -s -j3 kernel/ mm/'
```

`--bin` names another build; `--out` appends each result to a JSON-lines file. Without Playwright's
own Chromium, pass `--chromium <path>`.

## Results (Linux at 7.4-rc1 merge window, 4 vCPU, 16 GB)

### Server

| Review                    | Files changed | ± lines      | Snapshot | `/api/snapshot` size | Cached re-fetch | Peak RSS |
| ------------------------- | ------------: | ------------ | -------: | -------------------: | --------------: | -------: |
| `working`, clean          |             0 | 0            |    0.9 s |                 4 MB |          140 ms |    31 MB |
| `show` (a merge)          |            42 | +1.3k −0.3k  |    0.1 s |                 4 MB |          130 ms |    31 MB |
| `v7.3..HEAD` merge window |         2,611 | +90k −32k    |    1.2 s |                 5 MB |          190 ms |    55 MB |
| `working`, 3,301 edits    |         3,301 | +32k −32k    |    2.8 s |                 5 MB |          150 ms |    69 MB |
| `working`, one 24 MB file |             1 | +195k −195k  |    1.0 s |                 4 MB |          150 ms |   171 MB |
| `v7.0..v7.3`              |        31,329 | +2.5M −0.9M  |   12.9 s |                11 MB |          380 ms |   622 MB |
| `v6.0..v7.3`              |        82,730 | +13.7M −4.9M |     80 s |                22 MB |          850 ms |   499 MB |

Patch batches stay fast at every size (50 files in 30–160 ms; a 24 MB file's 47 MB patch in 0.8 s).
Repository search answers in 0.1–0.5 s.

### Client (Chromium)

| Review                      |            First line | Done fetching   | Requests (patch / file)             | Long tasks (total / max)         |                Heap | `n` keypress |
| --------------------------- | --------------------: | --------------- | ----------------------------------- | -------------------------------- | ------------------: | -----------: |
| `show`, 42 files            |                 0.9 s | 1.3 s           | 4 / 76                              | 0.6 s / 142 ms                   |               29 MB |        51 ms |
| merge window, 2,611 files   |                 1.4 s | 52 s → **22 s** | 219 / 4,458                         | 3.9 s → **0.9 s** / 509 → 277 ms |          236–288 MB | 137 → 105 ms |
| `v7.0..v7.3`, 31,329 files  |       28 s → **13 s** | not in 10 min   | 106 → 2,295 / 420 → 9,400 in 10 min | ~100% busy / 11.2 → 1.4 s        | 209 MB → **1.8 GB** |  3.1 → 0.9 s |
| one 24 MB file, "Load diff" | 3.6 s after the click | –               | 1 / 0                               | 2.5 s / 1.7 s                    |               87 MB |        77 ms |

Arrows are before → after the client fix below.

### Watching the worktree while building

| Workload (`working`, clean tree)                  | Snapshots |         diffle + git CPU |
| ------------------------------------------------- | --------: | -----------------------: |
| real `make -j3 kernel/ mm/` (~80 s), before       |       160 |                **114 s** |
| same build, after                                 |     **1** |                  **5 s** |
| 2,000 new `.o` files in 20 bursts, before → after |     6 → 0 |            8.6 s → 0.2 s |
| one edit to `kernel/fork.c`, before → after       |     1 → 1 | ~1 s, announced in 0.4 s |

Idle CPU is 0.4% (the 100 ms metadata poll).

## What was slow, and what changed

1. **The watcher refreshed on every build artifact (fixed).** It filtered events against the ignored
   paths that existed when it last ran `git ls-files --ignored`, so each _new_ `.o`, `.cmd` or
   archiver temp file restarted a full refresh (stat 96k files, list untracked, re-list ignored,
   broadcast, and the client re-fetches a 4 MB snapshot). During a kernel build diffle kept 1.4 cores
   busy. Now the watcher reports which paths settled (`Dirty::Paths`), and the session refreshes only
   if one of them is in the review's tree, or is neither matched by an ignore rule nor gone. A tracked
   file stays reviewable whatever the rules say, and a new directory still refreshes so files written
   into it before its watch registers are not missed. `git check-ignore` runs with `--no-index`:
   without it git scans the whole index per path (1.9 ms per path here, 0.6 s for 300 paths, against
   6 ms for 3,000 with it).
2. **`isCollapsed` scanned every changed file (fixed).** It found the file with
   `snapshot.changed.find`, and the review pane calls it per file on every store commit: O(n²) per
   commit, 78% of the client's CPU on the 31k-file review. The changed-file index and the tree order
   are now computed once per snapshot (`changedFile`, `orderedPaths` in `model.ts`).
3. **The client loads and hydrates every file up front (open).** Every changed file's patch is
   fetched in batches of ≤12 files, every modified file is hydrated with both full sides
   (`/api/file` twice), and each batch or hydration frame rebuilds all n items, which the viewer then
   reconciles (`reconcileItems`, `toItem`, `emptyFile` lead the profile after fix 2). That is still
   O(n²/12) work for one full load, and memory grows with the size of every changed file: 1.8 GB of
   heap after 10 minutes on 31k files. Loading and hydrating the files near the viewport (and
   dropping far-away contents), or committing loads in larger frames, would bound both.
4. **Snapshots of huge ranges are slow (open).** `git diff --numstat` itself takes 7.9 s for 31k files,
   and the generated-file sniff then pipes **760 MB** of blobs through `cat-file --batch` to keep
   4 KB of each (4.4 s), after numstat rather than beside it. Running the sniff concurrently
   (`--raw` alone takes 0.12 s and names the blobs) would save about a third; numstat could also come
   after the first paint.
5. **The snapshot carries the whole tree (open).** `/api/snapshot` is 4 MB for a clean Linux checkout
   and 22 MB for v6.0..v7.3, re-serialized for every fetch (140–850 ms) and re-fetched after every
   refresh. Sending the tree on its own route, or only when it changed, would make refreshes cheap.
6. **`GET /api/patch` without a path is unbounded (open, unused by the client).** For v7.0..v7.3 it
   builds a 193 MB string in 21 s at 622 MB RSS; for v6.0..v7.3 the response exceeded what Node
   could hold as one string.

Also fixed: `tsconfig.e2e.json` inherited the base `exclude`, so `test/e2e`, `scripts/screenshot.ts`
and `scripts/record-videos.ts` were never type-checked. They pass now that it is overridden.
