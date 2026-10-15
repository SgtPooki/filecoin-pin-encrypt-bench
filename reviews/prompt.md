You are being invoked as a reviewer. Provide YOUR OWN review directly. Do NOT delegate by invoking other peer-review CLIs (cursor, codex, gemini, claude) — you ARE the reviewer, not a dispatcher. File-inspection tools (Read, Glob, Grep, Bash for read-only commands like git/ls/cat) are EXPECTED and encouraged — use them to ground your review in actual code. Do not modify any files.

# What to review

A design decision for password-protected uploads in filecoin-pin (a CLI that packs files into UnixFS CARs and stores them on Filecoin). Give a pros/cons analysis and a recommendation: adopt the proposal NOW (before the first release) or in a later v1, or not at all. Be concrete and skeptical; call out anything we are missing.

## Current design (open PRs, not released)

- PR #771 `filecoin-pin add <file> --encrypt`: derive a 32-byte key with PBKDF2-SHA256 (600k iterations, 16-byte random salt) from a password; stream the RAW FILE BYTES through Filecoin Encryption Envelope (FEE, npm `filecoin-encryption-envelope`, chunked AES-256-GCM, COSE header) into a temp file named `encrypted.fee`; pack that file as a single-file UnixFS CAR and upload. Envelope `app_metadata` = `{ kdf: "pbkdf2-sha256", iterations: 600000, salt: "<base64>" }` and nothing else (no filename, no plaintext CID, no content_type). Directories are rejected. Piece metadata `name` is `encrypted.fee` so the original filename never goes on-chain.
- PR #772 (stacked) `filecoin-pin decrypt <file> <output>`: decrypts the local envelope back to the raw file (refuses to overwrite, 0600, cleans up on failure, validates kdf/iterations before deriving).
- Release is held until both land, so NO envelopes exist in the wild yet.
- Planned consumers: a browser viewer (fetch by IPFS root CID, prompt for password, decrypt with WebCrypto), and agent "publish/share" skills that hand back a link + password. Shares today include single HTML/MD/MP4 files (up to ~1000 MiB) and whole directories as one "bundle" link.

## The proposal (teammate's review comment on #771)

"What if we encrypt a CAR instead of the raw file, so the order becomes CAR(envelope(CAR))?
1. Build a CAR from the input, always with a wrapping directory (even for one file).
2. Encrypt that CAR.
3. Pack the envelope as encrypted.fee, exactly like today.
What we gain: Folders work. Filenames survive. They're inside the encrypted CAR, so they stay private, and decrypt and the viewer can restore them instead of sniffing the type and guessing a name.
Nothing changes on the outside: the same root CID [shape], gateway fetch and appMetadata. The cost is that decrypt and the viewer need to unpack a CAR. I was planning to do this for v1."

## Facts already established (verify in code if you doubt them)

- FEE is payload-agnostic: plaintext is opaque bytes; header has optional public `content_type` (media type) and opaque authenticated `app_metadata`; header metadata is public (readable without the key). So CAR-inside is a filecoin-pin application profile, not a FEE change. Setting content_type `application/vnd.ipld.car` would make envelopes self-describing to any FEE tool, revealing only "it's a CAR".
- If raw-payload envelopes ship first, every decryptor must support both payload formats forever (uploads are immutable, paid storage), needing a marker to distinguish them.
- filecoin-pin's CAR writer produces complete CARs that are NOT strictly depth-first traversal order (per a maintainer). Unpacking a file out of such a CAR needs the whole CAR or an index (random access), so streaming/range playback (FEE supports authenticated range decryption, `decryptRange`) no longer maps to file offsets for the inner file.
- Deps already present: @ipld/car, @helia/unixfs, ipfs-unixfs-exporter (transitive). Single files are normally packed WITHOUT a wrapping directory (IPIP-499 unixfs-v1-2025 profile); the proposal needs a wrapper for the inner CAR.

## Code to read

- src/common/encryption.ts (encrypt/decrypt/password helpers), src/add/add.ts (runAdd, --encrypt path), src/decrypt/decrypt.ts, src/commands/decrypt.ts
- src/core/unixfs/car-builder.ts (createCarFromPath, single file vs directory), src/core/car/ (CAR handling)
- documentation/glossary.md ("Encrypted Upload" entry), documentation/retrieval.md

## Questions to answer

1. Pros and cons of CAR-in-envelope vs raw-in-envelope, for: privacy/leakage (sizes, structure, filenames), browser viewer feasibility and memory for ~1 GiB files, streaming/range playback, CLI decrypt UX, directory support, format stability/ecosystem interop, implementation cost.
2. Now vs v1: is there any good reason to ship raw payloads first? What does each path cost later?
3. Anything better than both (e.g. raw payload + filename in encrypted form somewhere, a tar/other container, writing the inner CAR in DFS order, content_type marker)?
4. If adopted now, what must the payload profile pin down (wrapper semantics, how decrypt/viewer pick the output, content_type, versioning) so it never needs a second format?

Keep it under ~600 words. Lead with your recommendation.
