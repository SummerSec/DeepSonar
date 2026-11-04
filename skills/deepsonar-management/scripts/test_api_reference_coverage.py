"""api.md 与实现的对账：#893 保鲜的机检部分。

`references/api.md` 是 Management API 的仓库内副本，被要求「先拉 schema 再操作」的 Agent 直接读它。
此前没有任何检查把它和实现对齐过：schema 主线和脚本被管住了，唯独**端点清单可以静默过期**——
2026-11-05 实测缺 35 条真实路由（devices / knowledge / tokens / users / finding 检索等），
而 docs-freshness 全绿。

本测试把 `apps/scheduler/src/auth.ts` 的 `ROUTE_SCOPES`（路由 → scope 的唯一真值，由
`route-surface.test.ts` 保证与注册路由一致）当作权威，断言：

1. 每条有 scope 的路由都在 api.md 里出现（方法 + 路径，`:param` 与 `:param(regex)` 等价）；
2. api.md 里写的 scope 与 `ROUTE_SCOPES` 相同（合并行允许「A / B」或「A + 说明」写法）；
3. api.md 不发明实现里没有的非豁免路由。

只读文件，不改仓库；从仓库根运行（`pnpm ci:unit:management-skill` 与 skill 自身的
`python -m unittest discover -s skills/deepsonar-management/scripts` 都以仓库根为 cwd）。
"""

from __future__ import annotations

import re
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
AUTH_SOURCE = REPO_ROOT / "apps" / "scheduler" / "src" / "auth.ts"
API_REFERENCE = Path(__file__).resolve().parents[1] / "references" / "api.md"

METHODS = {"GET", "POST", "PUT", "PATCH", "DELETE"}
_PARAM_WITH_PATTERN = re.compile(r"\([^)]*\)")


def _normalise(path: str) -> str:
    """`:id([0-9a-f-]{36})` 与 `:id` 指同一条路由，去掉 Fastify 的路径内正则。"""
    return _PARAM_WITH_PATTERN.sub("", path).strip()


def _route_scopes() -> dict[str, str]:
    text = AUTH_SOURCE.read_text(encoding="utf-8")
    marker = "const ROUTE_SCOPES: Record<string, string> = {"
    assert marker in text, "auth.ts 不再以 ROUTE_SCOPES 声明路由 scope；本检查需要跟着实现改"
    block = text.split(marker, 1)[1].split("\n};", 1)[0]
    return dict(re.findall(r'"((?:GET|POST|PUT|PATCH|DELETE) /[^"]*)"\s*:\s*"([^"]+)"', block))


def _documented_rows() -> list[tuple[str, str, str]]:
    """(method, path, scope 单元格)；方法列可写 `GET / POST`，方法可写 `*` 通配。"""
    rows: list[tuple[str, str, str]] = []
    for line in API_REFERENCE.read_text(encoding="utf-8").splitlines():
        cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
        if len(cells) < 3 or not cells[1].startswith("/"):
            continue
        for method in (m.strip() for m in cells[0].split("/")):
            if method in METHODS or method == "*":
                rows.append((method, cells[1], cells[2]))
    return rows


def _scope_tokens(cell: str) -> set[str]:
    """一格里可以写 `assets:read / assets:write` 或 `assets:manage + admin actor`。"""
    return {token for token in re.split(r"\s*[/+]\s*|\s+", cell) if token}


class ApiReferenceCoverage(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.routes = _route_scopes()
        cls.rows = _documented_rows()
        cls.normalised_rows = [(method, _normalise(path), scope) for method, path, scope in cls.rows]

    def test_reference_file_exists_and_has_endpoints(self) -> None:
        self.assertTrue(API_REFERENCE.is_file(), "skill 缺少 references/api.md")
        self.assertGreater(len(self.rows), 150, "api.md 的端点表被删空或解析失效")

    def test_every_scoped_route_is_documented(self) -> None:
        missing = []
        for route in self.routes:
            method, path = route.split(" ", 1)
            wanted = _normalise(path)
            if not any(
                (doc_method in (method, "*"))
                and (doc_path == wanted or (doc_path.endswith("*") and wanted.startswith(doc_path[:-1])))
                for doc_method, doc_path, _ in self.normalised_rows
            ):
                missing.append(route)
        self.assertEqual(
            sorted(missing),
            [],
            "api.md 缺少实现里存在的管理端点；新增路由必须同步补文档（或补到豁免清单）",
        )

    def test_documented_scope_matches_implementation(self) -> None:
        mismatched = []
        for route, scope in self.routes.items():
            method, path = route.split(" ", 1)
            wanted = _normalise(path)
            for doc_method, doc_path, doc_scope in self.normalised_rows:
                if doc_method not in (method, "*") or doc_path != wanted:
                    continue
                if doc_scope.startswith("豁免"):
                    mismatched.append((route, doc_scope, scope, "豁免路由不应出现在 ROUTE_SCOPES"))
                elif scope not in _scope_tokens(doc_scope):
                    mismatched.append((route, doc_scope, scope, "scope 与 auth.ts 不一致"))
        self.assertEqual(mismatched, [], "api.md 的 scope 列与 ROUTE_SCOPES 不一致")

    def test_reference_does_not_invent_routes(self) -> None:
        # `/health`、`/auth/login`、`/workers/register` 等豁免入口不在 ROUTE_SCOPES 中，
        # Job-scoped Control 走独立前缀。这里只要求它们被显式登记，不允许凭空多出路由。
        exempt = {"/health", "/openapi.json", "/schema", "/schema.md", "/auth/status", "/auth/login",
                  "/auth/bootstrap", "/auth/me", "/workers/register", "/workers/heartbeat", "/metrics"}
        exempt_prefixes = ("/control/v1/jobs/", "/gateway/")
        known = {_normalise(route.split(" ", 1)[1]) for route in self.routes}
        invented = []
        for method, path, _ in self.rows:
            normalised = _normalise(path)
            if normalised in known or normalised in exempt:
                continue
            if any(normalised.startswith(prefix) for prefix in exempt_prefixes):
                continue
            if normalised.endswith("*") and any(known_path.startswith(normalised[:-1]) for known_path in known):
                continue
            invented.append(f"{method} {path}")
        self.assertEqual(invented, [], "api.md 写了实现里不存在的路由；删除或改为豁免说明")


if __name__ == "__main__":
    unittest.main()