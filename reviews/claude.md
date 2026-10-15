**Recommendation: adopt CAR-in-envelope now, with the profile pinned below.** Shipping raw first buys nothing except a permanent second decode path. Everything verified against `src/common/encryption.ts`, `src/add/add.ts`, `src/decrypt/decrypt.ts`, `src/core/unixfs/car-builder.ts`, and FEE 0.1.0 types (`contentType`, `decryptRange` present).

**Why a container is unavoidable.** FEE has no private header slot. `appMetadata` is authenticated but public, so a filename can only live inside the ciphertext. Raw payload therefore means filename loss forever, and the viewer sniffing types. Any fix later is a new format.

**CAR vs raw**

- **Privacy:** equal. Both leak total plaintext size via ciphertext length. CAR adds ~40 bytes per MiB and hides filenames, file count, and structure. `content_type` reveals only "a CAR", and the kdf metadata already identifies filecoin-pin.
- **Directories and filenames:** CAR wins outright. Also preserves plaintext CIDs, so decrypt and the viewer can verify content, not just the envelope.
- **Viewer:** CAR wins on code reuse. The viewer must already render UnixFS roots for unencrypted bundles. Decrypt to a blockstore and feed the same renderer. One path, not two.
- **Memory at 1 GiB:** CAR loses today. Blocks are not DFS ordered, so the viewer needs the whole CAR before exporting. Ciphertext plus CAR plus extracted bytes is ~3x in memory. Mitigation is OPFS or an indexed reader, viewer-side, no format change.
- **Range playback:** raw wins. `decryptRange` maps directly to MP4 offsets. CAR-inside needs an index. A CARv2 inner payload fixes this later if the profile allows CARv2 from day one. Do not require DFS order in the profile. It is a writer property, hard to guarantee, and an index is the real answer.
- **CLI decrypt UX:** CAR costs ~100 lines: envelope to temp CAR, then export with the deps you already have.
- **Implementation:** add side is one `wrapWithDirectory` plus stat the temp CAR for `contentLength`. Two temp files instead of one.

**Now vs v1.** The only reason to ship raw first is calendar time, and the delta is small. The viewer does not exist yet, so its cost is identical either way. Raw first costs a marker, dual decoders forever, and immutable paid uploads with lost filenames.

**Alternatives.** Tar streams better and maps ranges trivially, but it is a second rendering path in the viewer and drops CIDs. Reject. Raw plus encrypted filename requires custom inner framing, which is a new format anyway. Reject. Setting `content_type` is free and worth doing regardless.

**Profile to pin**

1. `contentType` = `application/vnd.ipld.car`. Decryptors reject anything else. A future change gets a new content type, no version field needed.
2. Payload is a complete CAR, v1 or v2, exactly one root. Allowing v2 now keeps the range-playback door open.
3. Root is an anonymous UnixFS directory, basic or HAMT. Its direct children are exactly what the user passed: one file entry, or one directory entry keeping its name. Today `add dir/` loses the dir name; the wrapper fixes that uniformly.
4. `decrypt <file> <output>` creates `<output>` as a directory and writes the wrapper's children into it. No single-file special case. Viewer rule: one child that is a file renders directly, otherwise show a listing.
5. `appMetadata` unchanged. Nothing about the payload goes in public metadata, including the plaintext root CID.
6. Piece metadata `name` stays `encrypted.fee`. The outer CAR remains a single file without a wrapper.

**Missing from the proposal.** The `--encrypt` CAR-input fix in 7c285ed becomes moot, since a CAR input is just a file entry inside the wrapper. Empty directory input yields a root with no children, which decrypt should accept. Streaming large shares in the browser needs a plan before the viewer ships, and CARv2 plus OPFS is that plan.
