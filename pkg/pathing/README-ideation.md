You are a systems designer with deep knowledge of cryptography, content-addressed storage, encrypted filesystems, media streaming, and HTTP caching. Think widely across domains before answering. This is a design exploration, not a code review. Do not run tools; answer from knowledge.

# Problem

A storage network addresses objects by content hash (think IPFS: an object is a Merkle DAG; a "directory" is a node mapping names to child hashes; a "file" is a node listing fixed-size chunk hashes with sizes). Public HTTP gateways everywhere already implement two things over this DAG, and we cannot change them:

1. Path resolution: `GET /<root-hash>/dir/file.ext` walks named links through directory nodes and returns the file's bytes. A path segment under a file is an error.
2. Byte ranges: `GET /<file-hash>` with an HTTP `Range` header returns the requested slice of the file's bytes. "Trustless" variants return the exact DAG blocks covering a byte range instead, so the client can verify them.

Gateways cache aggressively and serve whatever bytes they hold to anyone. Indexers publish which hashes exist. Nothing in this infrastructure can hold a decryption key or be modified by us.

We store user data encrypted. The encryption primitive is fixed: an authenticated chunked stream cipher (AES-256-GCM in 256 KiB chunks, STREAM construction, like age or Tink), so a holder of the content key can decrypt any chunk independently given its index, and a short cleartext header names which key to use. Keys are derived per object from a wallet signature through an HKDF tree (keyspace -> optional scope -> per-object salt), and a key for one node of that tree can be handed to a recipient as a grant.

Today we upload one object: an encrypted container that holds a whole file *or a whole directory tree* (names, structure and bytes all inside the ciphertext). From the network's point of view it is one opaque file. Consequences:

- `GET /<root>/dir/file.ext` fails at every gateway: the path exists only inside the ciphertext.
- A key holder can still get any file inside cheaply: read a small plaintext index at the start of the container, map the file to chunk indexes, fetch those chunks with `Range`, decrypt. Two HTTP requests for a small file in a 6000-file tree. But only a client that knows our container format can do it.
- Sharing one file out of the tree is impossible without handing over the key to the whole container.
- The only thing the network learns is the total ciphertext size.

# What we want

Find designs that make `dir/file.ext` inside an encrypted upload addressable and range-fetchable through the unmodified public infrastructure above, by a client holding the right key, with:

- no plugins, no changes to gateways, indexers, or the encryption primitive;
- names and tree structure hidden from everyone without a key (at minimum: not recoverable, ideally: not even confirmable);
- as little as possible leaked beyond total size (file count, per-file sizes, access patterns, dedup relations are all leaks worth naming);
- a single uploaded object, or a justified small number;
- efficient random access (requests and bytes for "one small file out of thousands" and "seek inside a large video");
- the ability to share one file, or one subtree, without sharing everything;
- deduplication of repeated content across files is nice to keep, not required.

# What to produce

1. At least eight distinct designs. Pull from analogous systems and say which: encrypted filesystems (gocryptfs, CryFS, EncFS, eCryptfs), Tahoe-LAFS and Keybase KBFS, Perkeep, git packfiles and multi-pack indexes, encrypted ZIP central directories, HLS/DASH encrypted media with byte-range playlists, CDN cache-key tricks, oblivious data structures and ORAM, searchable or deterministic encryption of names, Merkle-tree sidecars, content-defined chunking, anything else that fits. Include at least two designs you consider unusual or novel.
2. For each design, in this order: mechanism in a few sentences; what the gateway does on `GET /<root>/<something>` and on a Range request; what the key holder does; what leaks; cost in uploads, storage overhead, and requests per random access; what breaks (dedup, sharing granularity, streaming, big trees).
3. A comparison table across all designs with these columns: gateway-native path, gateway-native range, names hidden, structure hidden, count and sizes hidden, dedup kept, per-file share, extra objects, overhead.
4. Your top three, ranked, with one paragraph each on why, and the single biggest risk of each.
5. Anything we have likely overlooked: an attack on the obvious designs, a cheap trick that makes a weak design strong, or a reason the whole goal is misguided.

Be concrete. Prefer numbers to adjectives. Short sentences. No preamble.
