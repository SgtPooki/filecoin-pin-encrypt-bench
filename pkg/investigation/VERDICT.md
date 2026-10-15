**CONFIRMED**, with a qualification to “any n produces corrupt bytes.” I could not refute the underwrite, the importer failure, or the attribution to protons-runtime 8.0.1. I reproduced the supplied root's UnixFS Data and Kubo 0.43.1's error independently.

All commands below ran from the requested package directory with:

```sh
export PATH=~/.nvm/versions/node/v24.18.0/bin:$PATH
```

Node reported `v24.18.0`. Dependency files were not modified. Evidence, harnesses, and an isolated offline Kubo repository are under `investigation/`.

**API and mechanism.** `ipfs-unixfs/dist/src/index.d.ts:131` declares `blockSizes?: bigint[]`. Passing `[2147483648]` throws `TypeError: Cannot mix BigInt and other types, use explicit conversions`. Its introductory prose says “numbers,” but the declared type and implementation require BigInt. The runtime dependency symlink resolves to `../../protons-runtime@8.0.1/node_modules/protons-runtime`.

I ran:

```sh
cat node_modules/.pnpm/protons-runtime@8.0.1/node_modules/protons-runtime/dist/src/utils/longbits.js
cat node_modules/.pnpm/protons-runtime@8.0.1/node_modules/protons-runtime/dist/src/utils/writer.js
rg -n 'blockSizes|fileSize|uint64' node_modules/ipfs-unixfs/dist/src/{index.js,index.d.ts,unixfs.js}
node investigation/probe.mjs | tee investigation/probe.txt
node investigation/differential.mjs | tee investigation/differential.txt
```

The source confirms `uint64 -> fromBigInt -> fromNumber` for values strictly between the safe-integer bounds. The constructor casts `lo` to signed with `| 0`. At 2147483648, the observed bits are `{ lo: -2147483648, hi: 0 }`, with `length() === 5`. Both writer loops are skipped; only `n & 255` is stored. `finish()` advances by five bytes regardless. Four bytes per affected field remain untouched. Node allocation uses `Buffer.allocUnsafe` through `uint8arrays/alloc`.

For valid unsigned 64-bit inputs, this underwrite occurs exactly at `2^31 <= n < 2^32`. When `hi !== 0`, the first writer loop normalizes `lo` with `>>> 0`; higher values do not hit this underwrite. A file of any total size can still contain an affected descendant or block-size field.

The deterministic differential test compared 20,007 values against an independent BigInt varint encoder:

```text
{ tested: 20007, bad: 5008, outside: 0, afterUnsignedNormalization: 0 }
preseeded valid output 0802188081808008208081808008 equals independent true
```

Unsigned normalization was an in-process diagnostic applied to `LongBits.fromBigInt` results, then restored; no installed code was patched. The test includes full-width uint64 samples, 32-bit samples, and boundaries.

**What the other agent overstated.** Every affected encoding underwrites, but the untouched bytes can accidentally match the missing encoding. For `n=2147483776`, I pre-seeded the four missing bytes in each field and obtained exactly the correct message. Therefore “always invalid protobuf” or “every resulting byte string is corrupt” is too strong. There is nevertheless a deterministic failure at `n=2147483648`: the first byte is already wrong. Also, `dag put` accepts the outer dag-pb envelope; `files stat` detects the invalid embedded UnixFS protobuf.

**Real importer and independent decoding.** I ran:

```sh
node investigation/import.mjs | tee investigation/import.txt
```

The script streams genuine zero bytes through the installed importer and hashes every chunk. Its blockstore copies and retains unique blocks by CID; it does not fabricate sizes or hashes. The independent protobuf reader in `probe.mjs` uses BigInt shifts and rejects field number zero. It shares no protobuf code with protons-runtime.

| Input | Configuration | Bad dag-pb nodes | Root blockSizes | Kubo files stat |
|---|---|---:|---|---|
| 1025 MiB | `profile: 'unixfs-v1-2025'` | 0 | 1073741824, 1048576 | Size: 1074790400 |
| 3891799298 bytes | Same default profile | 1 | 1073741824 × 3, 670573826 | Invalid wire-format |
| 2049 MiB | Same profile, `layout: balanced({maxChildrenPerNode:2048})` | 2 | 2147483648, 1048576 | Invalid wire-format |

The layout override deliberately creates a 2 GiB child subtree; it is not the profile's default 1024-child layout. The unmodified default profile already fails on the requested 3,891,799,298-byte input, solely in the root's filesize field.

Its root Data exactly matches the supplied 226-byte root's Data:

```text
08021802000000002080808080042080808080042080808080042082cae0bf02
```

Independent decoding reports:

```text
field zero at 4; prior=[[1,"2"],[3,"2"]]
```

**Uninitialized memory.** `probe.mjs` temporarily fills allocations with 0, 0xa5, and 0x5a; the four unwritten bytes in both fields retain that fill. It also fills the unused tail of the actual Node allocation slab with 0x6b, without replacing the allocator:

```text
pool same backing store true pool output 080218006b6b6b6b20006b6b6b6b
```

Separate unmodified processes also vary:

```sh
for i in 1 2 3; do node --input-type=module -e 'import {UnixFS} from "ipfs-unixfs"; console.log(Buffer.from(new UnixFS({type:"file",blockSizes:[2147483648n]}).marshal()).toString("hex"))'; done
```

```text
0802180020202020200020202020
0802180000000000200000000000
0802180020202020200020202020
```

**Kubo.** The supplied API could not be reached:

```sh
curl -sS --max-time 5 -X POST http://127.0.0.1:5001/api/v0/version
```

```text
curl: (7) Failed to connect to 127.0.0.1 port 5001 after 0 ms: Couldn't connect to server
```

I instead ran `sh investigation/kubo.sh > investigation/kubo.txt 2>&1`. That retained script contains the exact commands, sets `IPFS_PATH="$PWD/investigation/kubo-repo"`, initializes a separate test repository, imports all unique synthetic blocks, and runs:

```sh
"$KUBO" --offline dag put --input-codec=dag-pb --store-codec=dag-pb "$f"
"$KUBO" --offline files stat "/ipfs/$cid"
```

The installed binary reports `ipfs version 0.43.1`. Every dag-pb put succeeded. `files stat` accepted the independently encoded control (`Size: 2147483648`) and the 1025 MiB real import. It rejected the zero-filled malformed fixture, both larger synthetic imports, and the supplied root with:

```text
Error: proto: cannot parse invalid wire-format data
```

The full command trace and output are in `kubo.txt`. The gateway itself was not tested; the reported error was independently reproduced through Kubo's UnixFS path.

**Released fix: unresolved.** These registry checks failed with `ENOTFOUND registry.npmjs.org`:

```sh
npm view protons-runtime versions dist-tags repository --json
npm view protons-runtime versions dist-tags repository --json --fetch-retries=0 --fetch-timeout=5000
```

The available [upstream changelog](https://github.com/ipfs/protons/blob/main/packages/protons-runtime/CHANGELOG.md) ends at 8.0.1 (2026-09-18), whose entry concerns documentation. The fetched [upstream source](https://raw.githubusercontent.com/ipfs/protons/main/packages/protons-runtime/src/utils/longbits.ts) still has signed constructor casts, but that response was cached three months earlier. Neither establishes that no later released fix exists. Locally installed 7.1.2 also fails:

```sh
node --input-type=module -e 'import {createWriter} from "./node_modules/.pnpm/protons-runtime@7.1.2/node_modules/protons-runtime/dist/src/utils/writer.js";console.log("7.1.2", Buffer.from(createWriter().uint64(2147483648n).finish()).toString("hex"))'
```

```text
7.1.2 0000000000
```

**Minimal upstream reproduction, executed unchanged:**

```sh
node --zero-fill-buffers --input-type=module -e 'import {UnixFS} from "ipfs-unixfs"; console.log(Buffer.from(new UnixFS({type:"file",blockSizes:[2147483648n]}).marshal()).toString("hex"))'
```

```text
Actual:   0802180000000000200000000000
Expected: 0802188080808008208080808008
```

`--zero-fill-buffers` makes the underwrite reproducible without monkey-patching. The command prints the actual hex; the expected hex comes from the independent encoder. This fixture isolates serialization; the importer tests above establish a structurally complete real-file failure.

Raw probe and importer outputs follow, preserving their exact bytes.

**probe.txt**

```text
0 OK actual=080218002000 expected=080218002000
2147483647 OK actual=080218ffffffff0720ffffffff07 expected=080218ffffffff0720ffffffff07
2147483648 BAD actual=080218007370656320006965642c expected=0802188080808008208080808008
2147483776 BAD actual=0802188066206c6520807468203d expected=0802188081808008208081808008
3891799298 BAD actual=0802180269732e702002202b206c expected=08021882cae0bf0e2082cae0bf0e
4294967295 BAD actual=080218ff293b0a2020ff20202020 expected=080218ffffffff0f20ffffffff0f
4294967296 OK actual=0802188080808010208080808010 expected=0802188080808010208080808010
6442450944 OK actual=0802188080808018208080808018 expected=0802188080808018208080808018
9007199254740991 OK actual=080218ffffffffffffff0f20ffffffffffffff0f expected=080218ffffffffffffff0f20ffffffffffffff0f
9223372036854775808 OK actual=080218808080808080808080012080808080808080808001 expected=080218808080808080808080012080808080808080808001
18446744073709551615 OK actual=080218ffffffffffffffffff0120ffffffffffffffffff01 expected=080218ffffffffffffffffff0120ffffffffffffffffff01
number input: TypeError: Cannot mix BigInt and other types, use explicit conversions
bits: LongBits { lo: -2147483648, hi: 0 } length: 5
allocation fill 0 0802180000000000200000000000
independent decode: field zero at 4; prior=[[1,"2"],[3,"0"]]
allocation fill 165 08021800a5a5a5a52000a5a5a5a5
independent decode: wire 5 at 4; prior=[[1,"2"],[3,"0"]]
allocation fill 90 080218005a5a5a5a20005a5a5a5a
independent decode: truncated bytes
pool same backing store true pool output 080218006b6b6b6b20006b6b6b6b
natural 080218006b6b6b6b20006b6b6b6b
natural 080218006b6b6b6b20006b6b6b6b
natural 080218006b6b6b6b20006b6b6b6b
uint64Number 8080808008
original root 226 links 4 Data 08021802000000002080808080042080808080042080808080042082cae0bf02
original independent decode: field zero at 4; prior=[[1,"2"],[3,"2"]]
```

**import.txt**

```text
{"name":"1025MiB","inputBytes":1074790400,"puts":1028,"uniqueBlocks":4,"bad":0,"failures":[],"cid":"bafybeigt7wofv4vnxbg3titijasuw4ptg5kfztec4smsk7opdt7z6djoxq","fileSize":"1074790400","blockSizes":["1073741824","1048576"],"rootData":"0802188080c0800420808080800420808040"}
{"name":"3891799298","inputBytes":3891799298,"puts":3717,"uniqueBlocks":5,"bad":1,"failures":[["bafybeig4ubjvh6l3eepmy74arvaudacuk7cpf46jxornwjiobbmmqo5oge","field zero at 4; prior=[[1,\"2\"],[3,\"2\"]]"]],"cid":"bafybeig4ubjvh6l3eepmy74arvaudacuk7cpf46jxornwjiobbmmqo5oge","fileSize":"3891799298","blockSizes":["1073741824","1073741824","1073741824","670573826"],"rootData":"08021802000000002080808080042080808080042080808080042082cae0bf02"}
{"name":"2049MiB-subtree","inputBytes":2148532224,"puts":2052,"uniqueBlocks":4,"bad":2,"failures":[["bafybeiffac7u6b3ezmbudnnd3wyijtoxd7a5wgh3odd6wxvjzwckejb73a","field zero at 4; prior=[[1,\"2\"],[3,\"0\"]]"],["bafybeihkyuyjpxvdk77tpd3km3qb5nat2snfqqk5gkqquhif7rnfe35nv4","field zero at 4; prior=[[1,\"2\"],[3,\"0\"]]"]],"cid":"bafybeihkyuyjpxvdk77tpd3km3qb5nat2snfqqk5gkqquhif7rnfe35nv4","fileSize":"2148532224","blockSizes":["2147483648","1048576"],"rootData":"080218000000000020000000000020808040"}
```

