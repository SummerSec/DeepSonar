import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import postgres from 'postgres';

const databaseUrl = process.env.TEST_DATABASE_URL?.trim();
if (!databaseUrl) {
  test('bounded lexical retrieval requires isolated PostgreSQL', { skip: 'TEST_DATABASE_URL is not set' }, () => {});
} else {
  test('bounded lexical windows preserve current scope, cursor bindings and source truth', async () => {
    const adminUrl = new URL(databaseUrl); adminUrl.pathname = '/postgres';
    const admin = postgres(adminUrl.toString(), { max: 1 });
    const name = `lexical_fixture_${randomUUID().replaceAll('-', '')}`;
    const target = new URL(databaseUrl); target.pathname = `/${name}`;
    let close: (() => Promise<unknown>) | undefined;
    let appClose: (() => Promise<unknown>) | undefined;
    try {
      await admin.unsafe(`CREATE DATABASE "${name}"`);
      process.env.DATABASE_URL = target.toString(); process.env.DEEPSONAR_AUTH_REQUIRED = 'true'; process.env.AGENT_MODE = 'fake';
      const [{ migrate, sql }, { searchFindingLexical }, { default: Fastify }, { default: websocket }, { registerRoutes }, { generateToken }, { CursorError, QueryParameterError }] = await Promise.all([
        import('../../db.js'), import('./lexical-search.js'), import('fastify'), import('@fastify/websocket'), import('../../routes.js'), import('../../auth.js'), import('../../pagination.js'),
      ]);
      close = () => sql.end({ timeout: 5 }); await migrate();
      const app = Fastify({ logger: false }); await app.register(websocket); registerRoutes(app); await app.ready(); appClose = () => app.close();
      const project = randomUUID(), other = randomUUID(), canvas = randomUUID(), otherCanvas = randomUUID();
      const subjectJob = randomUUID(), candidateJob = randomUUID(), otherJob = randomUUID(), badCanvasJob = randomUUID();
      const findingId = (n: number) => `77000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
      const subject = findingId(0);
      await sql`INSERT INTO projects (id,name) VALUES (${project},'lexical fixture'),(${other},'other lexical fixture')`;
      await sql`INSERT INTO canvases (id,project_id,title) VALUES (${canvas},${project},'source task'),(${otherCanvas},${other},'other task')`;
      await sql`INSERT INTO jobs (id,project_id,canvas_id,type,status,agent_snapshot_json) VALUES
        (${subjectJob},${project},${canvas},'audit','succeeded','{}'),(${candidateJob},${project},${canvas},'audit','succeeded','{}'),
        (${otherJob},${other},${otherCanvas},'audit','succeeded','{}'),(${badCanvasJob},${project},${otherCanvas},'audit','succeeded','{}')`;
      await sql`INSERT INTO findings(id,project_id,job_id,fingerprint,title,summary,profile,verify_status,disposition)
        VALUES (${subject},${project},${subjectJob},'subject','搜索 参数 注入','声明文本仅供检索','security.vulnerability','confirmed','resolved')`;
      const expected = new Set<string>();
      for (let n = 1; n <= 650; n += 1) {
        const job = n < 128 ? subjectJob : n % 50 === 0 ? otherJob : n % 51 === 0 ? badCanvasJob : n % 6 === 0 ? candidateJob : subjectJob;
        if (job === candidateJob) expected.add(findingId(n));
        await sql`INSERT INTO findings(id,project_id,job_id,fingerprint,title,summary,profile,verify_status,disposition)
          VALUES (${findingId(n)},${project},${job},${`row-${n}`},${`搜索 参数 注入 ${n}`},'声明文本仅供检索','security.vulnerability','pending','open')`;
      }
      const foreignFinding = randomUUID();
      await sql`INSERT INTO findings(id,project_id,job_id,fingerprint,title,profile)
        VALUES (${foreignFinding},${other},${otherJob},'foreign','禁止泄漏的外项目标题','general')`;
      const artifact = randomUUID();
      await sql`INSERT INTO artifacts(id,project_id,job_id,canvas_id,artifact_key,kind,source_operation)
        VALUES (${artifact},${project},${subjectJob},${canvas},'lexical-evidence','security.finding','emit_finding')`;
      await sql`INSERT INTO artifact_evidence(artifact_id,statement,uri) VALUES (${artifact},'private-evidence-body-never-return','evidence:private-reference')`;
      await sql`UPDATE findings SET artifact_id=${artifact},evidence_refs_json='["private-evidence-reference"]'::jsonb WHERE id=${subject}`;
      const token = async (scopes: string[], projectId: string | null) => {
        const value = generateToken();
        await sql`INSERT INTO api_tokens(name,project_id,token_prefix,token_hash,scopes)
          VALUES ('lexical-test',${projectId},${value.prefix},${value.hash},${scopes})`;
        return { value, headers: { authorization: `Bearer ${value.plaintext}` } };
      };
      const reader = await token(['findings:read'], project), noScope = await token(['projects:read'], project), foreign = await token(['findings:read'], other);
      const path = `/findings/${subject}/lexical-search`;
      const before = await sql`SELECT id,verify_status,disposition,updated_at FROM findings WHERE project_id=${project} ORDER BY id`;
      const firstResponse = await app.inject({ method:'GET',url:path,headers:reader.headers });
      assert.equal(firstResponse.statusCode,200,firstResponse.payload);
      const first = firstResponse.json();
      assert.equal(first.examined,128); assert.equal(first.items.length,0); assert.ok(first.next_cursor);
      assert.equal(first.window_limited,true); assert.equal(first.identity_status,'insufficient_information');
      assert.equal(first.query_plane,'current'); assert.equal(first.rank_truncated,false);
      assert.equal((await app.inject({method:'GET',url:path,headers:noScope.headers})).statusCode,403);
      assert.equal((await app.inject({method:'GET',url:path,headers:foreign.headers})).statusCode,403);
      assert.equal(await searchFindingLexical(subject,undefined,sql,other),null);
      const found = new Set<string>(); let cursor: string | null = first.next_cursor; let examined = first.examined, windows = 1;
      while (cursor) {
        const response = await app.inject({method:'GET',url:`${path}?cursor=${cursor}`,headers:reader.headers});
        assert.equal(response.statusCode,200,response.payload);
        const page = response.json();
        assert.ok(page.examined<=128); assert.ok(page.items.length<=25); assert.equal(page.rank_truncated,false);
        for (const item of page.items) {
          assert.ok(expected.has(item.finding_id)); assert.ok(!found.has(item.finding_id)); found.add(item.finding_id);
          assert.ok(['similar','insufficient_information'].includes(item.kind)); assert.ok(item.title.includes('搜索'));
          assert.equal(item.job_id,candidateJob); assert.equal(item.canvas_id,canvas); assert.match(item.lexical_digest,/^sha256:/);
        }
        assert.ok(!response.payload.includes('private-evidence')); assert.ok(!response.payload.includes('禁止泄漏'));
        examined += page.examined; windows += 1; cursor = page.next_cursor;
      }
      assert.deepEqual(found,expected); assert.equal(examined,651); assert.ok(windows>4,'older than 500 rows must remain reachable');
      assert.deepEqual(await sql`SELECT id,verify_status,disposition,updated_at FROM findings WHERE project_id=${project} ORDER BY id`,before);
      assert.equal(Number((await sql`SELECT count(*) AS n FROM project_finding_features`)[0].n),0,'read path must not write C projections');
      for (const value of ['bad!', 'e30', 123, ['bad'], 'a'.repeat(2049)]) {
        await assert.rejects(searchFindingLexical(subject,value), QueryParameterError);
      }
      assert.equal((await app.inject({method:'GET',url:`${path}?cursor=bad!`,headers:reader.headers})).statusCode,400);
      const payload = JSON.parse(Buffer.from(first.next_cursor,'base64url').toString('utf8'));
      const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
      const exactBoundary = (await searchFindingLexical(subject,encode({...payload,after:findingId(522)})))!;
      assert.equal(exactBoundary.examined,128); assert.equal(exactBoundary.next_cursor,null);
      const exhausted = (await searchFindingLexical(subject,encode({...payload,after:findingId(650)})))!;
      assert.equal(exhausted.examined,0); assert.equal(exhausted.next_cursor,null);
      for (const value of [{...payload,project:other},{...payload,subject:foreignFinding},{...payload,after:'bad'},{...payload,extra:1}]) {
        await assert.rejects(searchFindingLexical(subject,encode(value)),QueryParameterError);
      }
      for (const value of [{...payload,rule:'obsolete'},{...payload,normalization:'obsolete'}]) {
        await assert.rejects(searchFindingLexical(subject,encode(value)),(error: unknown)=>error instanceof CursorError&&error.code==='CURSOR_GAP');
      }
      await sql`UPDATE findings SET summary=repeat('声明',10000) WHERE id=${subject}`;
      const changed = await app.inject({method:'GET',url:`${path}?cursor=${first.next_cursor}`,headers:reader.headers});
      assert.equal(changed.statusCode,409,changed.payload); assert.equal(changed.json().error_code,'CURSOR_GAP');
      const clipped = (await searchFindingLexical(subject,undefined))!; assert.equal(clipped.subject_text_truncated,true);
      await sql`UPDATE findings SET summary=summary || '尾部变化' WHERE id=${subject}`;
      await assert.rejects(searchFindingLexical(subject,clipped.next_cursor),(error: unknown)=>error instanceof CursorError&&error.code==='CURSOR_GAP');
      // A real minted Job capability cannot be used as a management token.
      const capJob = randomUUID();
      await sql`INSERT INTO jobs(id,project_id,canvas_id,type,status,agent_snapshot_json,started_at,timeout_sec,lease_expires_at)
        VALUES (${capJob},${project},${canvas},'audit','provisioning','{"platform_tools":["emit_progress"]}',now(),3600,now()+interval '1 hour')`;
      const {createAttempt}=await import('../job-attempt/application.js'); await sql.begin(tx=>createAttempt(tx as unknown as typeof sql,capJob));
      const {mintJobCapabilityToken}=await import('../platform-api/tokens.js'); const grant=await mintJobCapabilityToken(capJob);
      assert.equal((await app.inject({method:'GET',url:path,headers:{authorization:`Bearer ${grant.token}`}})).statusCode,401);
      await sql`UPDATE api_tokens SET revoked_at=now() WHERE token_hash=${reader.value.hash}`;
      assert.equal((await app.inject({method:'GET',url:path,headers:reader.headers})).statusCode,401);
      // Dense matches explicitly report rank truncation; cursor still advances by source window.
      await sql`UPDATE findings SET job_id=${candidateJob} WHERE project_id=${project} AND id<>${subject} AND job_id=${subjectJob}`;
      const dense = (await searchFindingLexical(subject,undefined))!;
      assert.equal(dense.items.length,25); assert.equal(dense.rank_truncated,true); assert.ok(dense.next_cursor);
      const candidateToDelete = dense.items[0].finding_id;
      await sql`UPDATE findings SET summary=repeat('声明',10000) WHERE id=${candidateToDelete}`;
      const candidateChanged = (await searchFindingLexical(subject,undefined))!.items.find(item=>item.finding_id===candidateToDelete)!;
      assert.ok(candidateChanged); assert.equal(candidateChanged.text_truncated,true);
      assert.notEqual(candidateChanged.lexical_digest,dense.items[0].lexical_digest);
      assert.equal((await searchFindingLexical(subject,undefined))!.subject_digest,dense.subject_digest,'candidate edits do not invalidate subject cursors');
      await sql`DELETE FROM findings WHERE id=${candidateToDelete}`;
      assert.ok(!(await searchFindingLexical(subject,undefined))!.items.some(item=>item.finding_id===candidateToDelete));
      await sql`UPDATE findings SET job_id=${otherJob} WHERE id=${subject}`;
      assert.equal(await searchFindingLexical(subject,undefined),null,'cross-project subject chain fails closed');
      await sql`DELETE FROM findings WHERE id=${subject}`;
      assert.equal(await searchFindingLexical(subject,undefined),null);
    } finally {
      await appClose?.(); await close?.();
      await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`); await admin.end({timeout:5});
    }
  });
}
