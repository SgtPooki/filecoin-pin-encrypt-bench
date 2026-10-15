### Recommendation

**Adopt CAR-in-envelope NOW before the first release.** Do not ship raw payloads first. 

Because no envelopes exist in the wild yet, shipping raw now would permanently bind CLI decryptors and web viewers to legacy dual-mode support on immutable, paid Filecoin storage. However, **be skeptical of the teammate’s assumption that the only cost is "unpacking a CAR"**: CAR-in-envelope introduces severe streaming and browser memory bottlenecks for ~1 GiB files that must be designed around now, not deferred.

---

### 1. Pros & Cons Analysis

* **Privacy & Metadata**: **CAR wins.** [`encryptFileWithPassword`](file:///Users/sgtpooki/code/work/filoz/filecoin-project/filecoin-pin-decrypt/src/common/encryption.ts#L49-L66) leaves raw filenames out of `appMetadata` because FEE header metadata is unencrypted/public. Raw payloads lose filenames entirely. Inner CARs preserve filenames and directory structures inside the ciphertext. Both leak total ciphertext size.
* **Directory Support & CLI UX**: **CAR wins.** Enables multi-file directory bundles. Decrypt restores original filenames automatically instead of forcing the user to provide an explicit output filename ([`runDecrypt`](file:///Users/sgtpooki/code/work/filoz/filecoin-project/filecoin-pin-decrypt/src/decrypt/decrypt.ts#L10-L35)).
* **Browser Feasibility & Memory (~1 GiB files)**: **Raw wins / CAR hazard.** In [`createCarFromPath`](file:///Users/sgtpooki/code/work/filoz/filecoin-project/filecoin-pin-decrypt/src/core/unixfs/car-builder.ts#L49-L66), Helia builds CARs bottom-up, writing the root directory block at the very **end**. A browser cannot resolve the root CID or directory structure until EOF. Buffering a decrypted ~1 GiB CAR into browser memory before unpacking will crash mobile and tab heaps.
* **Streaming & Range Playback (MP4s)**: **Raw wins.** FEE supports `decryptRange`, mapping directly to byte offsets for HTML5 video range requests on gateways. In CAR, UnixFS chunking and CAR framing destroy 1:1 byte offset mapping; range playback for large media becomes infeasible without a pre-computed index or full download.
* **Ecosystem Interop**: **CAR wins.** Plaintext is standard IPLD, inspectable by `@ipld/car`, Kubo, or Helia once decrypted.
* **Implementation Cost**: **Moderate.** Requires adapting [`createCarFromPath`](file:///Users/sgtpooki/code/work/filoz/filecoin-project/filecoin-pin-decrypt/src/core/unixfs/car-builder.ts#L49-L66) to force a wrapping directory and piping decrypted streams through a CAR unpacker.

---

### 2. Now vs. v1

**Do not ship raw first.** Uploads to Filecoin are immutable and paid. Any envelope format released into production persists forever. Shipping raw payloads now means every future decryptor must support both formats forever, requiring format sniffing. Since the release is currently held, there is zero backward-compatibility baggage today—fix the format now.

---

### 3. Alternatives & Improvements

* **Tar / Custom Encrypted Headers**: A tar stream places headers first (enabling single-pass extraction), but introduces non-IPLD containers into an IPFS-native tool, violating the project’s design philosophy.
* **DFS / Root-First CAR Order**: If the inner CAR writer is adapted to emit the root block first, streaming decryptors can parse directory entries immediately without buffering to EOF.
* **Self-Describing Header**: Setting the FEE header's public `content_type` to `application/vnd.ipld.car` makes envelopes self-describing across the ecosystem while leaking only that the payload is a CAR.

---

### 4. Mandatory Profile Specifications

If adopted now, pin down these rules so a format migration is never needed:

1. **Self-Describing Envelope**: Set FEE `content_type: "application/vnd.ipld.car"`. Include `"version": 1` in `app_metadata` alongside `{ kdf, iterations, salt }` (see [glossary.md](file:///Users/sgtpooki/code/work/filoz/filecoin-project/filecoin-pin-decrypt/documentation/glossary.md#encrypted-upload)).
2. **Canonical Inner Wrapper**: Mandate that the inner CAR **always** contains a single root UnixFS directory (even for single files: `<dir>/<file>`), pinned to the [`unixfs-v1-2025`](file:///Users/sgtpooki/code/work/filoz/filecoin-project/filecoin-pin-decrypt/documentation/glossary.md#unixfs-v1-2025-profile) profile.
3. **Safe Unpack Semantics**: Define strict unpack rules: reject path traversal (`../`, absolute paths), restore relative hierarchy, enforce `0600`/`0700` permissions, and fail on destination collisions.
4. **Browser Memory Mitigation**: Specify that browser viewers must not buffer raw CARs in memory; stream decrypted chunks directly into OPFS (Origin Private File System) or an IndexedDB blockstore before extraction.
