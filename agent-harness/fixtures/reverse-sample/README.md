# reverse 公开可复现样本（#718）

`sample.c` 用于本地/首次镜像冒烟构建 ELF 与 `.so`：

```bash
gcc -O0 -g -fno-inline -o sample_elf sample.c
gcc -O0 -g -fPIC -shared -o libsample.so sample.c
```

2026-10-12 amd64 验证主机上的产物摘要（仅作对照，不入库二进制）：

| 产物 | SHA-256 | 大小 |
| --- | --- | --- |
| `sample_elf` | `a46dcd52416dfc8b81f75191ed1b7e2890c9885cb3868bad069a516bcb4551c6` | 17904 |
| `libsample.so` | `968d000596ef20124f4df232771d0c35fbb71b1199275ae1fcbedc12f05b69d6` | 17328 |

勿把伪代码/静态值流升格为 Finding。
