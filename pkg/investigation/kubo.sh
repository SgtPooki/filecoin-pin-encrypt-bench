#!/bin/sh
export IPFS_PATH="$PWD/investigation/kubo-repo"
KUBO=/Users/sgtpooki/.npm/_npx/35ef1729bf3685f9/node_modules/kubo/kubo/ipfs
set -x
"$KUBO" version
"$KUBO" init --profile=test
for f in investigation/block-*; do
 case "$f" in *bafk*) codec=raw;; *) codec=dag-pb;; esac
 "$KUBO" --offline dag put --input-codec="$codec" --store-codec="$codec" "$f"
done
for f in investigation/good.pb investigation/fill-0.pb investigation/1025MiB.pb investigation/3891799298.pb investigation/2049MiB-subtree.pb ../work/dbg/root.bin; do
 cid=$("$KUBO" --offline dag put --input-codec=dag-pb --store-codec=dag-pb "$f")
 "$KUBO" --offline files stat "/ipfs/$cid"
done
