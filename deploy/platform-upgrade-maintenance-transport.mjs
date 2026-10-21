import {open, rename, mkdir, chmod, readFile, lstat} from 'node:fs/promises';
import {dirname} from 'node:path';
import {spawnSync} from 'node:child_process';

export async function assertDirectoryDurability(path) {
  let handle;
  try {handle = await open(path, 'r'); await handle.sync();}
  catch {throw new Error('HOST_DIRECTORY_DURABILITY_UNSUPPORTED: directory fsync is required before maintenance');}
  finally {await handle?.close();}
}

export async function durablePrivateWrite(path, contents) {
  await mkdir(dirname(path), {recursive: true, mode: 0o700});
  const temporary = `${path}.${process.pid}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try { await file.writeFile(contents); await file.sync(); } finally { await file.close(); }
  await rename(temporary, path);
  await chmod(path, 0o600);
  const directory = await open(dirname(path), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}
export async function readPrivateJson(path) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || (info.mode & 0o077) !== 0) throw new Error('private recovery file has unsafe permissions');
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
// Constant program; all connection credentials and SQL arrive on stdin. Never
// interpolate them in command arguments or surface PostgreSQL diagnostics.
export const SQL_PROGRAM = `const postgres=require('/app/apps/scheduler/node_modules/postgres');
(async()=>{let raw='';for await(const b of process.stdin){raw+=b;if(raw.length>33554432)throw Error();}
const {connection,sql}=JSON.parse(raw);const db=postgres({...connection,max:1,connect_timeout:10,onnotice:()=>{}});
try{const result=await db.unsafe(sql).simple();const sets=Array.isArray(result[0])?result:[result];
const rows=[...sets].reverse().find(x=>x.length)||[];process.stdout.write(JSON.stringify(rows));}
finally{await db.end({timeout:5});}})().catch(()=>{process.stderr.write('maintenance SQL failed');process.exitCode=1;});`;
export function createMaintenanceTransport({compose, commandEnv, run: injectedRun}) {
  const run = injectedRun ?? ((args, input, env = commandEnv, allowed = [0]) => {
    const result = spawnSync('docker', args, {input, env, maxBuffer: 512 * 1024 * 1024, timeout: 600_000});
    if (result.error || !allowed.includes(result.status)) throw new Error('maintenance Docker operation failed; output suppressed');
    return allowed.length > 1 ? {stdout: result.stdout, status: result.status} : result.stdout;
  });
  const dc = (args, input, env = commandEnv) => run([...compose, ...args], input, env);
  const pgContainer = () => {
    const id = dc(['ps', '-q', 'postgres']).toString().trim();
    if (!/^[a-f0-9]{12,64}$/.test(id)) throw new Error('expected one running PostgreSQL container');
    return id;
  };
  const invoke = ({image, connection, args, payload, allowed = [0]}) => run(['run', '--rm', '-i', '--network', `container:${pgContainer()}`, '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=64', '--memory=512m', '--entrypoint=node', image, ...args], JSON.stringify({...payload, connection: {host: '127.0.0.1', port: 5432, ...connection}}), commandEnv, allowed);
  const rows = async ({image, role, password, database, port = 5432, sql}) => {
    const output = invoke({image, connection: {username: role, password, database, port}, args: ['-e', SQL_PROGRAM], payload: {sql}});
    const value = JSON.parse(output.toString());
    if (!Array.isArray(value)) throw new Error('invalid maintenance SQL response');
    return value;
  };
  return {run, dc, pgContainer, rows,
    scalar: async input => Object.values((await rows(input))[0] ?? {})[0],
    schema: async ({image, role, password, database, port = 5432, ...payload}) => {
      const result = invoke({image, connection: {username: role, password, database, port}, args: ['/app/apps/scheduler/dist/platform-upgrade-schema-cli.js'], payload: {schema: 'deepsonar.schema-upgrade/v1', ...payload}, allowed: [0, 1]});
      const value = JSON.parse((result.stdout ?? result).toString());
      if (value.schema !== 'deepsonar.schema-upgrade-result/v1' || typeof value.ok !== 'boolean' || (result.status !== undefined && result.status !== (value.ok ? 0 : 1))) throw new Error('invalid schema CLI response');
      return value;
    },
    archive: ({action, role, password, database, port = 5432, input}) => run(['exec', '-i', '-e', 'PGPASSWORD', pgContainer(), action, '-h', '127.0.0.1', '-p', String(port), '-U', role, '-d', database,
      ...(action === 'pg_dump' ? ['-Fc'] : ['--exit-on-error', '--no-owner', '--no-privileges'])], input, {...commandEnv, PGPASSWORD: password}),
  };
}
