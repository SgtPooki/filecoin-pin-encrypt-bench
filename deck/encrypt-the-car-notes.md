# Speaker notes and sources: "Encrypt the CAR"

Deck: `encrypt-the-car.html` (16 slides, self-contained, validated with slide-deck-foc `validate.sh`, rendered in Chrome
with no overflow on any slide at 1600x900). Every figure comes from `bench/pkg/results/*.json` or `bench/REPORT.md`;
the cross-check script run on 2026-10-15 recomputed 29 figures from the JSON and all matched after reconciling the two
bundle seek rows (the deck now uses the runner's recorded values: tar uncached 725 requests / 90.1 MB / 2032 ms, CAR
2 requests / 330 KB / 21 ms).

| slide | claim | source |
|---|---|---|
| 1 | 30 round trips | gateway path: 17 runner rows + 2 manyfiles + 3 smoke (20 MiB) + 2 bundle smoke + 2 no-verify reruns = 26; verified-fetch: 3 + 1 rerun = 4; every one byte-identical (sha256, cmp, or diff -r) |
| 1 | 400 random reads | 17 runner rows x 20 seeks + extra seeks; REPORT "Random reads" (20/20 per row) |
| 1 | 5 hours of 4K video played | four full 16x playthroughs of the 74 min file (raw, tar, CAR per-leaf, CAR coalesced) = 296 min, plus 673 MB sessions; `results/browser-4g5*.log` |
| 3 | reviewers 3:1 for CAR | `scratchpad/peer/{claude,codex,gemini}.md` CAR, `cursor.md` tar |
| 5 | input sizes | `ls -l bench/inputs`, `bench/media`; chunk counts = ceil(size / 1 MiB) |
| 6 | 217 KB / 397 KB metadata, 508 nodes, list 38 ms | `results/video4g5-car.json` seek.metadataBytes; manyfiles encrypt meta.json (metadataBytes 397297, metadataBlocks 508); manyfiles decrypt listMs 38 |
| 7 | all encrypt numbers | `results/<input>-<fmt>.json` encrypt.totalMs / planMs / timeMaxRss; dedup envelopeBytes 108,039,944 vs 536,903,832 |
| 7 | 2119 / 1483 / 513 ms verify cost | one-off run on rand1g with BENCH_NOVERIFY, transcript 2026-10-14 (not in results JSON) |
| 8 | all decrypt numbers | `results/*.json` decrypt.totalMs / listMs / timeMaxRss; 2018 / 1351 ms verify cost from the same one-off run |
| 9 | seek table | `results/video4g5-*.json`, `results/rand5g-*.json` seek.* |
| 10 | directory seek table | `results/bundle-{car,tar}.json` seekSmall; `results/bundle-tar-seek-cached.json`; manyfiles rows from the transcript run (f6000: car 2 req / 560,099 B / 46 ms; tar 11,121 req / 1,477,216,873 B / 20,465 ms; cached `results/manyfiles-tar-seek-cached.json` 33 req / 8,651,280 B / 1380 ms) |
| 11 | browser table | `results/browser-4g5.log` (raw, car per-leaf, tar) and `results/browser-4g5-car-coalesced.log`; 673 MB rows from `results/browser-{raw,car,tar}-bbb_sunflower_2160p_60fps_normal.mp4.json` |
| 12 | bundle round trip, symlinks, perms | `results/bundle-{car,tar}.json` verify.diffLines (only the 3 symlinks), `ls -ld` in transcript (drwx------, -rw-------); fast-glob followSymbolicLinks default is a source claim, not run |
| 12 | +10% / +50% small-file overhead | manyfiles envelopes 6,769,892 (car) and 9,218,273 (tar) over 6,144,000 input |
| 14 | protons bug | `bench/FINDING-unixfs-uint64.md`, `bench/peer-protons/codex.md` and `bench/pkg/investigation/VERDICT.md`, filecoin-project/filecoin-pin#773 |
| 15 | profile | REPORT.md "Recommendation" rules 1 to 9 |
| 16 | not verified | REPORT.md "What was NOT verified" |

Assumptions and limits to say out loud:
- All timings are local SSD + loopback; network latency would add equally to every format per request, which is why
  request counts are shown next to bytes.
- Peak RSS for the bench's raw encrypt path is a harness artifact (1 MiB highWaterMark); the PR's own function peaks at
  271 MB on 4.5 GB. Not on a slide; in REPORT.md.
- `maxRssBytes` fields inside the seek/browser JSON are KiB (Node `resourceUsage`); the deck only uses `/usr/bin/time`
  bytes and Chrome `ps` RSS.
- The deck was not published anywhere (local file only).
