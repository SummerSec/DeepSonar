# reverse 公开可复现样本（#718）

`sample.c` 是公开的静态分析夹具；真实镜像冒烟会用宿主机 gcc/MinGW 可复现构建 ELF、`.so` 与 Windows x64 PE，逐个保留编译器版本与产物摘要。完整命令和证据契约见 [reverse-native-smoke.md](../../reverse-native-smoke.md)。单独构建 ELF 与 `.so`：

```bash
gcc -O0 -g -fno-inline -o sample_elf sample.c
gcc -O0 -g -fPIC -shared -o libsample.so sample.c
```

2026-10-12 amd64 验证主机上的产物摘要（仅作对照，不入库二进制）：

| 产物 | SHA-256 | 大小 |
| --- | --- | --- |
| `sample_elf` | `a46dcd52416dfc8b81f75191ed1b7e2890c9885cb3868bad069a516bcb4551c6` | 17904 |
| `libsample.so` | `968d000596ef20124f4df232771d0c35fbb71b1199275ae1fcbedc12f05b69d6` | 17328 |

上述旧摘要仅对应历史 scratch 工具链，不证明 OCI 镜像或 arm64 已验证。真实镜像门禁以每次运行生成的 measurements.json 和原始证据为准。PE 仅用于静态解析，不运行。

勿把伪代码/静态值流升格为 Finding。
