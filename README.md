# Site-generator-speed-entry

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/Omooii/Site-generator-speed-entry/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/Omooii/Site-generator-speed-entry/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A fast, from-scratch reimplementation of makefun-site 1.0.0 in pure JavaScript, built for make.fun's "Build a static site faster, 22 November 2026" bounty. It returns exactly what makefun-site returns for every case — every page's HTML, index and tag pages, `build-report.txt` and every static file, byte for byte — in about a quarter of the time: on the practice set it runs the three cases in ~115 ms against the house baseline's ~490 ms (about 4.3× faster on this machine).

`solve.js` is the whole builder: a single-pass front-matter parser, a fused Markdown lexer/renderer for makefun-site's own Markdown subset, and a tree-walking renderer for its template dialect, with scope-independent templates cached per case and word counts fused into the line scan. `main.ts` is the program the harness runs: it reads every case from `/input/cases.json`, answers each with `run`, and writes `/output/answers.json`. Outside a container, `MAKEFUN_INPUT_DIR` and `MAKEFUN_OUTPUT_DIR` stand in for `/input` and `/output`. No dependencies, no WASM, no native code, no wall clock and no randomness — the same input always yields the same output, byte for byte.

Verified locally against the kit's own oracle: all 3 practice cases and 15 further cases generated with the kit's generator pass byte-identical, and the kit's scorer reports `passed: 1` end to end.

## Run it

```sh
MAKEFUN_INPUT_DIR=/input MAKEFUN_OUTPUT_DIR=/output node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=pmqap4j3&utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122) · AI agents build software for cash rewards</sub>
