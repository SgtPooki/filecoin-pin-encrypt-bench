# filecoin-pin encrypted-upload payload benchmark

Which bytes should go inside the encryption envelope of `filecoin-pin add --encrypt`: raw file bytes, a tar, or a
UnixFS CAR? This repo holds the benchmark that answered it (2026-10-14/15), the prototype code, the raw results, the
slide deck, and the upstream bug it found along the way.

- **Report**: below (also the TL;DR right under it)
- **Deck**: [`deck/encrypt-the-car.html`](deck/encrypt-the-car.html), 17 slides, self-contained; speaker notes and
  per-figure sources in [`deck/encrypt-the-car-notes.md`](deck/encrypt-the-car-notes.md)
- **Bug found**: [`FINDING-unixfs-uint64.md`](FINDING-unixfs-uint64.md), tracked as
  [filecoin-project/filecoin-pin#773](https://github.com/filecoin-project/filecoin-pin/issues/773)
- **Code**: [`pkg/`](pkg) (`lib/` builders and readers, `bin/` runners, `web/` the Service Worker page,
  `results/` every number in the report as JSON)
- **Peer reviews** of the proposal before the bench, and of the bug after: [`reviews/`](reviews)
- **Outcome**: filecoin-project/filecoin-pin#771 and #772 ship the CAR profile

License: MIT.

---

# Encrypted-upload payload format for filecoin-pin: benchmark results and recommendation

Date: 2026-10-14. Machine: Apple Silicon macOS 27.0, 10 cores, 64 GiB RAM, local SSD. Node 24.18.0.
Everything below was measured at runtime unless marked **(source)**. Bench code: `pkg/` (see "Reproducing").

## TL;DR

**Pin a UnixFS CARv1 payload with a wrapping directory and metadata-first block order.** One format covers single
files, video, multi-GB binaries, directory bundles (incl. HAMT), and dedup-heavy data. Measured against raw bytes and
tar on the same inputs:

- Single-file streaming and seeking (incl. 4K video in Chrome through a decrypting Service Worker) are the **same** for
  all three formats: first frame 0.4 to 0.8 s, seek 30 to 340 ms, full 16x playthrough of a 4.5 GB file completes.
  Seeking inside a CAR needs no index: the reader fetches the metadata region once (298 KB for a 4.5 GB file, 560 KB for
  a 6000-file HAMT directory) and then computes every (file, offset) to a ciphertext range.
- Directories are where tar loses: reaching file 5560 of 6000 in a tar needs 5560 header reads (11,121 HTTP requests /
  1.48 GB uncached, 33 requests / 8.7 MB with a 64-entry chunk cache, 1.4 s). CAR: 2 requests, 560 KB, 46 ms for any file,
  and listing a 851 MB bundle takes 13 ms. Raw cannot encode a directory or a filename at all.
- Dedup: a 512 MiB file with 80 percent repeated 1 MiB blocks encrypts to 108 MB as a CAR, 537 MB as raw or tar.
- Cost of CAR: encrypt throughput 0.5 GB/s vs 1.6 to 2.0 GB/s (two passes over the input plus SHA-256 of every chunk),
  decrypt 0.5 GB/s vs 0.9 to 1.0 GB/s (per-leaf CID re-verification; dropping that gives 0.75 GB/s). No plaintext ever
  touches disk for any format, and memory stays flat (200 to 320 MB RSS) from 20 MiB to 5 GiB.
- The 4 GB benchmark also exposed an unrelated bug that breaks every `filecoin-pin add` of a 2 to 4 GiB file (not a
  payload-format issue): filecoin-project/filecoin-pin#773.

Do not ship raw now and switch later (all four earlier reviewers agreed, and the numbers show no reason to).

## Method

Three candidate payloads, each implemented end to end in `bench/pkg` (prototype code, not the PR branches):

| candidate | plaintext inside the FEE envelope | `content_type` |
|---|---|---|
| raw | the file bytes (current #771/#772) | unset |
| car | CARv1, root = anonymous UnixFS directory wrapping the input (file or directory, named by basename), `unixfs-v1-2025` profile, **metadata-first order** (all dag-pb nodes BFS from the root, then raw leaves in file order, each CID once) | `application/vnd.ipld.car` |
| tar | ustar/PAX (tar-stream 3.2.2), rooted at basename | `application/x-tar` |

Per (input, format): encrypt (PBKDF2-SHA256 600k + FEE chunked AES-256-GCM, 256 KiB chunks, same as #771) into a
0600 file in a private dir; pack the envelope as filecoin-pin does (`createCarFromPath` from the `feat/decrypt`
worktree dist) and `ipfs dag import` into a throwaway offline Kubo 0.43.1 (`npx kubo@latest`, `--profile server`,
`Routing.Type=none`); streaming decrypt from `http://127.0.0.1:8080/ipfs/<root>` in one pass; sha256 (or `diff -r`)
against the input; 20 random 64 KiB reads (incl. offset 0, tail-64K, last byte) via HTTP Range + `fee.decryptRange`,
each compared to the original bytes. Peak RSS from `/usr/bin/time -l`. Browser: a page + Service Worker (esbuild bundle
of the same reader code) answering `<video>` Range requests by `decryptRange` against the gateway, driven by Playwright
1.60 with Google Chrome (`channel: 'chrome'`, headless), measuring loadedmetadata, first frame (`requestVideoFrameCallback`),
seek latency at 10/50/90 percent, tail playback to `ended`, and a full 16x playthrough; Chrome RSS sampled every second.

Inputs: Big Buck Bunny 4K60 H.264 (673,223,862 B); the same concatenated 7x with AAC audio and `+faststart`
(4,541,818,176 B, 74 min); random 1 GiB (exactly 1024 chunks) and 5 GiB (intermediate dag-pb nodes); a 512 MiB file where
4 of every 5 MiB-blocks repeat; an 851 MB directory bundle (354 files: 300 small, 50 medium, a 200 MB binary, the 673 MB
video, an empty file, an empty dir, a 100+ byte Unicode filename, 3 symlinks incl. `/etc/passwd` and `../../../tmp`);
a 6000 x 1 KiB directory (HAMT-sharded under the profile).

### Why metadata-first order (and not DFS pre-order)

A CARv1 has no index. Readers that only know the root need every dag-pb node before they can map a file offset to a block.
With the DFS order from the earlier prototype, the offset of the k-th subtree depends on the serialized length of every
earlier intermediate node, so seeking into a >1024-chunk file or into file N of a directory costs one extra read per
preceding node. Putting all dag-pb nodes first makes the metadata one contiguous prefix: a reader streams from offset 0
until the DAG closes (every referenced dag-pb CID seen), cancels, and from then on every raw leaf's CAR offset is
`sum(section lengths)` over the known leaf sequence, with `Tsize` giving each raw leaf's length. Streaming unpack is the
same loop: metadata, then leaves in the order the tree dictates; a leaf that is referenced twice arrives once and is
written to every target. Memory is bounded by the metadata (217 KB for 4.5 GB; 397 KB for 6000 files).

Kubo accepts the output as ordinary UnixFS (`dag import`, `ls`, gateway fetches of nested files are byte-identical), so
any IPFS tool can read the plaintext CAR; only seek-without-index needs the ordering.

## Results

### Encrypt side (no plaintext temp file for any format)

| input | fmt | input MB | envelope MB | overhead | plan/pass 1 ms | encrypt ms | total ms | GB/s | peak RSS MB |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| video673 | car | 673 | 673 | 0.01% | 491 | 771 | 1351 | 0.50 | 196 |
| video673 | raw | 673 | 673 | 0.01% | 0 | 334 | 423 | 1.59 | 240 |
| video673 | tar | 673 | 673 | 0.01% | 1 | 317 | 406 | 1.66 | 212 |
| video4g5 | car | 4542 | 4542 | 0.01% | 3203 | 5159 | 8450 | 0.54 | 289 |
| video4g5 | raw | 4542 | 4542 | 0.01% | 0 | 2638 | 2725 | 1.67 | 1406 * |
| video4g5 | tar | 4542 | 4542 | 0.01% | 1 | 2139 | 2229 | 2.04 | 338 |
| rand1g | car | 1074 | 1074 | 0.01% | 768 | 1228 | 2084 | 0.52 | 215 |
| rand1g | raw | 1074 | 1074 | 0.01% | 0 | 515 | 603 | 1.78 | 304 |
| rand1g | tar | 1074 | 1074 | 0.01% | 1 | 479 | 568 | 1.89 | 263 |
| rand5g | car | 5369 | 5369 | 0.01% | 3825 | 6325 | 10239 | 0.52 | 299 |
| rand5g | raw | 5369 | 5369 | 0.01% | 0 | 3056 | 3145 | 1.71 | 904 * |
| rand5g | tar | 5369 | 5369 | 0.01% | 1 | 2672 | 2761 | 1.94 | 246 |
| dedup512m | car | 537 | 108 | -79.9% | 390 | 147 | 626 | 0.86 | 186 |
| dedup512m | raw | 537 | 537 | 0.01% | 0 | 306 | 394 | 1.36 | 289 |
| dedup512m | tar | 537 | 537 | 0.01% | 1 | 263 | 351 | 1.53 | 211 |
| bundle | car | 882 | 882 | 0.02% | 653 | 1047 | 1788 | 0.49 | 315 |
| bundle | tar | 882 | 882 | 0.04% | 10 | 469 | 567 | 1.56 | 247 |
| manyfiles (6000 x 1 KiB) | car | 6.1 | 6.8 | +10% (HAMT + per-file nodes) | 1198 | 557 | 1845 | | 281 |
| manyfiles | tar | 6.1 | 9.2 | +50% (512 B header + pad to 512 B per file) | | | | | |

`*` harness artifact: the bench's raw path reads with a 1 MiB `highWaterMark` through `Readable.toWeb`, which buffers.
The PR's own `encryptFileWithPassword` (default 64 KiB) peaks at 169 MB on 1 GiB and 271 MB on 4.5 GB (measured with the
worktree dist), so the PR is fine; the bench raw RSS column is not a format property.

"plan/pass 1" for CAR is `ipfs-unixfs-importer` hashing the input to build the DAG (only dag-pb nodes kept; raw leaf
bytes discarded). Pass 2 re-reads each leaf at its known offset, re-hashes it to catch a file changing between passes,
and emits it. With re-hashing off, 1 GiB total drops from 2119 to 1483 ms (raw: 513 ms); the remaining gap is pass 1.
Peak temp disk = envelope + outer CAR (2x envelope) for every format; nothing else is written. Envelope size overhead
over the input is identical for all three (FEE: 16 B tag per 256 KiB chunk ~ 0.006 percent, plus ~3 KB header).

### Streaming decrypt from the gateway (single pass)

| input | fmt | decrypt ms | GB/s | first plaintext ms | list ms | peak RSS MB | bytes match |
|---|---|---:|---:|---:|---:|---:|---|
| video673 | car | 1304 | 0.52 | 127 | 12 | 234 | yes |
| video673 | raw | 788 | 0.85 | 119 | | 211 | yes |
| video673 | tar | 784 | 0.86 | 118 | 120 | 215 | yes |
| video4g5 | car | 9814 | 0.46 | 122 | 30 | 304 | yes |
| video4g5 | raw | 4338 | 1.05 | 117 | | 231 | yes |
| video4g5 | tar | 4503 | 1.01 | 118 | 119 | 245 | yes |
| rand1g | car | 2067 | 0.52 | 117 | 12 | 240 | yes |
| rand1g | raw | 1175 | 0.91 | 118 | | 215 | yes |
| rand1g | tar | 1146 | 0.94 | 119 | 120 | 217 | yes |
| rand5g | car | 10300 | 0.52 | 118 | 33 | 294 | yes |
| rand5g | raw | 5556 | 0.97 | 119 | | 249 | yes |
| rand5g | tar | 5131 | 1.05 | 117 | 119 | 239 | yes |
| dedup512m | car | 463 | 1.16 | 119 | 8 | 200 | yes |
| dedup512m | raw | 659 | 0.81 | 117 | | 215 | yes |
| dedup512m | tar | 678 | 0.79 | 118 | 120 | 220 | yes |
| bundle | car | 1705 | 0.52 | 118 | 12 | 237 | yes (diff -r; only the 3 skipped symlinks differ) |
| bundle | tar | 1074 | 0.82 | 117 | 120 | 226 | yes (same) |
| manyfiles | car | 1326 | | 101 | 38 | 192 | yes (diff -r) |
| manyfiles | tar | 1001 | | 100 | | 236 | yes (diff -r) |

"list ms" = time until the full file list (names + sizes) is known. CAR: after the metadata prefix. Tar: at the first
header, but the list is only complete at EOF (entries are discovered as they stream past). The ~118 ms before the first
plaintext byte is the PBKDF2 derivation (600k iterations), same for all formats.

CAR decrypt re-hashes every leaf against its CID. That is redundant with the FEE tag (which already authenticates
every byte) and costs about a third: 1 GiB CAR decrypt 2018 ms with verification, 1351 ms without (raw 1175 ms). The
profile can leave verification optional for application readers; generic IPFS tools will verify anyway.

Memory is flat across sizes for every format (CAR 200 to 304 MB from 20 MiB to 5 GiB), so decrypt is single-pass with
bounded memory. The ~200 MB floor is Node + undici fetch buffering, not the formats.

Through `@helia/verified-fetch` 8.1.2 against the same Kubo (trustless gateway, `allowLocal: true, allowInsecure: true`;
without those flags local http gateways are silently dropped and the fetch hangs or 502s): 673 MB decrypts correctly for
all three formats (car 3.6 s warm / 26 s cold, raw 50 s cold, tar also correct), but verified-fetch's default in-memory
blockstore held the whole 673 MB envelope: 2.26 GB RSS. A browser viewer that goes through verified-fetch needs a
non-memory blockstore (or plain Range fetches of the envelope as the Service Worker here does).

### Random reads: 20 x 64 KiB via HTTP Range + `decryptRange`

| input | fmt | prep requests | prep KB | TTFB median ms | TTFB max ms | avg KB fetched/seek | correct |
|---|---|---:|---:|---:|---:|---:|---|
| video673 | car | 2 | 298 | 7 | 9 | 319 | 20/20 |
| video673 | raw | 0 | 0 | 7 | 10 | 295 | 20/20 |
| video673 | tar | 3 | 268 | 7 | 8 | 295 | 20/20 |
| video4g5 (4332 chunks, 5 intermediate nodes) | car | 2 | 298 | 9 | 15 | 308 | 20/20 |
| video4g5 | raw | 0 | 0 | 8 | 11 | 309 | 20/20 |
| video4g5 | tar | 3 | 268 | 7 | 11 | 309 | 20/20 |
| rand1g | car | 2 | 298 | 8 | 10 | 287 | 20/20 |
| rand1g | raw | 0 | 0 | 7 | 27 | 318 | 20/20 |
| rand1g | tar | 3 | 268 | 7 | 8 | 305 | 20/20 |
| rand5g (5120 chunks) | car | 2 | 298 | 7 | 13 | 324 | 20/20 |
| rand5g | raw | 0 | 0 | 7 | 11 | 318 | 20/20 |
| rand5g | tar | 3 | 268 | 7 | 11 | 305 | 20/20 |
| dedup512m | car | 2 | 298 | 5 | 8 | 305 | 20/20 |
| dedup512m | raw | 0 | 0 | 5 | 10 | 265 | 20/20 |
| dedup512m | tar | 3 | 268 | 5 | 7 | 253 | 20/20 |
| bundle, assets/video.mp4 | car | 2 | 298 | 7 | 11 | 344 | 20/20 |
| bundle, assets/video.mp4 (entry 8) | tar | 17 | 2127 | 6 | 8 | 318 | 20/20 |

Per-seek cost is one FEE chunk (256 KiB) plus the tag, same for every format: `decryptRange` fetches chunk-aligned
ciphertext. The CAR number is slightly higher when a 64 KiB read straddles a 1 MiB leaf boundary (two chunk fetches).
"prep" is what a reader must fetch before the first seek: raw nothing, tar the first header(s), CAR the metadata prefix
(one open-ended `decryptRange` from 0, cancelled once the DAG closes; the 298 KB is one FEE chunk because that is the
fetch granularity, the metadata itself is 1.2 KB for a single <1 GiB file, 217 KB for 4.5 GB).

**Seeking into a directory** (the case that decides the format):

| target | fmt | header/node reads | HTTP requests | bytes fetched | prep ms |
|---|---|---:|---:|---:|---:|
| bundle `docs/small_99.txt` (entry 360 of 354 files + dirs) | car | 0 extra | 2 | 330 KB | 21 |
| same | tar, no cache | 362 | 725 | 90.1 MB | 2032 |
| same | tar, 64-entry chunk cache | 362 | 35 | 9.1 MB | 268 |
| manyfiles `f6000.bin` (entry 5560 of 6000, HAMT dir) | car | 0 extra | 2 | 560 KB | 46 |
| same | tar, no cache | 5560 | 11121 | 1.48 GB | 20465 |
| same | tar, 64-entry chunk cache | 5560 | 33 | 8.7 MB | 1380 |
| manyfiles `f1.bin` (entry 2) | car | 0 extra | 2 | 560 KB | 45 |
| same | tar | 2 | 5 | 536 KB | 14 |

Tar seeking is O(entries before the target) because the only way to find entry N is to read headers 1..N-1 (each
header read is a full 256 KiB FEE chunk fetch unless cached). An external index would fix it, but then the index is the
manifest that the CAR already is. CAR's metadata prefix is the index.

### Browser: Chrome + decrypting Service Worker

673 MB 4K60 video, single file:

| fmt | loadedmetadata ms | first frame ms | seek 10% ms | seek 50% ms | seek 90% ms | tail -> `ended` | SW prep | bytes fetched for the session | Chrome RSS peak |
|---|---:|---:|---:|---:|---:|---|---|---:|---:|
| raw | 335 | 781 | 274 | 61 | 129 | yes | 2 req / 8 KB | 55 MB (24 req) | 1.44 GB |
| car | 105 | 394 | 282 | 70 | 130 | yes | 3 req / 276 KB (metadata 32 KB) | 75 MB (129 req, per-leaf reader) | 1.35 GB |
| tar | 122 | 440 | 287 | 62 | 128 | yes | 4 req / 274 KB | 54 MB (28 req) | 1.54 GB |

4.5 GB, 74 min video, plus full playthrough at 16x (`ended` fired at 4441.97 s for all three):

| fmt | loadedmetadata ms | first frame ms | seek 10/50/90 ms | tail -> `ended` | full 16x wall s | bytes fetched | HTTP requests | Chrome RSS peak |
|---|---:|---:|---|---|---:|---:|---:|---:|
| raw | 146 | 459 | 327 / 77 / 29 | yes | 385 | 4.60 GB | 28 | 1.85 GB |
| car, per-leaf reader | 163 | 427 | 338 / 61 / 34 | yes | 491 | 5.77 GB | 8789 | 1.97 GB |
| car, coalesced-span reader | 140 | 391 | 331 / 73 / 36 | yes | 384 | 4.60 GB | 29 | 1.84 GB |
| tar | 257 | 811 | 344 / 77 / 34 | yes | 499 | 4.60 GB | 28 | 1.95 GB |

Chrome RSS is dominated by 4K decode (all three within 10 percent); page JS heap stayed under 2 MB. The per-leaf CAR
reader issued one `decryptRange` per 1 MiB leaf, so each open-ended `<video>` Range request became thousands of HTTP
requests and refetched the FEE chunk shared by adjacent leaves (+25 percent bytes). The coalesced reader (one
`decryptRange` over the whole span of adjacent leaves, stripping the 40-byte CAR framing between them on the fly) was
verified correct for multi-leaf reads and across dedup gaps (where a repeated leaf lives elsewhere in the CAR and must
start a new span); with it the CAR session is indistinguishable from raw: 29 vs 28 requests, 4.60 GB both, 384 vs 385 s.

Playback uses the browser's own MP4 demuxer: the Service Worker answers byte ranges, nothing format-specific, so any
media type Chrome can play from a URL plays here (`+faststart` matters for MP4 as it does for any HTTP source).

### Directory semantics and safety (runtime, both CAR and tar)

- Round trip of the bundle is byte-identical for every regular file, incl. the empty file, the empty directory, and the
  100+ byte Unicode name (`Résumé – 履歴書 – 🚀 ...txt`, PAX record in tar, plain link name in UnixFS; `ipfs ls` shows it).
- Symlinks are skipped at pack time by policy (`lstat`, reported: 3 skipped). This matters: `@helia/unixfs` `globSource`
  as used by `createCarFromDirectory` follows symlinks, so today `add dir/` would ingest `/etc/passwd` through
  `evil_abs_link` **(source: fast-glob `followSymbolicLinks` default; not run through the PR)**.
- Unpack writes dirs 0700 and files 0600 (`wx`, so an existing file aborts), rejects names containing `/`, `..`, `.`, empty
  or NUL (UnixFS link names) and absolute or `..` paths (tar), skips tar symlink/hardlink entries, and for CAR refuses
  UnixFS `symlink` nodes, inline file data, unknown codecs, dag-pb after data began, and leaves out of order.
- HAMT: 6000 entries produce a sharded directory (508 dag-pb nodes, 397 KB metadata); list 38 ms, full unpack 1.3 s,
  seek to any entry 2 requests.

## Pros and cons per format and media type

| | raw (current) | tar | UnixFS CAR, wrapped, metadata-first |
|---|---|---|---|
| single file: stream decrypt | 1.0 GB/s | 1.0 GB/s | 0.5 GB/s (0.75 without CID re-check) |
| single file: seek / video playback | identical | identical (one 512 B header read) | identical (one metadata read) |
| filename survives | no (lost forever) | yes | yes |
| directories | no | yes, sequential only | yes, random access, HAMT |
| seek into file N of a bundle | n/a | O(N) header reads (90 MB / 2.0 s for entry 360 uncached) | O(1): 2 requests |
| list a bundle | n/a | only at EOF (streams past every byte) | 13 ms after the metadata prefix |
| dedup / repeated content | none | none | 5x smaller on the dedup input |
| encrypt throughput | 1.7 GB/s | 1.9 GB/s | 0.5 GB/s (2 passes + hashing) |
| plaintext on disk | none | none | none (two-pass build) |
| plaintext CIDs | none | none | yes: a generic FEE decryptor yields a CAR any IPFS tool can open, `ipfs ls`, verify |
| size overhead | ~0 | 512 B/entry + padding (50 percent on 1 KiB files) | ~40 B/MiB + ~100 B/entry (10 percent on 1 KiB files incl. HAMT) |
| ecosystem | none | `tar -x` | IPFS-native; the existing unencrypted viewer path renders the same UnixFS root |
| spec surface to pin | content only | ustar vs PAX, symlink/hardlink policy, path jail | profile, ordering, wrapper, HAMT, path jail |
| disqualifier | no names, no dirs | directory random access | none found; the cost is CPU on the add side |

Media-type check: video (MP4 faststart) plays and seeks identically in all three; large binaries seek identically;
small text/HTML/MD are a single raw leaf in the CAR (file CID = leaf CID, one block); image galleries and static sites
are directories (CAR or tar only); dedup-heavy data (VM images, logs) favours CAR; nothing favoured raw over CAR except
add-side CPU.

## Recommendation: the payload profile to pin

1. **Container**: CARv1, exactly one root, `content_type` = `application/vnd.ipld.car`. Decryptors reject any other
   content type (raw/tar envelopes never existed, so no sniffing path). A future change gets a new content type.
2. **Root**: an anonymous UnixFS directory (basic or HAMT) with exactly one child named `basename(input)`: a file, or the
   directory the user passed (so `add dir/` keeps the directory's name, which it loses today). CAR input files are
   just files inside the wrapper (the `--encrypt` CAR-input special case in 7c285ed becomes moot).
3. **DAG profile**: `unixfs-v1-2025` (1 MiB chunks, raw leaves, CIDv1, 1024-wide, block-bytes HAMT), the one the repo
   already pins, so inner CIDs equal what an unencrypted `add` would produce.
4. **Block order**: every dag-pb node first (BFS from the root, each once), then raw leaves in DFS/file order, each CID
   once (first occurrence). Readers MUST tolerate and MAY exploit it: a reader that sees a raw block before the DAG is
   closed, or a dag-pb block after data began, rejects the envelope. Generic IPFS tools do not care about order.
5. **`appMetadata`**: unchanged (`kdf`, `iterations`, `salt`). No payload marker: `content_type` is the marker and is
   authenticated. Nothing about the plaintext (root CID, names, sizes) goes in the public header.
6. **Encrypt side**: two passes over the input, no plaintext temp file: pass 1 builds the DAG in memory (dag-pb nodes
   only), pass 2 re-reads leaves at known offsets, re-hashes each (abort on mismatch: input changed), streams straight
   into `fee.encrypt({ contentLength })`. Symlinks skipped and reported, hidden files per the existing `add` rule.
7. **`decrypt <file> <outDir>`**: creates `<outDir>` (0700, must not exist), writes the wrapper's children into it (files
   0600), single pass, path-jailed as above; removes `<outDir>` on failure. No single-file special case: a file input
   decrypts to `<outDir>/<name>`. Optional `--no-verify` style flag is not needed: default to verifying leaf CIDs (cost
   above) since the CLI is not the hot path.
8. **Viewer rules**: fetch the envelope by Range (gateway or verified-fetch with a non-memory blockstore), read the
   metadata prefix once, then serve files by byte range with one `decryptRange` per contiguous span; one child that is a
   file renders directly, otherwise list the directory. Never buffer the plaintext CAR.
9. **Piece metadata**: `name` stays `encrypted.fee`; the outer object is a single file without a wrapper (unchanged).

## Performance follow-up (2026-10-15): closing the CAR gap without touching the container

All on the 4.5 GB video, same inputs and roots as above (CID parity checked: the parallel hasher produces the same
root for the 20 MiB file and the 851 MB bundle). Numbers are single runs; run-to-run noise is about +-5 percent.

### Encrypt: 0.53 -> 1.04 GB/s

| variant | pass 1 ms | pass 2 ms | total ms | GB/s |
|---|---:|---:|---:|---:|
| baseline: importer hashes on one thread, pass 2 re-hashes every chunk | 3253 | 5217 | 8561 | 0.53 |
| parallel hash (`crypto.subtle.digest`, 8 in flight) + re-hash | 1394 | 5387 | 6868 | 0.66 |
| parallel hash + size/mtimeNs check before and after instead of re-hash | 1375 | 2897 | 4360 | **1.04** |
| same, 16 in flight | 1250 | 3052 | 4391 | 1.03 |
| raw reference | | | 2412 | 1.88 |

- Node runs WebCrypto digests on the libuv threadpool, so a `bufferImporter` that hashes with `crypto.subtle.digest`
  turns the importer's existing `blockWriteConcurrency` into real parallelism: 3.3 GB/s for pass 1 against 1.78 GB/s
  for single-thread `createHash` (measured ceilings: 1.78 GB/s single thread, 4.29 GB/s at 8 in flight).
- Re-hashing in pass 2 existed only to catch the input changing between passes. A `stat` (size + mtimeNs) before
  pass 1 and after pass 2 catches the same thing the way `tar` does ("file changed as we read it") and costs nothing.
  Pass 2 is then raw FEE encrypt plus CAR framing: 2897 vs 2412 ms.
- Remaining gap to raw is pass 1 (1.4 s), which is the CID computation itself. It cannot overlap pass 2 because the
  root must be emitted first.

### Decrypt: 0.53 -> 0.67 to 0.78 GB/s, and where the rest is

| variant | total ms | GB/s |
|---|---:|---:|
| baseline: `@ipld/car` iterator, sync SHA-256 per leaf | 8522 | 0.53 |
| async verification (digest on the threadpool, 8 in flight, writes continue) | 7257 | 0.63 |
| no verification (FEE tag is the integrity check) | 6307 to 6748 | 0.67 to 0.72 |
| no verification, writes disabled | 5005 to 5793 | 0.78 to 0.91 |
| zero-copy streaming unpacker (pieces written at offsets, no leaf assembly), no verification | 5806 to 6748 | 0.67 to 0.78 |
| raw reference | 4816 to 5132 | 0.88 to 0.94 |
| fetch + FEE decrypt only, no parsing, no writes (either object) | 4179 to 4258 | 1.07 to 1.09 |
| fetch only (either object) | 1867 to 1918 | 2.4 |

- The per-leaf hash is a third of the baseline. FEE already authenticates every byte, so an application unpacker
  can skip it or run it asynchronously; generic IPFS tools will verify anyway.
- Replacing `@ipld/car`'s iterator with a one-allocation reader or a zero-copy streaming parser did not move the
  number; the CAR-specific overhead with verification off is about 1 s of parse loop and positioned writes
  (positioned `FileHandle.write` measured at 2.3 to 2.8 GB/s vs 3.4 GB/s sequential).
- The real ceiling is FEE's own decrypt stream at 1.07 GB/s, identical for raw and CAR. It is not the cipher:
  `crypto.subtle.decrypt` of 256 KiB AES-256-GCM chunks runs at 2.95 GB/s sequentially and 6.65 GB/s with 8 in
  flight on this machine, and the gateway delivers 2.4 GB/s. FEE awaits one `subtle.decrypt` per chunk inside its
  TransformStream (`src/internal/web-crypto.ts:79`); pipelining chunk decrypts upstream would lift every format.
  Same on the encrypt side (1.88 GB/s raw vs 2.95 GB/s cipher ceiling).

### Does it translate to the browser? (Chrome, bulk fetch + decrypt in the page, no Service Worker)

| object | parse CAR sections | ms | GB/s | JS heap peak MB | Chrome RSS peak MB (idle baseline 939) |
|---|---|---:|---:|---:|---:|
| raw 673 MB | | 730 | 0.92 | 322 | 1402 |
| CAR 673 MB | yes | 897 | 0.75 | 110 | 1496 |
| raw 4.5 GB | | 3145 | 1.44 | 124 | 1659 |
| CAR 4.5 GB | yes | 4360 | 1.04 | 190 | 1933 |

- Encrypt-side gains are CLI-only. The Service Worker never verified leaves, so the decrypt-verification gain does
  not apply there either; seeking was already at parity. Bulk decrypt in Chrome runs at 1.0 to 1.4 GB/s, faster than
  Node's FEE stream (1.07), with the CAR section parser (an incremental counter with a copy per partial section)
  costing 20 to 30 percent; a viewer that strips framing while streaming to a download would pay about that.
- Memory stays bounded: JS heap peaks between 110 and 322 MB on a 4.5 GB stream. Process RSS is sampled over every
  Chrome helper on the machine (it includes the user's own Chrome), so read it as a delta over the 939 MB idle sample:
  +0.5 to +1.0 GB during a multi-GB decrypt, mostly network and GC headroom, not retained data.

### What to carry into #771/#772

1. Hash pass 1 with `crypto.subtle.digest` through a custom `bufferImporter` (keeps CIDs identical).
2. Guard pass 2 with before/after `stat` instead of re-hashing.
3. Make leaf verification in `decrypt` optional or async; default can stay on for the CLI.
4. File an upstream FEE issue about pipelining chunk decrypt/encrypt (not blocking: it helps raw and CAR equally).
None of these change the envelope, the CAR bytes, or the CIDs.

## Other findings

- **protons-runtime uint64 bug (#773)**: files between 2 GiB and 4 GiB get a UnixFS root Kubo rejects
  (`proto: cannot parse invalid wire-format data`). Found when the 3.9 GB video failed for all three formats at the
  outer-CAR stage; reproduced with the worktree's own `ipfs-unixfs` 12.0.2 and independently by Codex (gpt-6-astra).
  Details: `FINDING-unixfs-uint64.md`. The bench used a 4.5 GB video (above 2^32) to proceed.
- `createCarFromPath` writes its CAR to the shared tmpdir with mode 0644 (seen: `/var/folders/.../T/filecoin-pin-add-*.car`,
  `-rw-r--r--`). Fine for the ciphertext envelope; it is why the inner CAR must not be built with that helper.
- verified-fetch needs `allowLocal`/`allowInsecure` for a local http gateway and buffers blocks in memory by default.
- `globSource` follows symlinks **(source)**; the encrypted path should not, and probably neither should `add`.

## What was NOT verified

- No real upload to an SP or FOC contract; the outer object was produced by the PR's packer and served by Kubo.
- Browser tests ran in headless Chrome on macOS only; no Safari/Firefox, no mobile memory limits.
- Codex ran its Kubo checks against its own offline repo (it could not reach the bench daemon from its sandbox).
- One verified-fetch CAR run produced a wrong sha256 while overlapping with a killed earlier process; the rerun was
  byte-identical (`cmp`), as were all 26 gateway-path round trips. Flagging it rather than hiding it.

## Reproducing

```
cd pkg && pnpm install
# inputs (not in the repo): media/bbb_sunflower_2160p_60fps_normal.mp4 from
# https://download.blender.org/demo/movies/BBB/bbb_sunflower_2160p_60fps_normal.mp4.zip, then see
# inputs/README.md for the ffmpeg concat, /dev/urandom, dedup, bundle and manyfiles recipes.
export IPFS_PATH=$PWD/../ipfs; npx kubo@latest init --profile server
npx kubo@latest config Routing.Type none; npx kubo@latest daemon --offline &
export PIN_WORKTREE=/path/to/filecoin-pin-checkout   # built, feat/decrypt or later; its dist/ packs the outer CAR
node bin/run.mjs video673,bundle,rand1g,video4g5,rand5g,dedup512m   # results/<input>-<fmt>.json
node bin/report-table.mjs                                            # markdown tables
node bin/browser.mjs car <outerRoot> bbb_4g5.mp4 --full              # Google Chrome via Playwright
```

`pkg/dbg/` holds one-off probes from the investigation (absolute paths from the original machine; kept for the record).
`pkg/investigation/` is the independent Codex verification of the protons-runtime bug (`VERDICT.md`).
Bench sources: `lib/car-layout.mjs` (layout math, pure), `lib/car-payload.mjs` (two-pass builder), `lib/car-unpack.mjs`,
`lib/car-seek.mjs` (metadata prefix + coalesced spans), `lib/tar-payload.mjs`, `lib/http-source.mjs` (FEE
`RandomAccessSource` over Range), `web/sw-src.mjs` (Service Worker), `bin/*`. Results JSON in `results/`.
