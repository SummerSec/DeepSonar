-- DeepSonar PostgreSQL baseline schema
--
-- 仅用于全新空数据库；结构变更直接更新本基线并重建数据库。
-- 本文件不使用 psql 的 \i/\ir 元命令，可由 psql、云数据库 SQL 控制台或
-- 其他支持 PostgreSQL 多语句脚本的客户端执行。

BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE schema_meta (
  id text PRIMARY KEY DEFAULT 'global',
  version int NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT schema_meta_id_check CHECK (id = 'global')
);
