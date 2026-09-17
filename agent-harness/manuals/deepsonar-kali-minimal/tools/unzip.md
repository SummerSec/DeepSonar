# unzip

> Agent 面向工具说明书。内部实现依赖不在此列。路径约定：镜像内 `/opt/deepsonar/manuals/`。

## 使用场景

解压 zip/APK/IPA/HAP 等 zip 容器查看结构。

## 选型依据

需要资源回编译用 apktool；仅查类引用用 droidasc。

## 前置条件

磁盘空间足够。

## 调用方式

入口：`unzip`。常用：`-l` 列表、`-d` 解压。

最小示例：

```bash
unzip -l app.apk | head
```

## 输出解释

列表或解压文件树。

## 失败处理

| 类别 | 表现 | 处理 |
| --- | --- | --- |
| 正常无结果 | 空归档 | 记录查询条件与空结果；不要升级为 needs_human |
| 可修正错误 | 非 zip | 修正参数/路径后重试 |
| 可重试失败 | 无 | 有限次重试；仍失败则记 inconclusive |
| 缺少运行条件 | 文件不存在 | 明确缺项；提交 needs_human / inconclusive，禁止编造 |

## 组合流程

解压后接 plistutil/jq/rg；Android 深挖接 apktool/jadx。

## 证据留存

归档哈希、列表摘要、解压路径。

## 版本与限制

apt unzip；小心 zip slip，解压到受控目录。
