# Goal: pick the encrypted-upload payload format

Choose what goes inside the FEE envelope for `filecoin-pin add --encrypt`, backed by runtime numbers,
so that one format works for every media type (video, large binaries, directories, dedup-heavy data).

## Hard stops
1. No public-facing changes: no PR edits, no pushes, no comments, no Slack. Report only.
2. Do not stop until every fact below is proven at runtime (or the blocker is documented).

## Facts to prove (each labeled runtime / source in the report)

Per candidate (raw, root-first UnixFS CAR + wrapping dir, tar):
- F1 encrypt side: wall time, throughput, peak RSS, peak temp disk, and whether plaintext touches disk (mode + dir) for 673 MB video, ~4 GB video, 1 GiB random, ~5 GiB random, dedup file, directory bundle.
- F2 size overhead: envelope and outer CAR vs input.
- F3 full streaming decrypt from the local gateway: time, peak RSS, sha256 match, and that it is single-pass with bounded memory.
- F4 random seeks over HTTP Range + `decryptRange`: time to first byte, bytes fetched per seek, correctness at 20 offsets incl. tail, including a >1024-chunk file (intermediate dag-pb nodes).
- F5 directories: list, extract one file, full extract, path traversal and symlink safety; long UTF-8 names.
- F6 browser: Service Worker answering `<video>` Range requests via `decryptRange`, Google Chrome via Playwright, time to first frame, seek latency at 10/50/90 percent, memory, full playback of the ~4 GB file.
- F7 production without plaintext temp files, or exact location and permissions of any that exist.

Decision facts:
- D1 one profile pinned: container, block ordering, wrapper semantics, `content_type`, versioning marker in `appMetadata` or not, decrypt CLI output semantics, viewer rules, path/symlink safety.
- D2 pros and cons table per format per media type, with the failure modes that disqualify a format.
- D3 whichever format wins, the losing formats' advantages are either matched or explicitly accepted as a cost.

## Done
`bench/REPORT.md` exists with all facts above, numbers, and a single recommendation. Then check in before any PR change.
