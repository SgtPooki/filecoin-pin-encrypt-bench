You are investigating a suspected data-corruption bug in the JS IPFS UnixFS stack. Be skeptical of the claim; your job is to establish exactly what is true, since when, and what filecoin-pin should do about it. Work in a throwaway directory you create under /tmp. Do not modify any other repo, do not push, do not open issues or comments; write your findings to a markdown file and print its path at the end. Use Node 24 (`export PATH=~/.nvm/versions/node/v24.18.0/bin:$PATH`).

## The claim

`ipfs-unixfs` (the UnixFS protobuf codec used by `ipfs-unixfs-importer` and `@helia/unixfs`) mis-encodes any uint64 in [2^31, 2^32). The mechanism is said to be in its dependency `protons-runtime`: `LongBits` (`src/utils/longbits.ts`) stores the low 32-bit word as `this.lo = lo | 0` (signed), so for values in that window `lo` is negative; `Writer.uint64` reserves `length()` = 5 bytes, but `writeVarint64` loops `while (val.hi !== 0)` (false) then `while (val.lo > 127)` (false for a negative), writes a single byte, and leaves 4 bytes of the `allocUnsafe` slab untouched. Consequence: any UnixFS file node whose `filesize` or any `blocksizes` entry is in that window is corrupt; under the `unixfs-v1-2025` profile (1 MiB leaves, 1024-wide) that is every single file of 2 GiB <= size < 4 GiB. Kubo rejects such roots with `proto: cannot parse invalid wire-format data`. Reported reproduction:

```sh
# bad: 0802180000000000200000000000, expected 0802188080808008208080808008
node --zero-fill-buffers --input-type=module -e 'import {UnixFS} from "ipfs-unixfs"; console.log(Buffer.from(new UnixFS({type:"file",blockSizes:[2147483648n]}).marshal()).toString("hex"))'
```
(`--zero-fill-buffers` only makes the 4 unwritten bytes deterministic; without it they contain pool garbage. Verify that claim too: fill the slab with a known pattern and see whether it shows through.)

## Part 1: confirm or refute, precisely

1. Reproduce with the latest published `ipfs-unixfs` and `protons-runtime` from npm, with and without `--zero-fill-buffers`. Decode the bytes with an independent protobuf reader (hand-written varint parser or `protobufjs`), not protons.
2. Write the same message with an independent encoder (`protobufjs` with the UnixFS `.proto`, or Go via Kubo `ipfs dag put` of a hand-built dag-pb node) and diff.
3. Establish the exact failing window for uint64 (test 2^31-1, 2^31, 2^32-1, 2^32, 2^53-1, 2^63, 2^64-1 and random samples), and whether `int64`, `sint64`, `fixed64` share the defect.
4. Confirm or refute the mechanism by reading `protons-runtime/dist/src/utils/{longbits,writer}.js`. State whether the `uint64 -> fromBigInt -> fromNumber` path is taken for safe integers.

## Part 2: git bisect, how long has this existed

5. Clone https://github.com/ipfs/protons. Build `packages/protons-runtime` at HEAD and confirm the behaviour against the repo build, not the npm tarball. Then `git bisect` across the history of `packages/protons-runtime` with a script that encodes `2147483648n` via `uint64` and fails when the output is not `8080808008`. Suspected introduction: commit d1018046 (2023-10-13, "fix: port protobuf reader/writer to ts (#60)"). Report the first bad commit, its date, and the first npm release containing it (`npm view protons-runtime time --json`).
6. Before that commit protons-runtime wrapped `protobufjs/minimal`. Check whether that older path (and therefore `ipfs-unixfs` releases that depended on it) was correct: install the oldest `ipfs-unixfs` major that still resolves (e.g. 6.x, 8.x, 10.x, 11.x) and run the marshal test on each. Produce a table: ipfs-unixfs version -> protons-runtime version -> correct or broken.
7. Search `ipfs/protons`, `ipfs/js-ipfs-unixfs`, `ipfs/helia` issues and PRs (open and closed) for prior reports: "wire-format", "2GB", "2 GiB", "uint64", "LongBits", "filesize". Report what you find or that nothing exists.
8. Explain why this could go unnoticed for the time it has existed. Check who actually uses `ipfs-unixfs` for multi-GB files versus `@ipld/unixfs` (the separate encoder used by w3up / web3.storage). Verify, do not guess: look at the dependency trees of `@web3-storage/w3up-client`, `@helia/unixfs`, `ipfs-car`, `kubo-rpc-client`.

## Part 3: what filecoin-pin should do

filecoin-pin (`/Users/sgtpooki/code/work/filoz/filecoin-project/filecoin-pin`, read-only for you) packs uploads with `@helia/unixfs` `addByteStream`/`addAll` under `importerOptions = { profile: 'unixfs-v1-2025' }` (`src/core/unixfs/importer-options.ts`, `car-builder.ts`). Every `add` of a 2 to 4 GiB file is affected if the claim holds.

9. Option A, upstream fix: write the one-line patch (`lo >>> 0`, or normalise in `fromNumber`) against the protons repo, add a regression test, run the package's test suite, and report whether the fix changes any other encoding (run the differential test from Part 1 before and after). Report how filecoin-pin could consume it (pnpm `overrides`/`patchedDependencies` until a release ships).
10. Option B, switch the importer to `@ipld/unixfs`: assess feasibility. Does `@ipld/unixfs` offer the same `unixfs-v1-2025` behaviour (1 MiB fixed chunks, raw leaves, CIDv1, 1024-wide balanced layout, HAMT at 256 KiB block-bytes)? Build the same 2.5 GiB and 5 GiB inputs with both and compare root CIDs; CID parity with Kubo under the same profile matters because filecoin-pin promises reproducible CIDs. Estimate the change to `car-builder.ts` and what else depends on `@helia/unixfs` in the repo. Check whether `@ipld/unixfs` itself encodes uint64 correctly (same test).
11. Option C, guard: refuse or warn in `add` for single files in [2 GiB, 4 GiB) until A or B lands. Note the subtree case (a 1024-wide tree makes 1 GiB subtrees, so files above 4 GiB pass; a different chunker or width could put a subtree in the window).

Recommend one of A/B/C with reasons. End the report with a "verified at runtime" versus "read from source" versus "inferred" breakdown for every claim you make, and the exact commands to reproduce each.
