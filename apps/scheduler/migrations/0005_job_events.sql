-- 0005: 任务触发全事件化（§4.2/§8.3）
-- jobs 表 INSERT(pending) 或进入终态 → pg_notify('dfh_jobs')，调度器 LISTEN 后立即领取，
-- 不再依赖轮询；NOTIFY 在事务提交时才投递，天然保证可见性。

CREATE OR REPLACE FUNCTION dfh_notify_job_event() RETURNS trigger AS $$
BEGIN
  IF (TG_OP = 'INSERT' AND NEW.status = 'pending')
     OR (TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status
         AND NEW.status IN ('succeeded','failed','timeout','cancelled','orphan')) THEN
    PERFORM pg_notify('dfh_jobs', NEW.id::text);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS jobs_notify_event ON jobs;
CREATE TRIGGER jobs_notify_event
  AFTER INSERT OR UPDATE OF status ON jobs
  FOR EACH ROW EXECUTE FUNCTION dfh_notify_job_event();
