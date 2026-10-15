# Inputs (not committed, ~15 GB)

Regenerate from the repo root. `media/bbb_sunflower_2160p_60fps_normal.mp4` is Big Buck Bunny 4K60 (673,223,862 bytes,
https://download.blender.org/demo/movies/BBB/bbb_sunflower_2160p_60fps_normal.mp4.zip).

```sh
cd inputs
# 4.5 GB playable MP4: 7x concat, first audio track to AAC, faststart (above 2^32 bytes on purpose, see FINDING-unixfs-uint64.md)
for i in 1 2 3 4 5 6 7; do echo "file '$PWD/../media/bbb_sunflower_2160p_60fps_normal.mp4'"; done > concat7.txt
ffmpeg -f concat -safe 0 -i concat7.txt -map 0:v:0 -map 0:a:0 -c:v copy -c:a aac -b:a 160k -movflags +faststart bbb_4g5.mp4
# the 3.9 GB variant that triggers #773 (6x concat) is bbb_4g.mp4, same command with 6 lines and default audio
head -c $((1024*1024*1024)) /dev/urandom > rand_1g.bin
head -c $((5*1024*1024*1024)) /dev/urandom > rand_5g.bin
# dedup: 1 MiB random block repeated, every 5th MiB unique
head -c 1048576 /dev/urandom > /tmp/blk; : > dedup_512m.bin
for i in $(seq 1 512); do if [ $((i % 5)) -eq 0 ]; then head -c 1048576 /dev/urandom >> dedup_512m.bin; else cat /tmp/blk >> dedup_512m.bin; fi; done
# bundle: 300 small + 50 medium files, a 200 MB binary, the video, empty file and dir, a long Unicode name, 3 symlinks
mkdir -p bundle/docs/nested/deeper bundle/assets bundle/docs/empty_dir
for i in $(seq 1 300); do head -c $((RANDOM % 4000 + 100)) /dev/urandom > bundle/docs/small_$i.txt; done
for i in $(seq 1 50); do head -c $((RANDOM * 10 + 5000)) /dev/urandom > bundle/docs/nested/mid_$i.dat; done
head -c 200000000 /dev/urandom > bundle/assets/large.bin; cp ../media/bbb_sunflower_2160p_60fps_normal.mp4 bundle/assets/video.mp4
head -c 5000 /dev/urandom > "bundle/docs/nested/deeper/Résumé – 履歴書 – 🚀 very long unicode filename that keeps going and going to exceed one hundred bytes.txt"
: > bundle/docs/empty.txt
ln -s ../assets/large.bin bundle/docs/link_to_large.bin; ln -s /etc/passwd bundle/docs/evil_abs_link; ln -s ../../../../../../tmp bundle/docs/evil_rel_link
# HAMT-sized directory
mkdir manyfiles && for i in $(seq 1 6000); do head -c 1024 /dev/urandom > manyfiles/f$i.bin; done
```
