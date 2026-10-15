# Finding: UnixFS nodes with a uint64 in [2^31, 2^32) are mis-encoded (protons-runtime)

Found 2026-10-14 while benchmarking encrypted payload formats. Independent of the payload choice.

## Symptom (runtime)
- `createCarFromPath` from the `feat/decrypt` worktree (`@helia/unixfs` 7.2.1, `ipfs-unixfs-importer` 16.1.5,
  `ipfs-unixfs` 12.0.2, `protons-runtime` 6.0.2) packed a 3,891,799,298-byte file. After `ipfs dag import`,
  Kubo 0.43.1 gateway: `500 failed to resolve /ipfs/bafybeig734tdn3cwij5oogrxuqglfzzysvf6e7jwue5nllnbujhvuwujfi: proto: cannot parse invalid wire-format data`.
- `ipfs block get` of that root decodes with `@ipld/dag-pb` (4 links, Tsizes correct) but the UnixFS `Data` is
  `08 02 18 02 00 00 00 00 20 ...`: filesize field encoded as one byte `02` followed by garbage (`00` = protobuf field 0, invalid).
  Expected varint for 3891799298: `82 d5 d9 bf 0e`.
- 673 MB, 1 GiB, 5 GiB files from the same code path are fine.

## Minimal repro (runtime, inside the worktree's own node_modules, ipfs-unixfs 12.0.2)
```
new UnixFS({ type: 'file', blockSizes: [BigInt(n)] }).marshal()
2147483647 OK  080218ffffffff0720ffffffff07
2147483648 BAD 08021800ff020aeb200000545e01   (trailing bytes vary run to run)
3891799298 BAD 08021802dfffff1720021fb80a5e
4294967296 OK  0802188080808010208080808010
```
Same with ipfs-unixfs 13.1.2 / protons-runtime 8.0.1 (latest on npm as of 2026-09-18).

## Mechanism (source, protons-runtime dist/src/utils)
- `Writer.uint64(value)` -> `LongBits.fromBigInt(value)` -> for safe integers `LongBits.fromNumber(Number(value))`
  -> `lo = value >>> 0` (unsigned) but the constructor stores `this.lo = lo | 0` (signed).
- For `lo` in [2^31, 2^32) `this.lo` is negative. `length()` still returns 5 (correct), so 5 bytes are reserved in an
  `allocUnsafe` buffer, but `writeVarint64` loops `while (val.hi !== 0)` (false) then `while (val.lo > 127)`
  (false for negative) and writes a single byte `val.lo & 0xff`. The other 4 bytes keep whatever the buffer held.
- Verified: `LongBits.fromNumber(2147483648)` -> `lo -2147483648, hi 0, length 5`.

## Blast radius
Any UnixFS file node whose `filesize` or any `blocksizes` entry is in [2 GiB, 4 GiB): a single file of 2..4 GB,
or an intermediate node whose subtree is in that range. Directories are unaffected (no sizes in dir nodes).
Reads by JS (`ipfs-unixfs` unmarshal) also fail or return 0, so js clients break too. Go (Kubo/boxo) rejects the node.

## Not yet done
- No upstream issue filed (needs user approval). Search `ipfs/protons` for "uint64": only #112 (closed, 2023).
- Workaround used in the bench: a 4.5 GB video (above 2^32) instead of the 3.9 GB one. The 3.9 GB file remains at
  `bench/inputs/bbb_4g.mp4` as a repro input.
