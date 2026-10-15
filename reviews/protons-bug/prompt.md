You are an independent, skeptical investigator. Another agent claims to have found a data-corruption bug in `protons-runtime` (used by `ipfs-unixfs`). Your job is to try to PROVE THE CLAIM WRONG. Assume the other agent made a mistake somewhere (bad test harness, wrong API usage, misread bytes, misattributed Kubo error) and hunt for it. Only if you cannot break the claim, say so and state exactly what you ran.

You have shell access. Work directory: /private/tmp/claude-501/-Users-sgtpooki-code-work-filoz-filecoin-project-filecoin-pin/cd4ea61b-6abb-414b-952e-88099c98f53d/scratchpad/bench/pkg (a throwaway pnpm package with `ipfs-unixfs@13.1.2`, `ipfs-unixfs-importer@17.1.1`, `@ipld/dag-pb@4.2.0`, `protons-runtime@8.0.1` installed under node_modules). Use Node 24: `export PATH=~/.nvm/versions/node/v24.18.0/bin:$PATH`. Do not modify anything outside this directory except files you create under /tmp. Do not run `git` commands that change state. Do not post anything anywhere.

## The claim

1. `new UnixFS({ type: 'file', blockSizes: [BigInt(n)] }).marshal()` produces corrupt protobuf bytes for any n in [2^31, 2^32), and correct bytes for n < 2^31 and n >= 2^32. Example outputs the other agent recorded:
```
2147483647 OK  080218ffffffff0720ffffffff07
2147483648 BAD 08021800ff020aeb200000545e01   (trailing bytes vary run to run)
3891799298 BAD 08021802dfffff1720021fb80a5e
4294967296 OK  0802188080808010208080808010
```
2. Root cause claimed: in `protons-runtime/dist/src/utils/longbits.js`, `LongBits.fromNumber(value)` computes `lo = value >>> 0` but the constructor stores `this.lo = lo | 0` (signed). For lo in [2^31, 2^32) `this.lo` is negative. `length()` returns 5 (so 5 bytes are reserved in an `allocUnsafe` buffer) but `writeVarint64` in `writer.js` loops `while (val.hi !== 0)` (false) then `while (val.lo > 127)` (false for a negative lo) and writes a single byte, leaving 4 bytes of uninitialised memory. The other agent printed `LongBits.fromNumber(2147483648)` -> `lo -2147483648, hi 0, length 5`.
3. Real-world consequence claimed: a 3,891,799,298-byte file imported with `ipfs-unixfs-importer` (via @helia/unixfs) gets a root dag-pb node whose UnixFS Data is `08 02 18 02 00 00 00 00 20 ...`, and Kubo 0.43.1's gateway rejects it with `proto: cannot parse invalid wire-format data`. The raw root block is at /private/tmp/claude-501/-Users-sgtpooki-code-work-filoz-filecoin-project-filecoin-pin/cd4ea61b-6abb-414b-952e-88099c98f53d/scratchpad/bench/work/dbg/root.bin (226 bytes). A local offline Kubo is running: API http://127.0.0.1:5001, gateway http://127.0.0.1:8080; CLI wrapper /private/tmp/claude-501/-Users-sgtpooki-code-work-filoz-filecoin-project-filecoin-pin/cd4ea61b-6abb-414b-952e-88099c98f53d/scratchpad/bench/ipfs.sh (read-only use please: `block get`, `dag get`, `dag put`, `files stat`, `ls` are fine).

## What to check (at minimum)

- Is `blockSizes: [BigInt(n)]` the correct way to call ipfs-unixfs 13.x, or does the API expect numbers? Does the result change if you pass numbers? Does the importer itself (not the hand-rolled call) produce the same bytes? Try `importer` from `ipfs-unixfs-importer` with the `unixfs-v1-2025` profile on a synthetic 1025 MiB zero stream and on something with a subtree in [2^31, 2^32).
- Decode the produced bytes with an independent protobuf implementation (for example `protobufjs` if you can `pnpm add` it in the work directory, or a hand-written varint reader) and with Kubo (`ipfs dag put --input-codec=dag-pb --store-codec=dag-pb`, then `ipfs files stat /ipfs/<cid>` or fetch via the gateway) to see which side is right.
- Read `node_modules/.pnpm/protons-runtime@8.0.1/node_modules/protons-runtime/dist/src/utils/{longbits.js,writer.js}` and verify or refute the mechanism. Check whether `uint64` goes through `fromBigInt` -> `fromNumber` for safe integers, and what `length()` and `writeVarint64` do with a negative `lo`.
- Check the uninitialised-memory claim: does the garbage change across runs? Does it match the allocUnsafe pool contents?
- Check whether any released protons-runtime version fixes this (`npm view protons-runtime versions`, changelog); look at the upstream source on GitHub if useful.

## Output

Write a markdown verdict: CONFIRMED / REFUTED / INCONCLUSIVE, with the exact commands you ran and their output, what (if anything) the other agent got wrong, the precise condition under which bytes are corrupted, and the minimal reproduction you would put in an upstream bug report. Be terse and concrete. No speculation without a command backing it.
