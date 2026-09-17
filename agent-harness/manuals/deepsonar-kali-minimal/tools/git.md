# git

> Agent 面向工具说明书。内部实现依赖不在此列。路径约定：镜像内 `/opt/deepsonar/manuals/`。

## 使用场景

需要克隆、检出、查看历史、对比补丁或确认目标修订时使用。

## 选型依据

不要用 git 替代 ripgrep 做大规模内容检索；不要在只读任务里强行 push。与「仅下载 release 资产」相比，需要完整历史或精确 commit 时选 git。

## 前置条件

网络策略允许访问远端（若需 clone）；工作区可写；已知仓库 URL 或已有本地 `.git`。

## 调用方式

入口：`git`。常用：`clone --filter=blob:none`、`checkout`、`rev-parse HEAD`、`show`、`diff`。

最小示例：

```bash
git rev-parse HEAD && git status --porcelain
```

## 输出解释

stdout 为命令结果；退出码 0 成功。`rev-parse` 输出 commit 可证明当前修订；`status` 非空只说明工作区脏，不证明漏洞。

## 失败处理

| 类别 | 表现 | 处理 |
| --- | --- | --- |
| 正常无结果 | 查询无匹配 ref/路径 | 记录查询条件与空结果；不要升级为 needs_human |
| 可修正错误 | 错误 ref、未 init | 修正参数/路径后重试 |
| 可重试失败 | 瞬时网络/锁 | 有限次重试；仍失败则记 inconclusive |
| 缺少运行条件 | 无 git 或不允许 egress | 明确缺项；提交 needs_human / inconclusive，禁止编造 |

## 组合流程

clone/checkout 后用 ripgrep/jq/语言工具链继续；审计镜像可接 clang-tidy；移动端不替代 jadx。

## 证据留存

保存完整命令、远端 URL、commit SHA、必要时 `git show` 片段与工作区相对路径。

## 版本与限制

镜像 apt 钉选版本见 tool-manifest；副作用：可能写 `.git` 与对象库；清理无关 clone 以免撑爆磁盘。
