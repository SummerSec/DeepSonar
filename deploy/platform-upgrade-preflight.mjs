import { stat, lstat, realpath, access, open } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
// Host transport for the target image's offline validator. Never persist or log
// input snapshots, Compose environments, subprocess stderr or raw invalid output.
export const PREFLIGHT_INPUT_SCHEMA = 'deepsonar.platform-upgrade-preflight/v1';
export const PREFLIGHT_RESULT_SCHEMA = 'deepsonar.platform-upgrade-preflight-result/v1';
const MAX_BYTES = 16 * 1024 * 1024;

export function preflightBlock(code, location, message) {
  return {schema: PREFLIGHT_RESULT_SCHEMA, ok: false, blocking_errors: [{code, location, message}], coverage: [], not_checked: []};
}

export function parsePreflightResult(output) {
  try {
    if (Buffer.byteLength(output) > MAX_BYTES) throw new Error();
    const report = JSON.parse(output.toString());
    if (report.schema !== PREFLIGHT_RESULT_SCHEMA || typeof report.ok !== 'boolean'
        || !Array.isArray(report.blocking_errors) || !Array.isArray(report.coverage) || !Array.isArray(report.not_checked)
        || report.blocking_errors.length > 1000 || report.coverage.length > 100 || report.not_checked.length > 100) throw new Error();
    const blocking_errors = report.blocking_errors.map(error => {
      if (typeof error.code !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,95}$/.test(error.code)
          || typeof error.location !== 'string' || !/^[A-Za-z0-9_.\[\]-]{1,250}$/.test(error.location)
          || typeof error.message !== 'string' || error.message.length > 500) throw new Error();
      return {code: error.code, location: error.location, message: error.message};
    });
    if (report.ok !== (blocking_errors.length === 0)
        || [...report.coverage, ...report.not_checked].some(item => typeof item !== 'string' || !/^[A-Za-z0-9_.-]{1,100}$/.test(item))) throw new Error();
    return {schema: PREFLIGHT_RESULT_SCHEMA, ok: report.ok, blocking_errors, coverage: report.coverage, not_checked: report.not_checked};
  } catch {
    return preflightBlock('HOST_INVALID_PREFLIGHT_RESULT', 'host.target_validator', 'The target image did not return a valid structured preflight report.');
  }
}


// Compose config JSON re-escapes literal dollars for a subsequent Compose parse.
export function resolveComposeEnvironment(environment) {
  if (!environment || typeof environment !== 'object' || Array.isArray(environment) || Object.values(environment).some(value => typeof value !== 'string')) throw new Error('invalid rendered Compose environment');
  return Object.fromEntries(Object.entries(environment).map(([key, value]) => [key, value.replaceAll('$$', '$')]));
}

// Metadata evidence is bound to the rendered target container path. Only the
// explicit private-input callback enables a bounded read after validation.
// The scheduler image runs as root unless Compose supplies a numeric identity.
export async function collectPreflightHostFiles(compose, {directory = process.cwd(), readKey} = {}) {
  const raw = compose.services?.scheduler ?? {};
  const decode = value => typeof value === 'string' ? value.replaceAll('$$', '$') : value;
  const service = {...raw, volumes: (raw.volumes ?? []).map(v => ({...v, source: decode(v.source), target: decode(v.target)})), secrets: (raw.secrets ?? []).map(v => typeof v === 'object' ? {...v, source: decode(v.source), target: decode(v.target)} : v)};
  const target = service.environment ? resolveComposeEnvironment(service.environment).DEEPSONAR_MASTER_KEY_FILE : undefined;
  if (!target) return [];
  const evidence = {key: 'DEEPSONAR_MASTER_KEY_FILE', path: target, exists: false, regular_file: false, readable: false, read_only: false, mode: 0};
  if (typeof target !== 'string' || !path.posix.isAbsolute(target) || path.posix.normalize(target) !== target) return [evidence];
  let source, relative = "";
  const binds = (service.volumes ?? []).filter(v => typeof v.target === 'string' && (target === v.target || target.startsWith(v.target.replace(/\/$/, '') + '/'))).sort((a, b) => b.target.length - a.target.length);
  if (binds.length) {
    const bind = binds[0];
    if (bind.type !== 'bind' || typeof bind.source !== 'string' || (binds[1]?.target === bind.target)) return [evidence];
    source = path.resolve(directory, bind.source);
    relative = path.posix.relative(bind.target, target);
    evidence.read_only = bind.read_only === true;
  } else {
    const secret = (service.secrets ?? []).find(v => typeof v === 'object' && (v.target?.startsWith('/') ? v.target : '/run/secrets/' + (v.target || v.source)) === target);
    const definition = secret && compose.secrets?.[secret.source];
    if (typeof definition?.file !== 'string') return [evidence];
    source = path.resolve(directory, decode(definition.file));
    evidence.read_only = true;
  }
  try {
    if (process.platform === 'win32') {
      if (!evidence.read_only) return [evidence];
      const {probeWindowsMasterKey} = await import('./platform-upgrade-preflight-windows.mjs');
      const result = await probeWindowsMasterKey({file: path.resolve(source, relative), image: decode(service.image), user: String(service.user ?? '0:0')});
      Object.assign(evidence, {exists: true, regular_file: true, readable: true, mode: result.mode, permission_model: 'windows_acl', private_acl: true});
      readKey?.(result.content);
      return [evidence];
    }
    // Docker resolves the bind source itself; links below its root are interpreted
    // in the container namespace and cannot be proven by host realpath.
    let canonical = await realpath(source);
    const directories = [];
    if (relative) {
      directories.push(await stat(canonical));
      const parts = relative.split('/');
      for (const [index, part] of parts.entries()) {
        canonical = path.join(canonical, part);
        const entry = await lstat(canonical);
        if (entry.isSymbolicLink()) return [evidence];
        if (index < parts.length - 1) directories.push(entry);
      }
    }
    const info = await stat(canonical);
    evidence.exists = true; evidence.regular_file = info.isFile(); evidence.mode = info.mode & 0o7777;
    const identity = String(service.user ?? '0:0');
    if (!/^\d+(?::\d+)?$/.test(identity)) return [evidence];
    const [uid, gid] = identity.split(':').map(Number);
    // Prove both host access and the target numeric identity's read permission.
    await access(canonical, constants.R_OK);
    const readable = (entry) => uid === 0 || Boolean(entry.mode & (entry.uid === uid ? 0o400 : entry.gid === gid ? 0o040 : 0o004));
    const traversable = (entry) => entry.isDirectory() && (uid === 0 || Boolean(entry.mode & (entry.uid === uid ? 0o100 : entry.gid === gid ? 0o010 : 0o001)));
    evidence.readable = readable(info) && directories.every(traversable);
    if (readKey && evidence.readable && evidence.regular_file && evidence.read_only && !(evidence.mode & 0o022)) {
      const file = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
      const bytes = Buffer.alloc(4097);
      try {
        const before = await file.stat();
        if (!before.isFile() || before.dev !== info.dev || before.ino !== info.ino || before.mode !== info.mode || before.size > 4096) throw new Error();
        const {bytesRead} = await file.read(bytes, 0, bytes.length, 0);
        const after = await file.stat();
        if (bytesRead > 4096 || before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytesRead !== after.size) throw new Error();
        readKey(bytes.subarray(0, bytesRead).toString('utf8'));
      } finally {bytes.fill(0); await file.close();}
    }
  } catch { /* Missing/unreadable metadata remains a blocking precondition. */ }
  return [evidence];
}

// Private key content is separate from public metadata and travels only on stdin.
export async function collectPreflightKeyInput(compose, options = {}) {
  let master_key_file_content;
  const host_files = await collectPreflightHostFiles(compose, {...options, readKey: value => {master_key_file_content = value;}});
  return {host_files, ...(master_key_file_content === undefined ? {} : {master_key_file_content})};
}

export async function targetConfigurationPreflight({target, values, commandEnv, dc, run, snapshotSql}) {
  let snapshot, environment, keyInput;
  try {
    // SQL is sent via stdin too; -X ignores psqlrc and -q suppresses BEGIN/COMMIT
    // command tags. A single repeatable-read transaction captures all inputs.
    const raw = dc(['exec', '-T', 'postgres', 'psql', '-X', '-qAt', '-U', 'deepsonar', '-d', 'deepsonar', '-v', 'ON_ERROR_STOP=1'], snapshotSql);
    if (raw.length > MAX_BYTES) throw new Error();
    snapshot = JSON.parse(raw.toString());
  } catch {
    return preflightBlock('HOST_CONFIG_SNAPSHOT_FAILED', 'host.database_snapshot', 'Could not read the supported configuration snapshot; schema compatibility must be reviewed before upgrading.');
  }
  try {
    const rendered = dc(['config', '--format', 'json'], undefined, {...commandEnv, ...values});
    if (rendered.length > MAX_BYTES) throw new Error();
    const compose = JSON.parse(rendered.toString());
    environment = resolveComposeEnvironment(compose.services?.scheduler?.environment);
    keyInput = await collectPreflightKeyInput(compose);
    if (!environment || typeof environment !== 'object' || Array.isArray(environment)
        || Object.values(environment).some(value => typeof value !== 'string')) throw new Error();
  } catch {
    return preflightBlock('HOST_COMPOSE_CONFIG_FAILED', 'host.scheduler_environment', 'Could not resolve the target Scheduler environment from Compose.');
  }
  const input = JSON.stringify({...snapshot, schema: PREFLIGHT_INPUT_SCHEMA, target_schema_version: target.schema_version, environment, ...keyInput});
  if (Buffer.byteLength(input) > MAX_BYTES) return preflightBlock('HOST_PREFLIGHT_INPUT_TOO_LARGE', 'host.database_snapshot', 'Configuration snapshot exceeds the bounded offline validation input size.');
  try {
    const result = run(['run', '--rm', '-i', '--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=64', '--memory=512m', '--entrypoint=node', values.DEEPSONAR_SCHEDULER_IMAGE,
      '/app/apps/scheduler/dist/platform-upgrade-preflight-cli.js'], input, commandEnv, [0, 1]);
    const report = parsePreflightResult(result?.stdout ?? result);
    if (result?.status !== undefined && result.status !== (report.ok ? 0 : 1)) return preflightBlock('HOST_PREFLIGHT_STATUS_MISMATCH', 'host.target_validator', 'Target validator exit status disagrees with its structured report.');
    return report;
  } catch {
    return preflightBlock('HOST_PREFLIGHT_EXECUTION_FAILED', 'host.target_validator', 'Could not execute the offline configuration validator in the target Scheduler image.');
  }
}

// Keep full config rows so obsolete/unknown persisted keys cannot disappear in
// a host-side projection. Encryption material is private stdin input only.
export const CONFIG_SNAPSHOT_SQL = `BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SELECT jsonb_build_object(
  'database_schema_version', (SELECT version FROM schema_meta WHERE id='global'),
  'global_settings', (SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY id), '[]'::jsonb) FROM global_settings t),
  'projects', (SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY id), '[]'::jsonb) FROM projects t),
  'agent_roles', (SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY id), '[]'::jsonb) FROM agent_roles t),
  'role_configs', (SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY id), '[]'::jsonb) FROM role_configs t),
  'role_config_files', (SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY id), '[]'::jsonb) FROM role_config_files t),
  'runtime_images', (SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY id), '[]'::jsonb) FROM
    (SELECT id, image_key, enabled, official FROM runtime_images) t),
  'runtime_image_versions', (SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY runtime_image_id), '[]'::jsonb) FROM
    (SELECT runtime_image_id, trust_status FROM runtime_image_versions) t),
  'credentials', (SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY id), '[]'::jsonb) FROM
    (SELECT id, kind, provider, project_id, status, agent_cli, public_metadata_json, settings_config_json, meta_json, ciphertext, nonce, auth_tag FROM credentials) t)
);
COMMIT;`;
