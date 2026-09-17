# jadx

> Agent 面向工具说明书。内部实现依赖不在此列。路径约定：镜像内 `/opt/deepsonar/manuals/`。

## 使用场景

需要较完整的 APK/DEX 反编译视图、导出 Java 源。

## 选型依据

大 APK 仅查类/Manifest/引用优先 droidasc；GUI 已剔除。

## 前置条件

APK/DEX 可读；磁盘充足。

## 调用方式

`/opt/deepsonar/bin/jadx`；常用 `-d out --no-res`。

最小示例：

```bash
jadx --version
```

## 输出解释

反编译目录；失败看日志。源码观感≠运行证据。

## 失败处理

| 类别 | 表现 | 处理 |
| --- | --- | --- |
| 正常无结果 | 几乎无类 | 记录查询条件与空结果；不要升级为 needs_human |
| 可修正错误 | 损坏 APK | 修正参数/路径后重试 |
| 可重试失败 | OOM 可增内存重试 | 有限次重试；仍失败则记 inconclusive |
| 缺少运行条件 | 无 jadx | 明确缺项；提交 needs_human / inconclusive，禁止编造 |

## 组合流程

droidasc 定位 → jadx 精读 → apktool 看资源。

## 证据留存

命令、APK 哈希、输出目录关键文件。

## 版本与限制

钉选见 mobile-runtime.json；禁 jadx-gui。
