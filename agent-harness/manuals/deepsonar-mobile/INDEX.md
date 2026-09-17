# deepsonar-mobile 工具说明书索引

> 焦点：Android/iOS/OpenHarmony 包分析、设备操作与 native 分析
>
> 本目录随镜像交付，断网可读。路径：`/opt/deepsonar/manuals/`。
> 先读本索引，再按需打开 `tools/<name>.md`；不要把整本手册塞进 prompt。
>
> 内部 npm/agent 运行时依赖与 Agent 直接使用的工具已区分；下列均为 Agent 面向入口。

## 工具列表

- [java (mobile JDK)](tools/java.md) — `java`
- [jadx](tools/jadx.md) — `jadx`
- [apktool](tools/apktool.md) — `apktool`
- [bundletool](tools/bundletool.md) — `bundletool`
- [apkeep](tools/apkeep.md) — `apkeep`
- [androguard](tools/androguard.md) — `androguard`
- [droidasc](tools/droidasc.md) — `droidasc`
- [apkcheckpack](tools/apkcheckpack.md) — `apkcheckpack`
- [readelf](tools/readelf.md) — `readelf`
- [objdump](tools/objdump.md) — `objdump`
- [radare2 (r2)](tools/r2.md) — `r2`
- [adb + mobile-adb.sh](tools/adb.md) — `adb`
- [hdc + wrappers](tools/hdc.md) — `hdc`
- [idevice_id](tools/idevice_id.md) — `idevice_id`
- [ideviceinstaller](tools/ideviceinstaller.md) — `ideviceinstaller`
- [plistutil](tools/plistutil.md) — `plistutil`
- [iproxy](tools/iproxy.md) — `iproxy`
- [frida](tools/frida.md) — `frida`
- [objection](tools/objection.md) — `objection`
- [jq](tools/jq.md) — `jq`
- [unzip](tools/unzip.md) — `unzip`
- [mobile-env.sh](tools/mobile-env.sh.md) — `mobile-env.sh`
- [mobile-adb.sh](tools/mobile-adb.sh.md) — `mobile-adb.sh`
- [mobile-hdc.sh](tools/mobile-hdc.sh.md) — `mobile-hdc.sh`
- [mobile-ios.sh](tools/mobile-ios.sh.md) — `mobile-ios.sh`
- [mobile-hap.sh](tools/mobile-hap.sh.md) — `mobile-hap.sh`
- [mobile-so.sh](tools/mobile-so.sh.md) — `mobile-so.sh`
- [node](tools/node.md) — `node`
- [claude / Agent CLI](tools/claude.md) — `claude`

## 阅读要求

1. 选型先看「使用场景/选型依据」，再调用。
2. 失败分类不得一律 `needs_human`。
3. 缺设备/缺服务时写明未验证，禁止编造运行结果。
4. 证据保留命令、修订、日志与产物哈希。

