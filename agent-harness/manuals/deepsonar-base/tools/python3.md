# python3

> Agent 面向工具说明书。内部实现依赖不在此列。路径约定：镜像内 `/opt/deepsonar/manuals/`。

## 使用场景

需要解释执行脚本、一次性数据处理、调用标准库做解析时使用。

## 选型依据

不要用 python3 替代专用反编译/设备协议工具；需要多版本或隔离依赖时在 kali 用 uv/venv。

## 前置条件

脚本与输入文件可读；依赖已在镜像或允许安装的策略内。

## 调用方式

入口：`python3` / `python3 -m`。

最小示例：

```bash
python3 -c "import sys; print(sys.version)"
```

## 输出解释

stdout/stderr；退出码非 0 表示脚本失败。打印内容本身不能当作设备侧证据。

## 失败处理

| 类别 | 表现 | 处理 |
| --- | --- | --- |
| 正常无结果 | 脚本无输出 | 记录查询条件与空结果；不要升级为 needs_human |
| 可修正错误 | SyntaxError/路径错误 | 修正参数/路径后重试 |
| 可重试失败 | 偶发 IO | 有限次重试；仍失败则记 inconclusive |
| 缺少运行条件 | 模块未安装且禁止联网安装 | 明确缺项；提交 needs_human / inconclusive，禁止编造 |

## 组合流程

解析 jadx/apktool 文本输出、处理 JSON/日志；不要替代 adb/hdc。

## 证据留存

保存脚本路径或 -c 文本、输入文件哈希、退出码与关键 stdout。

## 版本与限制

base 为系统单版本；kali 提供多版本。资源：注意大文件内存。
