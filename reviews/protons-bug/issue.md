`add` of a file between 2 GiB and 4 GiB produces a UnixFS root that Kubo rejects with `proto: cannot parse invalid wire-format data`. Nothing in the `add` path validates the node, so the CAR packs and uploads, but the root CID is unusable through a Go gateway, and `ipfs-unixfs` itself either throws on unmarshal or reads a filesize of 0 (depends on the garbage bytes).

### Root cause

`protons-runtime` (6.0.2 in our tree via `ipfs-unixfs` 12.0.2, same in 8.0.1 and upstream `main`) stores the low word of a 64-bit value as a signed int: [`this.lo = lo | 0`](https://github.com/ipfs/protons/blob/main/packages/protons-runtime/src/utils/longbits.ts#L25). For any uint64 in [2^31, 2^32) the low word goes negative, `length()` still reserves 5 bytes, but `writeVarint64` skips both loops (`val.lo > 127` is false for a negative) and writes a single byte. The other 4 bytes keep whatever `allocUnsafe` held. UnixFS `filesize` and `blocksizes` are uint64, so a file node whose size, or any child subtree size, lands in that window is corrupt. Files above 4 GiB with 1 GiB subtrees are fine, which is why this only shows up for 2 to 4 GB inputs under the unixfs-v1-2025 profile.

### Repro

```sh
node --zero-fill-buffers --input-type=module -e 'import {UnixFS} from "ipfs-unixfs"; console.log(Buffer.from(new UnixFS({type:"file",blockSizes:[2147483648n]}).marshal()).toString("hex"))'
# actual   0802180000000000200000000000
# expected 0802188080808008208080808008
```

End to end: `filecoin-pin add` a 3,891,799,298-byte file, `ipfs dag import` the CAR into Kubo 0.43.1, fetch the root through the gateway. The root's UnixFS Data is `08 02 18 02 00 00 00 00 20 ...` (filesize varint cut to one byte, then field 0).

### Next step

Fix belongs upstream in `ipfs/protons` (`lo >>> 0` in the constructor, or normalize in `fromNumber`). Until a release lands, `add` should refuse or warn on single files in [2 GiB, 4 GiB), since the stored piece is paid for and unreadable.

Verified 2026-10-14 at runtime with the `feat/add-encrypt` worktree's `createCarFromPath` and an independent Codex investigation (differential test against a BigInt varint encoder: 5,008 of 20,007 sampled values corrupt, all inside the window).
