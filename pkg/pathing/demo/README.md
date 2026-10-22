# Demo: one encrypted file, two readers

What it shows, in two columns on one page:

- **Existing clients, no key.** The upload's `encrypted.fee` is one ordinary UnixFS file. The page runs three requests against the gateway it was served from and prints the results: a `Range` read (206), a trustless raw-block read (200), and a path into the file (the gateway's normal error for a path into any file: Kubo 404, verified-fetch 502, frisbii 200 with only the root block). Below that, the only plaintext the gateway holds: size, content type, chunk size, and the Keysmith labels.
- **Key holder, our reader.** The page decrypts the folder index with one bounded Range read, lists the folder (5,004 files, one of them a 24 MiB binary, one a 12 s clip, 5,000 in a HAMT-sharded directory), resolves a path by walking the decrypted dag-pb nodes exactly as UnixFS resolution does (shard buckets included) and prints every hop, then fetches that file with one chunk-aligned Range. A counter and a chunk strip show what was fetched: 3 requests, 1.3 MiB of 24.9 MiB for one small file out of 5,000. The inner folder CID is printed and equals the CID a plain `filecoin-pin add` of the folder produces (checked at build time).

What it deliberately does not show: seeking inside a video (measured in the benchmark, README "Random reads" and "Browser"); the in-upload Service Worker (a browser trick, dropped from this build); anything about sharing single files.

## Build

```sh
cd pkg
node pathing/demo/build.mjs          # new fixture, new envelope, new key; prints the key and the CID check
KEEP=1 node pathing/demo/build.mjs   # page only
```

The envelope is written by the filecoin-pin #772 worktree build (`dist/common/encryption.js`, `dist/common/keyspace.js`) with the pkg.pr.new build of `@filoz/keysmith`, so it is byte-for-byte what `filecoin-pin add --encrypt` writes. Anvil dev key #0, the vector keyspace.

## Open

```
https://<root>.ipfs.<gateway>/#k=<piece key hex>
```

The key in the fragment is shown in the key box and never leaves the browser. Works on any gateway that serves the directory and honours `Range` on files: Kubo, Rainbow, inbrowser.link. The page reads only what it needs, so a cold load through a service-worker gateway fetches the first 1 MiB leaf of the envelope, not the file.

## Verify

```sh
node pathing/demo/verify3.mjs "http://<root>.ipfs.localhost:8080/" <key>   # local Kubo, subdomain gateway
node pathing/demo/verify3.mjs "https://<root>.ipfs.inbrowser.link/" <key>
```

Prints the gateway rows, the counter after opening `many/f4321.txt`, after a 64 KiB read at offset 12 MiB in `data/big.bin`, and after `docs/notes.txt`, plus the resolution trace. 2026-10-21 on local Kubo 0.43.1: 3 requests / 1.3 MiB, then 4 / 1.5 MiB, then 5 / 1.8 MiB, all three files correct, trace walks root → folder → HAMT shard (256 links) → sub-shard (13 links) → leaf.
