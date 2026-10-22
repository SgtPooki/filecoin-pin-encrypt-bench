# Can UnixFS pathing work over FEE-encrypted CAR-in-CAR uploads?

Research note, 2026-10-21. Answers the six questions in the brief in order. Every claim about a tool is tied to a spec section, a file and line, or a command run here with its output. Throwaway scripts live in `pkg/pathing/` (three files, nothing else in the repo changed). Nothing was posted anywhere.

Shape under discussion, as #771 writes it:

```
CAR_outer( UnixFS file "encrypted.fee" = [FEE header][enc( CAR_inner( UnixFS(file or dir) ) )] )
```

The outer CAR is a plain UnixFS file. Names, folders, inner CIDs and the metadata-first block order are inside the ciphertext.

## 1. What the IPFS stack does today with `/ipfs/<outer>/some/path`

Baseline: pathing into the blob fails, loudly, at every layer. The exact failure differs per tool.

**Specs.**

- UnixFS spec §3.1.1.6: "A file terminates a UnixFS content path. Any attempt to resolve a path past a file MUST be rejected with an error indicating that UnixFS files cannot have children." (https://specs.ipfs.tech/unixfs/)
- Path Gateway §4.1.5 "Handling traversal errors": "Gateway MUST respond with HTTP error when it is not possible to traverse the requested content path." §2.1.4: Range "can be used for requesting specific byte range of UnixFS files and raw blocks." (https://specs.ipfs.tech/http-gateways/path-gateway/)
- Trustless Gateway: raw block responses allow no path ("only `GET /ipfs/{cid}[?{params}]`"); CAR responses allow a path with "pathing behavior identical to path-gateway"; `entity-bytes` is "a trustless equivalent of an HTTP Range Request"; 404 is specified only for a missing root block, and a stream that hits a missing child "SHOULD terminate." No Range on raw blocks. (https://specs.ipfs.tech/http-gateways/trustless-gateway/)

**Measured.** Test object: `big.fee` from `filecoin-pin-decrypt/src/test/fixtures/encrypted-golden` (1,100,718 bytes) added as a UnixFS file with 1 MiB raw leaves. Outer CID `bafybeigbxv63mk7soxh5tdsj4g2cljgnecscfdzx7ofuekc3phi2i7kyw4`, three blocks: root dag-pb 108 B, leaf 1,048,576 B, leaf 52,142 B (`pkg/pathing/ls-car.mjs`).

| Tool | Request | Result |
|---|---|---|
| Kubo 0.43.1, offline daemon, path gateway | `GET /ipfs/<outer>/foo` | **404**, `text/plain`: `failed to resolve /ipfs/<outer>/foo: no link named "foo" under <outer>` |
| Kubo | `GET /ipfs/<outer>/foo?format=car` | **200**, CAR with roots `[bafkqaaa]` (identity, "no root") and one block: the outer root. The client has to notice the path did not resolve. |
| Kubo | `GET /ipfs/<outer>` with `Range: bytes=0-1023` | **206**, 1024 bytes |
| Kubo | `GET /ipfs/<outer>?format=car&dag-scope=entity&entity-bytes=0:262143` | **200**, CAR: root + first 1 MiB leaf (1,048,820 B) |
| Kubo | `GET /ipfs/<outer>?format=raw` | **200**, the 108-byte root block |
| frisbii v0.10.0 (the library Curio serves `/ipfs/` with, `curio/go.mod:69`, `market/retrieval/retrieval.go:71,262`) | `GET /ipfs/<outer>/foo` (any Accept) | **200**, `application/vnd.ipld.car; dups=y`, 205 bytes: header + the outer root only. The path miss is logged as a warning, not an error: `carstream.go:78` `traversal.CheckPath(...)` result goes to `logger.Warn(err)`. |
| frisbii | `GET /ipfs/<outer>/foo?format=raw` | **400**, `path not supported for raw requests` (`httpipfs.go:317`) |
| frisbii | `GET /ipfs/<outer>?format=car` with `Range: bytes=0-1023` | **200**, full 1,101,001-byte CAR. Range ignored. |
| frisbii | `GET /ipfs/<leaf>?format=raw` with `Range: bytes=0-1023` | **200**, full 1,048,576-byte block. Range ignored. |
| frisbii | `entity-bytes=0:262143` | **200**, root + first leaf, 1,048,820 B |
| @helia/verified-fetch 8.1.2 (trustless client against the Kubo gateway) | `ipfs://<outer>/foo` | **502**, body `NotUnixFSError: Did not read Link or Data from dag-pb block` |
| verified-fetch | `ipfs://<outer>` with `Range: bytes=0-1023` | **206**, 1024 bytes |

Where the 404 comes from in Kubo: boxo `path/resolver/resolver.go:35` formats `no link named %q under %s`; `gateway/errors.go:276` maps `resolver.ErrNoLink` to 404 (`errors.go:252-253`). Rainbow uses the same boxo gateway package; not run here (unverified).

Where the 502 comes from in verified-fetch: `verified-fetch.ts` resolves the URL first (`this.urlResolver.resolve(url, ...)`, line 223) and returns that Response as-is when resolution fails; the plugin pipeline (`runPluginPipeline`, line 509) never runs for that request.

Commands: `pkg/pathing/vf.mjs`, `pkg/pathing/ls-car.mjs`, and the `curl` lines recorded in the scratch log; the frisbii binary was built from the v0.10.0 module source (`go build ./cmd/frisbii`) and run with `--car outer.car`.

## 2. What a key-holding client needs to resolve `<outer>/dir/file.txt`

The walk, against the layout in `filecoin-pin-encrypt/src/common/unixfs-car-layout.ts` and the bench reader `pkg/lib/car-seek.mjs`:

1. **FEE header.** Fetch a prefix of the envelope (FRC-0120 "Range Decryption": "A 4 KiB first read covers typical envelopes"). Parse `chunk_size` (default 262,144, FRC-0120 line 256), base nonce, `plaintext_length`, `content_type`, `app_metadata`. For #771 envelopes `app_metadata` is Keysmith `pieceMetadata` (`derive.ts:313-323`): `foc/v`, `foc/own`, `foc/ks`, `foc/salt`, optional `foc/scope`.
2. **Key.** `keyspaceKeys(signer, {owner: foc/own, keyspace: foc/ks})` with the owner wallet, or `unwrapWith(privateKey, grant)` for a grant holder; then `keyForEnvelope(node, app_metadata)` (`derive.ts:358`). Pure computation, no network.
3. **Metadata prefix.** `decryptRange` from plaintext offset 0, open-ended, read until every dag-pb node reachable from the inner root has arrived, then cancel (`car-seek.mjs:9-27`). Metadata-first order guarantees no raw leaf precedes a needed dag-pb node (README "Why metadata-first order"). This is the only "index" and it is derived, not stored.
4. **Path resolution, client side.** Walk `dir/file.txt` over the decrypted dag-pb nodes exactly as UnixFS §3.1.2.2 (basic directory: match link `Name`) and §3.1.3.2 (HAMT) prescribe. `layout()` (`unixfs-car-layout.ts:131`) turns the walk into `files: Map<path, {size, leaves[]}>` with each leaf's `dataOffset` inside the inner CAR (`:292`).
5. **Range mapping.** Plaintext byte range of the inner CAR → FEE chunks `first_chunk = floor(offset / chunk_size)` ... (FRC-0120 lines 368-371) → ciphertext offsets `envelope_length + i × (chunk_size + 16)`. Adjacent leaves are read as one span with the 36-byte CID + varint framing stripped on the fly (`car-seek.mjs:36-60`).
6. **Fetch and decrypt.** One HTTP request per span, chunk-aligned; AES-GCM tag per chunk authenticates what was read.

**Cost, measured against a Kubo path gateway** (README lines 197-203; HAMT dir of 6000 files, 508 dag-pb nodes, 397 KB of inner metadata, line 249):

| Target | Requests | Bytes | Notes |
|---|---:|---:|---|
| `f6000.bin`, entry 5560 of 6000 | 2 | 560 KB | prep = open-ended Range from 0, cancelled when the DAG closes; then one chunk-aligned Range |
| `f1.bin`, entry 2 | 2 | 560 KB | same |
| `docs/small_99.txt` in a 354-entry bundle | 2 | 330 KB | metadata smaller |

Per seek the cost is one 256 KiB FEE chunk plus tag, two when a read straddles a 1 MiB leaf (README line 187).

**Does it hold through Curio?** Curio exposes two retrieval paths (`retrieval.go:248-262`):

- `/ipfs/<cid>` → frisbii: CAR or raw block only, no UnixFS rendering, **Range ignored** on both CAR and raw responses (measured above).
- `/piece/<pieceCid>` → `piecehandler.go:87` `http.ServeContent(...)` over the unpadded piece (`:84` "serve the original data without padding"): **Range honoured**, bytes are the outer CAR exactly as uploaded.

So the Kubo numbers do not transfer to `/ipfs/` on Curio; the reader has to change its fetch unit. Three Curio-direct strategies, same 6000-file example. Bytes are computed from the profile, not measured (unverified against a live Curio):

| Strategy | Prep | Per seek | Total for the example | Needs |
|---|---|---|---:|---|
| A. `/ipfs/` raw blocks: `GET <outer>?format=raw` (root dag-pb), then `GET <leaf>?format=raw` per 1 MiB leaf touched | 2 req: root (108 B here, about 46 KB for a 1 GiB envelope, one extra level and request above 1 GiB) + leaf 0 (1 MiB, holds the header and the first 3.99 chunks, so any metadata prefix under ~1 MiB) | 1 req / 1 MiB, 2 when the 256 KiB chunk straddles a leaf (about 1 in 4 random offsets) | 3 req / ~2.1 MiB | outer CID only; fully verified block by block |
| B. `/ipfs/` CAR with `dag-scope=entity&entity-bytes=a:b` | 1 req: root + leaf 0 (1,048,820 B measured) | 1 req: root again + 1 or 2 leaves | 2 req / ~2.1 MiB | outer CID only; verified; `dups=y` on frisbii |
| C. `/piece/<pieceCid>` + `Range` | 1 req, same bytes as Kubo (chunk-aligned) + 39 B per leaf boundary crossed | 1 req, one FEE chunk | 2 req / ~560 KB | the **piece CID** (chain or share link), not the IPFS CID; unverified transport, FEE tags still authenticate every chunk; `/piece/` ungated |

Strategy C works without any index because filecoin-pin's outer CAR has a fixed layout. Built with `createCarFromPath` from the #772 worktree on `big.fee` (`pkg/pathing/car-offsets.mjs`):

```
header: varint+cbor = 59 bytes
section@59       len=1048612 data@98       dataLen=1048576 raw
section@1048674  len=52178   data@1048713  dataLen=52142   raw
section@1100855  len=144     data@1100893  dataLen=108     dag-pb   <- root is LAST
```

Leaves first, root last, 1 MiB leaves, 36-byte CIDs, 3-byte varints: envelope byte `e` sits at piece offset `98 + floor(e / 1048576) × 1048615 + (e mod 1048576)` for every leaf but the last. That is a property of `CARWritingBlockstore` writing blocks in importer order (`car-builder.ts:80-100`) under the `unixfs-v1-2025` profile; Kubo's `dag export` of the same DAG puts the root first (`outer.car` listing above), so this is a filecoin-pin convention, not a CAR guarantee.

Answer: the 2-request figure holds through Curio only via `/piece/` + Range (strategy C). Through `/ipfs/` on Curio the floor is 2 requests and about 2 MiB for a small file in a large directory (strategy B), because the fetch unit is the 1 MiB leaf and Range is ignored.

## 3. Could inner nodes be addressable by CID without decrypting?

No. Confirmed:

- The inner CAR, including every inner CID, is ciphertext. The only CIDs that exist on the network are the outer root and its raw leaves (three blocks for `big.fee`, listing above). IPNI advertises what the provider holds; Curio's `/ipfs/` resolves through `remoteblockstore` keyed by those outer multihashes (`retrieval.go:65-71`). A request for an inner CID at any gateway is a request for a block nobody has.
- Even a reader holding the key cannot fetch an inner block by its CID from the network; it must fetch outer bytes by offset and decrypt. Inner CIDs are useful only locally, to verify decrypted blocks (`unixfs-car-unpack.ts` does this).

Designs that would change it, and what each leaks:

| Design | What it gives | What it leaks |
|---|---|---|
| Put the inner root CID in `app_metadata` (clear) | A stable plaintext identifier; `ipfs://<inner>` resolvable by anyone who already has the decrypted CAR | A confirmation oracle: anyone can test a candidate file against the public CID. PRD v2 §9 omits FEE's plaintext CID field for exactly this reason. |
| Publish every inner dag-pb node in the clear (outside the envelope) | Server-side pathing and listing without the key | Names, tree shape, file sizes, leaf CIDs (so file contents by dictionary), the number of files. Defeats the point of the inner CAR. |
| Publish inner CIDs to IPNI pointing at the outer provider | "Discoverable" inner CIDs | Same leak as above, and the provider cannot serve them: it holds ciphertext. Every resolver would 404 after a lookup. |
| Keysmith `foc/scope` as a path label | Nothing for pathing: it is a role, one per piece, not a directory (PRD v2 §10 "Scopes are user groups / roles, not folders") | The label, already public by design |

## 4. What a "FEE + UnixFS pathing" profile would specify

One page, if written. Nothing below changes bytes that #771 writes today.

**Outer object.** A UnixFS file under the `unixfs-v1-2025` profile (CIDv1, raw leaves, 1 MiB chunks, 1024-wide), named `encrypted.fee` in piece metadata. Its bytes are one FRC-0120 envelope: COSE header followed by scheme 2 ciphertext.

**Detection.** The protected header carries `content_type` (label 3, FRC-0120 line 153) = `application/vnd.ipld.car` (`unixfs-car-layout.ts:26`, written at `encryption.ts:47`, enforced at `:74`). A reader that sees any other `content_type` does not apply this profile. `app_metadata` (label -65792) is Keysmith `pieceMetadata`; `foc/v` = 1 is the version of the labels, and the profile is pinned to it. No other marker is needed; `content_type` is already authenticated (protected header, FRC-0120 line 180).

**Inner object.** CARv1, exactly one root, the root an anonymous UnixFS directory with exactly one child named after the input. Blocks metadata-first: every dag-pb node breadth-first from the root, each CID once, then raw leaves in file order, each CID once (README "Recommendation" 1-3; `unixfs-car-layout.ts` header comment). Symlinks, inline file data, unknown codecs, and names that are empty, `.`, `..`, or contain `/` or `\0` are invalid (`unixfs-car-layout.ts:122`).

**Path resolution rule.** The path after `<outer>` resolves inside the inner CAR by the UnixFS rules (§3.1.2.2 basic directory link names, §3.1.3.2 HAMT), starting at the inner root's single child, not at the anonymous wrapper. A path that reaches a file with segments left is an error (§3.1.1.6). Resolution happens in the reader after step 3 above; the network sees only outer bytes.

**Range mapping.** `(path, offset, length)` → inner CAR byte spans from `layout()` → FEE chunk indexes per FRC-0120 "Range Decryption" → outer byte ranges, with framing between adjacent leaves stripped by the reader. Over a path gateway the outer range is an HTTP `Range` on the file; over a trustless gateway it is `entity-bytes` or raw leaf blocks; over Curio `/piece/` it is `Range` on the piece with the fixed offset formula in §2.

**Keys.** Out of scope for the profile: Keysmith defines them, the profile only says the envelope's `app_metadata` must be what `keyForEnvelope` accepts.

**Out of scope, stated.** No inner CIDs in the clear. No sub-graph fetch over the network: no gateway, indexer or provider is expected to resolve, list, or serve anything inside the envelope. No change to FRC-0120, Keysmith, Curio, Kubo, verified-fetch or IPNI.

## 5. Where the profile could live without ecosystem alignment

| Option | What it needs, from whom | Gives "share a link, recipient with a key gets the file"? | Ecosystem alignment? |
|---|---|---|---|
| (a) Only in filecoin-pin `decrypt` (and a future `get`) plus the foc-viewer | Nothing upstream. The CLI already has the reader (#772 `unixfs-car-unpack.ts`), the bench has the seeking reader (`car-seek.mjs`) and a decrypting Service Worker (`pkg/web/sw-src.mjs`). A viewer build is a static page on IPFS. | Yes. The link is `<viewer>#<outer cid>`; the viewer fetches outer bytes from any gateway that serves the outer CID (Kubo-style with Range, or trustless with `entity-bytes`), decrypts, resolves the path locally. Sub-paths ride in the fragment, not the IPFS path. | None |
| (b) A verified-fetch plugin | A plugin can replace the default `unixfs-plugin` by id (`verified-fetch.ts:107-118`) and sees `terminalElement`, `accept`, `url.searchParams`, `range`, `blockstore` in `PluginContext` (`index.ts:958-998`). It **cannot** intercept `ipfs://<outer>/dir/file.txt`: the URL resolver runs before the pipeline and already returned the 502 above. It can handle `ipfs://<outer>?path=dir/file.txt` (query parameter) and serve the decrypted file. Key delivery into the plugin is an app concern. Needs a maintained plugin package and, for inbrowser.link users, that gateway to load it. | Only for clients that install the plugin. Does not help `curl`, Kubo, or public gateways. | A package we own; no spec change. inbrowser.link adoption would be alignment work. |
| (c) Kubo / Rainbow change | A new UnixFS-file content handler in boxo's gateway that recognizes `content_type` and decrypts; a key would have to reach the gateway, which breaks "the provider never holds plaintext" (PRD v2 §11). | Only on gateways we run. | Yes, boxo PRs and a key-handling story nobody wants. |

Jenni's "no bandwidth for ecosystem alignment" rules out (c) outright and (b) as anything beyond an optional package. (a) alone meets the user story: one link, one key, the recipient gets the file or folder, with sub-path and range reads working in the viewer and the CLI. The cost of (a) is that `ipfs://<outer>/dir/file.txt` stays a 404 in every generic tool, which is the honest behaviour for a black box.

## 6. Recommendation

No profile for v1. Everything a reader needs is already pinned by three things we control: FRC-0120 (header, chunks, ranges), Keysmith `pieceMetadata` (which key), and the inner CAR convention in #771 (what the plaintext is and in what order). Writing the page in §4 costs a day and buys nothing until a second implementation exists; the viewer and `decrypt` are the first, and they share the reader. Revisit when someone outside filecoin-pin asks to open our envelopes, or when the gated `/download/` path changes the outer shape.

The one sentence for people: **An encrypted upload is one opaque file on IPFS; paths and ranges inside it work only in a reader that holds the key (filecoin-pin and the viewer), never in a plain gateway URL.**

That answers "do we need a profile". It does not answer "can pathing work at all". §7 looks for ways it can.

## 7. Solutions explored: ways to make `<outer>/dir/file.txt` work

Six designs, from "ship this week" to "new format". Each one says what it changes, what it costs, and what it leaks. Leak baseline for the current inner-CAR shape: total ciphertext size only.

### 7.1 Real URLs on a decrypting origin (no format change)

The bench Service Worker already does this. `pkg/web/sw-src.mjs:1-2` answers `/media/<fmt>/<root>/<path>` with `Range` support by opening the envelope at a gateway, resolving `<path>` inside the inner CAR with `openCarReader` (`sw-src.mjs:42-45`), and streaming `decryptRange` output. Verified in one run on 2026-10-21 (`pkg/pathing/sw-path-probe.mjs`): a 3-file tree (`site/index.html` 1,500 B, `site/docs/small.txt` 24 B, `site/media/nested/big.bin` 3,000,000 B) packed as the inner CAR, encrypted, added to an offline Kubo 0.43.1 at `127.0.0.1:8080`, and fetched from headless Chrome through the bench Service Worker as `/media/car/<root>/<path>`:

| Request | Status | Bytes match |
|---|---|---|
| `site/docs/small.txt`, no Range | 200, 24 B | yes |
| `site/media/nested/big.bin`, no Range | 200, 3,000,000 B | yes |
| `big.bin` `Range: 0-1023` | 206 `bytes 0-1023/3000000` | yes |
| `big.bin` `Range: 1048476-1048775` (straddles the 1 MiB leaf boundary) | 206 | yes |
| `big.bin` `Range: 2999000-2999999` (tail) | 206 | yes |
| `site/index.html`, no Range and two Ranges | 200 / 206 / 206 | yes |

Per path the SW spent 3 requests and about 340 KB on prep (HEAD, header, metadata prefix; the metadata itself is 828 B) and one chunk-aligned request per Range. The reader is opened once per path in the bench SW; a viewer would open it once per root and share it across paths.

Rename the route to `/ipfs/<outer>/<path>` inside the viewer's own origin and every relative link in a decrypted static site, `<img src>`, `<video src>`, `fetch()` from page scripts, works unchanged. The key arrives once (fragment, paste, or a Keysmith grant unwrapped in page) and the SW keeps it for the session. Outer bytes come from any gateway that serves the outer CID: path gateways with `Range`, trustless gateways with `entity-bytes`, Curio `/piece/` with `Range` (§2 strategy C).

- Needs: the viewer build (foc-viewer repo per Natalie's v0 tab) plus the bench reader. No upstream change.
- Gives: working paths and ranges in URLs, for anyone who opens our link. `curl` against the viewer origin does not work (it is a Service Worker, so a browser is required); see 7.2 for that.
- Leaks: nothing new.
- Verdict: **do this for v1.** It is the cheapest thing that makes "pathing works" true in a URL bar.

### 7.2 A FEE-aware local gateway in filecoin-pin (no format change)

`filecoin-pin server` is already a Fastify daemon (CLAUDE.md "server daemon"). Add `GET /ipfs/<outer>/<path>` with `Range`, backed by the #772 reader and the owner key or a grant from `session.env`. Same code path as 7.1, running in Node instead of a Service Worker. `curl`, `ffmpeg`, `mpv`, and agents get pathing and ranges over plain HTTP on localhost.

- Needs: one route in the existing server, the `car-seek` reader ported from the bench into `src/common/`.
- Gives: the Kubo/Rainbow outcome of option (c) in §5 without touching Kubo or Rainbow, and without a key ever leaving the user's machine.
- Leaks: nothing new.
- Verdict: cheap follow-up to `get`. Not needed for the share story, needed for agents that want HTTP rather than a CLI.

### 7.3 A URL convention that generic tools ignore and FEE-aware tools honour (no format change)

Carry the inner path in a query parameter instead of the IPFS path: `ipfs://<outer>?fee-path=dir/file.txt` or `https://<gw>/ipfs/<outer>?fee-path=dir/file.txt`.

- A path gateway ignores the parameter and serves the whole envelope (still correct, still a 200, still `Range`-able). Nothing 404s.
- verified-fetch passes `url.searchParams` into `PluginContext` (`index.ts:958`), so a plugin replacing `unixfs-plugin` by id can resolve the path itself. This is the only shape a verified-fetch plugin can serve, since the resolver rejects a real sub-path before plugins run (§1).
- 7.1 and 7.2 accept the same parameter, so one link format works in the viewer, the local server, a plugin, and degrades to "download the blob" everywhere else.
- Leaks: the path string in the URL, which the link author chose to share. Keep it out of share links meant to hide names.
- Verdict: adopt as the link convention alongside 7.1. Zero cost.

### 7.4 Token directory: gateway-native pathing with hidden names (format change)

Make the outer object a UnixFS **directory**, not a file. One entry per inner file, named by a keyed token, each entry its own FEE envelope. A manifest envelope under a fixed token maps real paths to tokens and sizes.

```
<outer>/                          UnixFS directory (basic or HAMT), names are tokens
  <token("")>                     FEE( manifest: path -> token, size, salt )
  <token("docs/a.txt")>           FEE( docs/a.txt bytes )
  <token("assets/video.mp4")>     FEE( assets/video.mp4 bytes )
```

`token(path) = base32(HMAC-SHA256(nameKey, path))`, `nameKey` derived under Keysmith from the upload's own salt (one more HKDF step beside `pieceKey`), so anyone holding the keyspace, the scope, or a grant for the upload computes tokens locally and nobody else can confirm a filename.

What this buys, measured against what exists today:

| Property | inner CAR (today) | token directory |
|---|---|---|
| `/ipfs/<outer>/<token>` in Kubo, Rainbow, inbrowser.link, verified-fetch | 404 | **200, with Range**, no plugin (UnixFS §3.1.2.2, Path Gateway §2.1.4; it is an ordinary directory) |
| Trustless `?format=car` of one file | whole-DAG or entity-bytes guesswork over the envelope | `dag-scope=entity` on the entry: exactly that file's blocks |
| Seek into file N of 6000 | 2 requests / 560 KB (prep reads 397 KB of metadata) | 1 request for the manifest once, then 1 request per file, no prep |
| Share one file out of a folder | impossible without sharing the whole key | a Keysmith `piece:<salt>` grant plus the token; the recipient fetches one entry (`derive.ts:281` `pieceNode`) |
| Listing | decrypt the metadata prefix | decrypt the manifest (one small envelope) |
| Dedup across files | yes (README: 5x on the dedup input) | none between files |
| Overhead per file | ~100 B | one FEE header (638 B measured on `big.fee`: 1,100,718 − 1,100,000 − 5×16) + 16 B per 256 KiB chunk; 6000 small files cost about 3.9 MB of headers |
| Leaks | total size | **file count, each file's ciphertext size, directory shape for HAMT (>~1000 entries), token strings** |
| Curio gated `/download/` later | one piece, one check | one piece still (the whole directory is one CAR, one PieceCID); per-entry gating is Curio's problem, not ours |

Reader changes: trivial on the read side (standard UnixFS directory, standard FEE per file). Write side: `add --encrypt` packs N envelopes into a directory instead of one envelope; `planCarPayload` and the metadata-first order become unnecessary for this shape.

- Needs: a second profile (`content_type` of each entry stays `application/octet-stream` or a per-file type; the manifest gets its own content type). Keysmith gains nothing new: per-file salts already exist as `foc/salt`, the name key is one HKDF label we define.
- Gives: pathing and ranges in every existing gateway, trustless per-file CAR fetches, per-file sharing. This is the only design here where "IPFS tooling compatibility over encrypted data" is not broken.
- Costs: the leaks row, no dedup, and a format we would run beside the inner-CAR one (or instead of it).
- Verdict: **the real alternative**, not for v1. It should be the shape we pick if a user says "I need `/ipfs/<cid>/path` to work in my gateway" or "share one file from this folder". Keep the inner CAR for the private case where even the file count is sensitive.

### 7.5 Token directory over shared leaves (format change, rejected)

A variant of 7.4 that keeps the single inner-CAR envelope and adds a second UnixFS tree whose entries are files composed of the **same raw leaf blocks** that already hold each inner file's ciphertext span (UnixFS files may reference any existing blocks via `Links` + `blocksizes`, UnixFS §3.1.1.1). No extra ciphertext stored, dedup kept, and `/ipfs/<tokendir>/<token>` fetches exactly the leaves covering a file.

It fails on precision: FEE chunks are 256 KiB and outer leaves 1 MiB, so an entry covers up to 1 MiB of neighbours on each side, the reader still needs the manifest to find the chunk index and in-chunk offset, and the clear-text tree reveals which files share leaves, i.e. the order and rough size of every file. More complexity than 7.4 for a weaker result. Noted so nobody re-derives it.

### 7.6 Publish inner CIDs (rejected)

Covered in §3. Any version of "put the plaintext DAG on the network" is a confirmation oracle on file contents and names.

### Revised recommendation

- **v1, no format change:** 7.1 in the viewer, 7.3 as the link convention, and the CLI accepting `<outer>/<path>` in `decrypt` (and `get`). Together they make "pathing into encrypted uploads" true wherever a key can be, which is the only place it can be true for the inner-CAR shape.
- **Follow-up, no format change:** 7.2, when agents want HTTP on localhost.
- **If gateway-native pathing or per-file sharing becomes a requirement:** 7.4, as a second profile selected at `add` time (`--encrypt` keeps the inner CAR, something like `--encrypt-per-file` writes the token directory). Decide then whether the count-and-size leak is acceptable for that user.
- **Never:** 7.5, 7.6, and any change to Kubo, Rainbow, or verified-fetch core.

The sentence for people stays as in §6, with one addition: "if you need gateway-native paths or want to share single files out of a folder, there is a per-file packaging we can switch on; it hides names but not how many files there are or how big they are."

## 8. Second pass: four models, zero-shot, checked against the gateways

Method. One abstract problem statement (`scratchpad/ideation-prompt.md`, reproduced in `pkg/pathing/README-ideation.md`): content-addressed storage, fixed gateway behaviour, fixed chunked AEAD, HKDF key tree, wants and constraints. None of §7 was in the prompt. Sent unchanged to Codex (`codex exec`, default model), Gemini 4 Argon High (`agy`), a fresh Claude Fable 5.1 session (`claude -p`), and Cursor's agent. Grok is not installed here. Raw answers are in the scratchpad (`ideation-codex.md`, `ideation-gemini.md`, `ideation-claude.md`). Every design below that we could test was tested; the rest is marked as reasoning.

### 8.1 Where the models converged

All three returned the same four families, under different names:

| Family | Codex | Gemini | Claude | In §7 as |
|---|---|---|---|---|
| Opaque-name directory tree or flat directory, one envelope per file, encrypted manifest | #1, #2 | #1, #2 | #1, #2 | 7.4 |
| One pack, per-file keys, encrypted index (ZIP central directory, git pack + idx) | #4 | #3 | #4 | none; new |
| A second UnixFS tree ("view") whose file nodes alias the pack's existing ciphertext blocks | #5 | #8 | #5 | 7.5, rejected too early |
| Padding, decoys, buckets, fixed-window reads, ORAM-style cover traffic | #7, #8, #10 | #2, #4 | #3, #7, #10 | none; modifiers |

Two ideas appeared once each and are the interesting ones: Claude's identity-CID virtual roots (#6) and Gemini's bootstrap page and Service Worker carried inside the upload ("overlooked" #2). Gemini's canonical dyadic DAG (#9) is the strongest at-rest privacy construction anyone proposed.

### 8.2 Verified today

**Identity-CID virtual file nodes** (Claude #6). A key holder builds a UnixFS file node over leaves that already exist on the network, encodes the node itself as a CID with the identity multihash, and asks the gateway for it. No structural block is stored or published anywhere; the share capability is the CID string plus the key. `pkg/pathing/identity-root.mjs`, `identity-limit.mjs`, against the outer CAR of `big.fee`:

| Gateway | Node | Result |
|---|---|---|
| Kubo 0.43.1 path gateway, `Range` | 2 leaves (1 MiB + 52 KB), 109-byte node, 182-char CID | 206, bytes match, including a range straddling the leaf boundary |
| Kubo | 1 leaf, 101-char CID | 206, bytes match |
| Kubo | 3 leaves and up (159-byte node) | 500 `digest too large: identity digest got 159 bytes, maximum 128` |
| Kubo, trustless `?format=car&dag-scope=entity&entity-bytes=0:999` | 1 leaf | 200, CAR with the leaf |
| frisbii v0.10.0 (Curio's `/ipfs/`), `?format=car&dag-scope=entity&entity-bytes=0:9` | 2 through 32 leaves (up to 1,610-byte node, 2,585-char CID) | 200 every time, CAR with the leaf |

So: on Curio-style trustless endpoints a virtual per-file root can span at least 32 outer leaves (32 MiB at 1 MiB leaves) in one URL; on Kubo and anything else built on boxo it spans two, so bigger files need a chain of two-leaf windows. Repeated links to the same leaf are accepted by both.

**Bootstrap page and Service Worker inside the upload** (Gemini). The outer object becomes a small directory: `index.html`, `sw.js`, and the envelope. The page registers the SW; the SW's default scope is its own directory, so it intercepts every request under `/<root>/`, including relative links from a decrypted site, and answers virtual paths by Range-reading the sibling envelope and decrypting. `pkg/pathing/sw-inside-upload.mjs`, Kubo 0.43.1, Range on the sibling file as a stand-in for decryption (the decrypting SW itself is verified in §7.1):

| Gateway style | Scope the SW obtained | `GET <scope>virtual/1048000-1049023` | Bytes match |
|---|---|---|---|
| Subdomain, `http://<root>.ipfs.localhost:8080/` | `http://<root>.ipfs.localhost:8080/` (own origin) | 200, upstream 206 `bytes 1048000-1049023/2000000` | yes |
| Path, `http://127.0.0.1:8080/ipfs/<root>/` | `http://127.0.0.1:8080/ipfs/<root>/` | 200, upstream 206 | yes |

This makes `https://<root>.ipfs.<gateway>/dir/file.ext` a real URL in an unmodified browser, served by code that travels with the data. The key arrives in the URL fragment, which the gateway never sees, or by paste. Not tested: service-worker gateways such as inbrowser.link, where the gateway already owns a Service Worker at `/` on the same origin and a second registration at the same scope would replace it; that case needs its own run before anyone relies on it. Also untested: how public gateways treat a directory whose `index.html` registers a worker (Kubo serves it; ipfs.io and dweb.link were not probed).

### 8.3 Reasoned, not tested

**One pack, per-file keys, encrypted index** (Codex #4, Gemini #3, Claude #4). Keep one opaque outer file, give every inner file its own FEE envelope under its own salt, and put an encrypted index in front or at the tail. Sharing one file becomes `(outer CID, offset, length, piece key)`, which Keysmith already expresses as a `piece:<salt>` grant plus a locator, and the network still learns total size only. Three of three models ranked this top three; Claude called it "two small edits to what ships today". The catch, which Gemini and Claude both raised unprompted: every FEE envelope starts with a cleartext COSE header carrying `typ`, `alg` and our `foc/*` labels, so a scan of the pack finds every file boundary and size. FRC-0120 has no headerless mode, so this design leaks count and sizes unless the pack is wrapped in a second, whole-pack envelope, which doubles decryption and means a per-file grant alone cannot open anything. With FEE as specified, per-file keys and "total size only" cannot both hold inside one pack.

**Overlay view with decoy links** (Gemini #8, refining Claude #5 and Codex #5). Lay the pack out so each inner file's chunks are whole outer leaves (256 KiB plus tag per leaf rather than the 1 MiB importer default). Publish the pack root as today. For the people you choose, also publish a flat directory of HMAC-named UnixFS file nodes, each listing its file's real leaves followed by decoy links to other real leaves of the same upload, padding every node to a size tier at zero bytes of stored padding. Gateways resolve `/<view>/<token>` natively with Range; a reader stops at the FEE `plaintext_length`. What it needs: per-file keys (and therefore the header leak above unless the view is the only way in), a custom DAG builder, and acceptance that anyone holding the view CID or scraping the provider sees the bipartite leaf graph. Both gateways accepted aliased and repeated leaf links in the identity tests, so the UnixFS side is not in doubt. This replaces 7.4 as the format-change candidate if gateway-native paths or per-file sharing become requirements: same native behaviour, but the pack root alone still reveals total size only.

**Canonical dyadic interval DAG with a GGM key tree** (Gemini #9). Every upload of N blocks produces the identical public DAG: file nodes for every power-of-two-aligned block interval, keys from a binary HKDF tree so any contiguous file or subtree is covered by at most 2 log N keys. Nothing beyond block count leaks at rest, and per-subtree shares are a handful of keys plus an interval. Too much machinery for a storage CLI today; worth remembering as the ceiling.

**Modifiers** everyone listed: Padmé padding (at most 12% overhead) to blur sizes, dummy entries to round counts, 1 MiB-aligned reads to blur access patterns, per-directory salts so the same name in two folders yields different tokens, and no content-defined chunking because chunk-size sequences fingerprint public files.

**Cursor's answer** arrived after the above was written (`ideation-cursor.md`, about 11 minutes). Same four families, ranked pack-plus-index first. Three points it alone made, all worth keeping:

- The header leak has a concrete fix shape: one 64-byte random-looking header for the whole pack, index pages as encrypted 256 KiB messages under the directory key, and per-file STREAM messages with **no header of their own**, their keys and salts living only in the encrypted index. That is "FEE envelope outside, headerless FEE-style streams inside", which is the exact ask to put to Jon and Natalie: a headerless sub-stream mode, or a blinded fixed-length header.
- A GCM message that straddles two files hands a per-file recipient the neighbour's plaintext, so per-file messages must start on their own message, short last chunk allowed, never padded to 256 KiB (6,000 small files padded that way is about 1.5 GiB).
- A CDN in front of the gateway that caches whole URLs and ignores `Range` inverts the single-pack advantage: every seek re-pulls the object. That is a question to ask of FilBeam before recommending Range-based reads through it; nothing here measured FilBeam.

**A leak the models caught that §1-§7 did not.** Codex: the cleartext key identifier in every envelope links all of a wallet's uploads together and to the wallet. In our envelopes that is `foc/own` and `foc/ks`. The data set owner is public on chain anyway, but an IPNI scrape of envelope headers gives the same join without touching the chain. Keysmith accepts this by design; it belongs in the "what the network learns" line of any user-facing doc.

### 8.4 Recommendation, third pass

- **v1 as shipped**, plus 7.1 and 7.3. Nothing from this pass changes that.
- **v1.1, verified today, no format change on the wire for the envelope:** ship the bootstrap page and Service Worker inside the upload (8.2). The outer root becomes a three-entry directory. Any subdomain or path gateway then serves `https://<root>.ipfs.<gateway>/dir/file.ext` with Range, with no viewer deployment to fund and no plugin. Test inbrowser.link first, since that is the gateway the v0 doc leans on.
- **Per-file sharing of a single file from a folder:** possible today over Curio's trustless endpoint with an identity-CID virtual root (8.2) once files have their own keys, and over Kubo-style gateways in two-leaf windows. It is blocked by the FEE header leak (8.3) until either FRC-0120 gains a headerless or blinded-header mode, or the product accepts that a per-file-keyed pack reveals file count and sizes. That is a question for Natalie and Jon, with a concrete ask: a fixed-length, random-looking header variant.
- **If gateway-native paths without the key holder's own code ever become a requirement:** the overlay view with decoy links (8.3), not the flat token directory of 7.4.

## 9. Follow-ups on 2026-10-21: the header question, and a demo to share

### 9.1 Is the FEE header leak a FEE problem or a packing problem?

A packing problem. FRC-0120 "Metadata confidentiality": "Protected and unprotected headers are visible without the decryption key. This is by design (enabling keyless inspection)", and the remedy it names is "apply an outer encryption layer". One envelope per piece, which is what #771 writes and what Keysmith and Curio's gating depend on, discloses exactly what the design intends: algorithm, chunk size, plaintext length, content type, and the `foc/*` labels. The leak only appears if several envelopes are concatenated inside one object that is supposed to look opaque.

Measured (`pkg/pathing/pack-scan.mjs`): four envelopes of 1,000, 300,000, 7,777 and 2,000,000 random bytes concatenated into one 2,309,521-byte pack. A scanner with no key that searches for the mandatory `typ` string `application/vnd.filecoin-encryption+cose` finds four hits, re-parses each envelope from the hit backwards, and recovers every boundary (1153, 301324, 309254), every size, and every label, including each file's `foc/salt`. So "per-file keys inside one pack" needs either an outer envelope around the pack (then a per-file grant alone opens nothing) or a FEE variant without a per-stream header. Nothing in FEE as published needs fixing for the current one-envelope-per-piece use.

### 9.2 The demo: `pkg/pathing/demo/`

A self-contained upload: `index.html`, `page.js`, `sw.js`, `encrypted.fee`. The envelope is produced by the #772 worktree's own `encryptPath` and `newPieceKey`, so it is exactly what `filecoin-pin add --encrypt` writes, with Keysmith labels for Anvil key #0. The folder inside has five files including a 12-second faststart video and a 4 MiB binary. The key travels in the URL fragment.

Two modes, chosen by the page: a Service Worker scoped to the directory (real URLs, Range, `<video>` seeking) on gateways without their own worker; in-page decryption to blob URLs on service-worker gateways such as inbrowser.link. Both were verified in headless Chrome against Kubo 0.43.1 (`pkg/pathing/demo/verify.mjs`, results in `pkg/pathing/demo/README.md`): README text, a 1 KiB Range at offset 3,000,000 in the binary, the SVG content type, and a video seek to 11.5 s all check out in both modes.

Published to calibration on 2026-10-21 (data set 54, provider 4, one copy; the second copy failed because data set 85 no longer exists on provider 5). A first build had a popup-blocker bug in in-page mode (the tab was opened after an `await`); a second build added a visible status line, dropped the HEAD request, and tolerates a gateway answering a Range with the whole object; the link below is that build, same envelope and key:

```
https://bafybeibwsb3glwnpistjikdphweeflloxl6tvqojvp2m3wnnplq347t27a.ipfs.inbrowser.link/#k=<piece key>
```

Verified in headless Chrome against the real inbrowser.link: the page is controlled by the gateway's own worker, so it chose in-page mode; README text, the 1 KiB Range at offset 3,000,000, the SVG and a video seek to 11.5 s all matched. Two things seen on the way: the first load waits while inbrowser.link pulls the envelope block by block from the calibration provider (about a minute here), and once inbrowser.link has fetched the whole file a later `Range` request on it comes back as a 200 with the whole body, which matches Natalie's note in the v0 doc; a viewer that wants partial reads must avoid ever requesting the whole object through that gateway.

### 9.3 The rebuilt demo (after §10's review)

`pkg/pathing/demo/`, rebuilt to the two claims agreed on 2026-10-21: the format is invisible and harmless to existing clients, and a key holder using our reader keeps folders, names, paths and ranges without downloading everything. One page, two columns, no Service Worker. Fixture: 5,004 files (5,000 in a HAMT-sharded directory, a 24 MiB binary, a 12 s clip), 24.9 MiB envelope, 332 KB of directory index, inner folder CID equal to a plain `add` (checked at build).

Published to calibration, two copies: provider 4 / data set 54 and provider 9 / data set 918 (added separately with `--copies 1 --provider-id 9` after provider 4's commit wait kept timing out and an old provider-9 data set refused the piece):

```
https://bafybeicwqxmtog6r3xxthjptnpddoya3qlf5n5hz46shznr5eex5n5tw2q.ipfs.inbrowser.link/#k=<piece key>
```

A follow-up build moved the status line to the top with an elapsed timer and fixed the phone layout (the first one overflowed sideways on iOS Safari and looked stuck during the cold wait). Measured on inbrowser.link in headless Chrome (`pkg/pathing/demo/verify3.mjs`): 85 to 93 s to the first file on a cold gateway, then

| Action | Requests (cumulative) | Bytes of 24.9 MiB |
|---|---:|---:|
| header, folder index (bounded 1 MiB read, cancelled at 576 KiB), open `many/f4321.txt` through two HAMT shard levels | 3 | 836 KiB |
| read 64 KiB at offset 12 MiB of `data/big.bin` | 4 | 1.1 MiB |
| open `docs/notes.txt` | 5 | 1.3 MiB |

Left column on the same gateway: `Range: bytes=0-1023` on the envelope → 206; `?format=raw` → 200 raw block; `encrypted.fee/docs/notes.txt` → 502 (Kubo: 404 `no link named`). On local Kubo the same run costs 3 / 1.3 MiB, 4 / 1.5 MiB, 5 / 1.8 MiB, because Kubo streams the whole 1 MiB index read before the cancel lands.

The bounded index read lives in our reader only. Existing clients never read inside the ciphertext, so nothing about them changes; the earlier full pull was our reader asking a service-worker gateway for an open-ended Range, which that gateway satisfies by fetching every block first.

## 10. Demo review, 2026-10-21: four models on what the demo should show

Prompt in the scratchpad (`demo-review-prompt.md`): Jon's question verbatim, the seven measured facts, the demo as built, and Russell's reaction. Answers from Codex, Gemini 4 Argon, a fresh Claude Fable session, and Cursor's agent. They agree on every point below.

**Verdict.** As linked (inbrowser.link over a calibration provider) the demo argues Jon's side: the in-upload worker never runs there, the page pulls the whole 4 MB envelope, decrypts in memory and hands out blob links, so the viewer sees all-or-nothing, a one-minute wait and, in Safari, a blank tab. The prefilled key hides the "special knowledge". Nothing on screen shows a Range request, a byte count, or the gateway's own failure, so there is no contrast. The five-link list reads as a zip extractor.

**Root cause of the full pull.** The reader opens the folder index with an open-ended Range from byte 0 and cancels once the directory nodes have arrived. Kubo streams and the cancel works; inbrowser.link fetches every leaf an open-ended Range covers before answering. Bounded index reads (first 1 MiB, grow if needed) fix this. Through inbrowser.link the read granularity is then one 1 MiB leaf, through Kubo one 256 KiB chunk.

**The screen that answers the question.** Same ciphertext file, two panels. Left, gateway without key: the live response to `/ipfs/<envelope cid>/docs/notes.txt` (Kubo 404, verified-fetch 502, frisbii 200 with only the root block) and the only plaintext the gateway holds, size plus the FEE header fields. Right, reader with key: the decrypted tree, the opened file rendered inline, and two lines that update on their own, the bounded index Range and the chunk-aligned file Range, with a counter `2 requests, N of M bytes`. A chunk map that lights only fetched chunks; the large files stay grey. Video with `preload=none`, served through a Range-capable path so a seek appends exactly one Range line; a blob video proves nothing. The key entered as a visible step.

**Lead with the reader, not the worker.** The reader over the bare envelope CID is what speaks to Jon: the special knowledge is the key, the FEE framing, the metadata-first inner CAR, and the chunk-offset arithmetic; no inner CID is ever fetched. The in-upload worker is the same resolver behind a URL on Kubo-style gateways and goes on a second tab with the 404 left up, otherwise viewers believe IPLD grew paths and Jenni hears a gateway project.

**Cut.** The prose paragraph, the log as evidence, the SVG, auto-loading media, blob popups, the identity-CID trick, and the per-file FEE header critique (a comment on Jon's library, not for his demo).

**Wording to fix.** "Unmodified public infrastructure" means any Range-honouring gateway in front of the provider; Curio's `/ipfs/` ignores Range and is all-or-nothing on its own. "One chunk per seek" is one or two. "The URL works" is after a first visit to the page on that origin. The 2 requests / 560 KB figure belongs to the 6,000-file fixture and must not be quoted over a 5-file one. The pack is opaque about names and inner sizes only; size and header fields are public, and one key opens the whole tree. Russell's own question has its answer: yes, there is a FEE + UnixFS pathing profile, three app-side conventions that no gateway reads.

**Three sentences the rebuilt demo must produce.** Jon: inner nodes still have no fetchable CID; with the key and the chunk layout the app resolves a path as two Range reads of the one public file. Natalie: a path in the address bar is our JavaScript; stock gateways still hold one file and still fail the subpath. Jenni: no Kubo, Rainbow or verified-fetch change, and no protocol profile; the behaviour is in the app we already ship.

## Appendix: what was not verified

- Rainbow and inbrowser.link were not run; both use boxo's gateway code, so the 404 is expected but unmeasured.
- Curio itself was not run. The `/ipfs/` results come from frisbii v0.10.0 built from the exact module Curio pins; the `/piece/` Range path is read from `piecehandler.go`, and its request and byte counts are computed from the CAR layout, not measured.
- FilBeam egress was not considered.
- The bench numbers (2 requests, 560 KB) are from the 2026-10-15 runs against a local Kubo gateway (README lines 197-203); they were not re-run today. The Service Worker directory-path run in §7.1 was done today.
- §8: inbrowser.link and public gateways were not probed for the in-upload Service Worker; the per-file-key pack and the overlay view were reasoned from the measured gateway behaviour, not built. Cursor's answer arrived late and is folded into §8.3; FilBeam's Range behaviour, which it raised, was not probed.
