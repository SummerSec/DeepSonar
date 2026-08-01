-- 0014: token_prefix 的 UNIQUE 约束已经自带唯一 B-tree 索引。
-- 0011 额外创建的同列普通索引不会改善查询，只会增加写放大与存储占用。

DROP INDEX IF EXISTS api_tokens_prefix_idx;
