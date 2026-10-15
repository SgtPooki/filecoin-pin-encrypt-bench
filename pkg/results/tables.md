### Encrypt side (two-pass CAR builds, no plaintext temp file for any format)

| input | fmt | input MB | envelope MB | overhead | plan/pass1 ms | encrypt ms | total ms | GB/s | peak RSS MB |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| video673 | car | 673 | 673 | 0.01% | 491 | 771 | 1351 | 0.50 | 196 |
| video673 | raw | 673 | 673 | 0.01% | 0 | 334 | 423 | 1.59 | 240 |
| video673 | tar | 673 | 673 | 0.01% | 1 | 317 | 406 | 1.66 | 212 |
| video4g5 | car | 4542 | 4542 | 0.01% | 3203 | 5159 | 8450 | 0.54 | 289 |
| video4g5 | raw | 4542 | 4542 | 0.01% | 0 | 2638 | 2725 | 1.67 | 1406 |
| video4g5 | tar | 4542 | 4542 | 0.01% | 1 | 2139 | 2229 | 2.04 | 338 |
| rand1g | car | 1074 | 1074 | 0.01% | 768 | 1228 | 2084 | 0.52 | 215 |
| rand1g | raw | 1074 | 1074 | 0.01% | 0 | 515 | 603 | 1.78 | 304 |
| rand1g | tar | 1074 | 1074 | 0.01% | 1 | 479 | 568 | 1.89 | 263 |
| rand5g | car | 5369 | 5369 | 0.01% | 3825 | 6325 | 10239 | 0.52 | 299 |
| rand5g | raw | 5369 | 5369 | 0.01% | 0 | 3056 | 3145 | 1.71 | 904 |
| rand5g | tar | 5369 | 5369 | 0.01% | 1 | 2672 | 2761 | 1.94 | 246 |
| dedup512m | car | 537 | 108 | -79.88% | 390 | 147 | 626 | 0.86 | 186 |
| dedup512m | raw | 537 | 537 | 0.01% | 0 | 306 | 394 | 1.36 | 289 |
| dedup512m | tar | 537 | 537 | 0.01% | 1 | 263 | 351 | 1.53 | 211 |
| bundle | car | 882 | 882 | 0.02% | 653 | 1047 | 1788 | 0.49 | 315 |
| bundle | tar | 882 | 882 | 0.04% | 10 | 469 | 567 | 1.56 | 247 |

### Streaming decrypt from the local gateway (single pass, CLI style)

| input | fmt | decrypt ms | GB/s | first plaintext ms | list ms | peak RSS MB | bytes match |
|---|---|---:|---:|---:|---:|---:|---|
| video673 | car | 1304 | 0.52 | 127 | 12 | 234 | yes |
| video673 | raw | 788 | 0.85 | 119 |  | 211 | yes |
| video673 | tar | 784 | 0.86 | 118 | 120 | 215 | yes |
| video4g5 | car | 9814 | 0.46 | 122 | 30 | 304 | yes |
| video4g5 | raw | 4338 | 1.05 | 117 |  | 231 | yes |
| video4g5 | tar | 4503 | 1.01 | 118 | 119 | 245 | yes |
| rand1g | car | 2067 | 0.52 | 117 | 12 | 240 | yes |
| rand1g | raw | 1175 | 0.91 | 118 |  | 215 | yes |
| rand1g | tar | 1146 | 0.94 | 119 | 120 | 217 | yes |
| rand5g | car | 10300 | 0.52 | 118 | 33 | 294 | yes |
| rand5g | raw | 5556 | 0.97 | 119 |  | 249 | yes |
| rand5g | tar | 5131 | 1.05 | 117 | 119 | 239 | yes |
| dedup512m | car | 463 | 1.16 | 119 | 8 | 200 | yes |
| dedup512m | raw | 659 | 0.81 | 117 |  | 215 | yes |
| dedup512m | tar | 678 | 0.79 | 118 | 120 | 220 | yes |
| bundle | car | 1705 | 0.52 | 118 | 12 | 237 | yes |
| bundle | tar | 1074 | 0.82 | 117 | 120 | 226 | yes |

### Random reads: 20 offsets x 64 KiB via HTTP Range + decryptRange (per-leaf reader for CAR)

| input | fmt | prep requests | prep KB | TTFB median ms | TTFB max ms | avg KB fetched/seek | all correct |
|---|---|---:|---:|---:|---:|---:|---|
| video673 | car | 2 | 298 | 7 | 9 | 319 | yes |
| video673 | raw | 0 | 0 | 7 | 10 | 295 | yes |
| video673 | tar | 3 | 268 | 7 | 8 | 295 | yes |
| video4g5 | car | 2 | 298 | 9 | 15 | 308 | yes |
| video4g5 | raw | 0 | 0 | 8 | 11 | 309 | yes |
| video4g5 | tar | 3 | 268 | 7 | 11 | 309 | yes |
| rand1g | car | 2 | 298 | 8 | 10 | 287 | yes |
| rand1g | raw | 0 | 0 | 7 | 27 | 318 | yes |
| rand1g | tar | 3 | 268 | 7 | 8 | 305 | yes |
| rand5g | car | 2 | 298 | 7 | 13 | 324 | yes |
| rand5g | raw | 0 | 0 | 7 | 11 | 318 | yes |
| rand5g | tar | 3 | 268 | 7 | 11 | 305 | yes |
| dedup512m | car | 2 | 298 | 5 | 8 | 305 | yes |
| dedup512m | raw | 0 | 0 | 5 | 10 | 265 | yes |
| dedup512m | tar | 3 | 268 | 5 | 7 | 253 | yes |
| bundle | car | 2 | 298 | 7 | 11 | 344 | yes |
| bundle | tar | 17 | 2127 | 6 | 8 | 318 | yes |
