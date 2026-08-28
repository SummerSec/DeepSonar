# DeepSonar · Taste Skill 完整落地 Prompt

> 来源 skill：[Leonxlnx/taste-skill](https://github.com/Leonxlnx/taste-skill)（`design-taste-frontend` v2）  
> 用途：生成**对外教程 / 操作手册站**（非产品控制台 dashboard 重做）  
> 日期：2026-08-02

---

## 怎么用

| 目标 | 做法 |
|------|------|
| 一次做完教程站 | 只复制 **Prompt 1** |
| 视觉先定稿再写码 | 先 **Prompt 3**，再 **Prompt 1**（补上图片路径） |
| 教程站 + 控制台轻改 | Prompt 1 完成后再跑 **Prompt 2** |
| 只想粘贴一次 | 用文末 **超级合并版** |

安装 / 对齐上游 skill（可选）：

```bash
npx skills add https://github.com/Leonxlnx/taste-skill --skill "design-taste-frontend"
npx skills add https://github.com/Leonxlnx/taste-skill --skill "redesign-existing-projects"
npx skills add https://github.com/Leonxlnx/taste-skill --skill "imagegen-frontend-web"
npx skills add https://github.com/Leonxlnx/taste-skill --skill "image-to-code"
npx skills add https://github.com/Leonxlnx/taste-skill --skill "full-output-enforcement"
```

**范围提醒（官方 skill 自带约束）：**

- 教程站 / 落地页 → 主用 `design-taste-frontend`
- `apps/web` 控制台 → 只用 redesign + 排版层，**不要**把 Jobs/Canvas 改成营销 bento
- Dashboard / 密表 / 多步表单不在 taste-skill 主范围内

---

## Design Read（所有 Prompt 共用）

> Reading this as: B2B security-ops product landing + operator tutorial for technical security engineers and platform owners, with a **dark precision-instrument** language, leaning toward **Geist + monochrome + single mint accent**. Not AI-SaaS purple.

| 表面 | Dials (V / M / D) |
|------|-------------------|
| 教程 / 营销页 | `7 / 5 / 3` |
| 产品控制台（可选轻改） | `4 / 3 / 7` |

**视觉锁：**

| Token | 值 |
|-------|-----|
| 背景 | `#07090b` |
| 表面 | `#0d1013` / `#12161a` / `#1a2025` |
| 主强调（唯一） | mint `#3ddc9e` / `#65e6b4` |
| 字体 | Geist + Geist Mono；中文正文可用 Noto Sans SC |
| 圆角 | 面板 12px；状态 pill 999 |
| 图标 | Phosphor only |

---

## Prompt 1 — 完整教程站落地（主 Prompt）

将以下整段粘贴给 Agent：

```text
# ROLE
You are a senior product designer + frontend engineer executing the
design-taste-frontend skill (Taste Skill v2 / Leonxlnx/taste-skill).

You will ship a COMPLETE, production-ready tutorial + marketing site for
DeepSonar. Not a wireframe. Not a partial scaffold. Full page(s),
real copy, real tokens, real motion (with reduced-motion fallbacks),
mobile collapse, light/dark policy as specified, and a pre-flight pass.

# DESIGN READ (declare this first in your response, then implement)
Reading this as: B2B security-ops product landing + operator tutorial for
DeepSonar (multi-project code-audit scheduler). Audience: security
engineers and platform owners. Vibe: dark precision instrument, not AI SaaS.
Language: Chinese primary for tutorial; English brand line allowed in hero.

# DIALS (lock these)
DESIGN_VARIANCE: 7
MOTION_INTENSITY: 5
VISUAL_DENSITY: 3

# PRODUCT (truth you must not invent past)
DeepSonar is a multi-project code-audit scheduling platform.

Four truths:
1. Local DB = only source of truth
2. Canvas = process truth (fact-intent bipartite graph per task)
3. Sandbox = execution truth (agentbox; default networkMode none)
4. Scheduler = the only executor with side effects

Core discipline:
- Agents only PROPOSE. They do not decide.
- Whitelisted agent tools: emit_progress, emit_finding, mark_job_done, request_human
- emit_finding may suggest verify; only the scheduler rule engine creates follow-up jobs
- Guardrails: MAX_FOLLOWUP_DEPTH=2, hub max rounds, concurrency limits, reaper for timeout/orphan
- Job state machine: pending → claimed → provisioning → running → succeeded|failed|timeout|cancelled|orphan
- Idempotency: events (job_id, event_id); findings (project_id, fingerprint)
- One task one canvas; verify jobs inherit parent canvas
- Hub loop (Cairn-style fact-intent) is event-driven, default OFF
  (DEEPSONAR_HUB_ENABLED=false or project config_json.rules.hubEnabled)
- Agent config layers: agent_roles → role_configs (global + project) →
  jobs.agent_snapshot_json (frozen at create) → payload_json.runtime_evidence
- Fake mode: AGENT_MODE=fake (NoopRunner, state machine only)
- Real mode: AGENT_MODE=real (OpenSandbox)
- Schema single source: database/schema.sql, applied on scheduler start
- Web is read-mostly process surface; nodes not agent-draggable; layout server-side
- Plane is optional integration; default path is local project/task API

Real commands (must appear accurately, do not invent alternatives):
- pnpm db:up
- pnpm dev          # scheduler :3100, applies schema
- pnpm dev:web      # vite :5173, /api → 3100
- pnpm build
- pnpm typecheck
- python agent-harness/test-local-project-api.py
- npx agentbox image build --provider local-docker --file agent-harness/image.mjs

# OUT OF SCOPE (do not build)
- Do NOT redesign the product console dashboard tables/canvas app shell as a marketing bento
- Do NOT invent fake metrics (99.9%, 10x, etc.)
- Do NOT invent API endpoints that do not exist
- Do NOT use Plane as the default path; local project/task API is default
- Do NOT add multi-tenant billing, auth marketing, or fake real-company logo walls
  (prefer skip logo wall or invented monogram marks only)

# VISUAL SYSTEM (lock, audit every section)
Theme: dark-first, page theme lock (all sections dark family). No mid-page light flip.
Background: #07090b (ink-950) / surfaces #0d1013, #12161a, #1a2025
Text: #e8ebed primary, muted ~ white 55-65%
Accent (ONE only): mint #3ddc9e / #65e6b4 / #a6f4d5
Status colors only for semantic chips (not brand): run #6fbbe8, warn #e8bd70, crit #ed6a7f
NO pure #000 or pure #fff
NO purple / violet / AI glow / neon outer glow
NO Inter as UI font
Fonts: Geist (display+body latin) + Geist Mono (commands, IDs)
Chinese: Noto Sans SC for CJK body if needed; keep Geist for display latin brand
Radius scale: 12px cards/panels, 999px pills for status only (document this rule)
borders: hairline white/8% and white/13%
shadows: tinted ambient only, no hard black drop
grain: optional fixed pointer-events-none overlay opacity ≤ 0.02
Icons: @phosphor-icons/react ONLY, strokeWidth 1.5, one family
No emoji in UI chrome

# STACK
- React + Vite (prefer Vite React to match monorepo apps/web style)
- TypeScript ESM
- Tailwind CSS v4
- Motion (motion/react) for reveal / hover; GSAP+ScrollTrigger ONLY if you implement
  sticky-stack or horizontal-pan, isolated in client leaves with cleanup
- Self-host fonts (no Google Fonts <link> in production)
- Place under: apps/www/ (new package)
- Wire package in pnpm workspace; dev script "dev:www"
- Do not break existing apps/web or apps/scheduler

# COPY RULES
- Language: Chinese primary for product tutorial; English brand line allowed in hero
- Voice: precise, dry, instrument-manual. Concrete verbs: 领取, 调度, 派生, 冻结快照, 回收, 提案
- Banned filler: 赋能, 无缝, 一站式, 下一代, 革命性, 轻松, Elevate, Seamless, Unleash, Next-Gen
- ZERO em-dash characters (—) and ZERO en-dash separators (–). Use hyphen - or rephrase
- No "Quietly trusted by", no locale/weather strips, no scroll cues, no version labels in hero
- No section-number eyebrows (00 / INDEX, 01 Capabilities)
- Max 1 eyebrow per 3 sections total
- Hero subtext short: ≤ 20 English words OR ≤ 36 Chinese characters
- One CTA intent label sitewide for primary action: 「打开控制台」
- Secondary CTA label: 「阅读架构」
- Do not duplicate contact/signup-style CTAs

# INFORMATION ARCHITECTURE (single long page + optional anchors)
Route: /
Optional anchors: #instrument #first-blood #task #proposal #hub #evidence #sandbox #hardening

## Section plan (MUST use ≥ 4 different layout families; no layout family repeated)

### S0 — Nav (height ≤ 72px, single line desktop)
- Wordmark: DeepSonar
- Links: 原理, 上手, 纪律, 沙箱, 架构
- Right: primary button 「打开控制台」 → http://localhost:5173
- Mobile: collapse to simple panel

### S1 — Hero (Asymmetric Split, NOT centered)
Layout family: asymmetric-split
Left:
- Optional ONE eyebrow: 代码审计调度
- H1 (max 2 lines): 可回放的审计过程
- Sub: 本地库记真相，画布记过程，沙箱只执行。
- CTAs: 「打开控制台」 + ghost 「阅读架构」
Right visual:
- Prefer generated image OR abstract fact-intent node composition
- FORBIDDEN: div-fake dashboard, fake terminal full of lorem, purple mesh blob alone as hero
Hero must fit initial viewport: H1 ≤ 2 lines, CTA above fold, top padding ≤ pt-24

### S2 — Under-hero principle strip
Layout family: full-width rule strip
Four truths as 4 compact mono-labeled cells (not 3 equal marketing cards):
本地库 · 唯一真相
画布 · 过程真相
沙箱 · 执行真相
调度器 · 唯一副作用

### S3 — Operator journey (Sticky-stack OR vertical chapter stack)
Layout family: sticky-stack (if MOTION allows) else large vertical chapters
Chapters (content, not "Step 1"):
1. First Blood — 起库、起调度器、起前端
2. Cast a Task — 建项目与任务，铸画布
3. Proposal Not Power — Agent 只提案
4. Evidence Chain — finding 与派生
5. Real Sandbox — fake → real

Each chapter card:
- Title
- ≤ 40 Chinese chars purpose line
- 3-5 concrete steps
- Code/command block (mono) with real commands
- One failure-mode note (muted)

Required accurate commands in First Blood:
pnpm db:up
pnpm dev
pnpm dev:web
.env: AGENT_MODE=fake

### S4 — Discipline (Proposal model)
Layout family: 2-col split with mono tool list (not zigzag image-text for 3rd time)
Explain whitelist tools and rule engine ownership.
Show job state machine as horizontal flow (text/mono), not decorative progress bars with filled tracks.

### S5 — Hub loop
Layout family: editorial diagram block
Explain fact-intent bipartite graph, event-driven hub_reason, default off, maxHubRounds.
Include a small config snippet example (illustrative, clearly sample):
DEEPSONAR_HUB_ENABLED=false
config_json.rules.hubEnabled

### S6 — Sandbox boundary
Layout family: full-width diagram section
Emphasize: no scheduler credentials inside sandbox; env_keys whitelist; networkMode none for audit;
events via control channel not sandbox network.

Commands:
AGENT_MODE=real
npx agentbox image build --provider local-docker --file agent-harness/image.mjs

### S7 — Hardening one-pager
Layout family: grouped chunks (3 clusters), NOT long border-b table
Clusters:
并发与领取
超时与孤儿回收
幂等与指纹去重

### S8 — Closing
Layout family: full-width quiet CTA
Headline: 从假跑到真跑，同一套状态机
Primary: 打开控制台
Secondary text link: 阅读 docs/ARCHITECTURE.md 概念（as text, not second same-intent button）

### Footer
Minimal: DeepSonar · 审计调度
Links: Architecture, Local console
No build version footer, no weather, no "v0.x"

# MOTION
- Hero: short fade/rise on load (opacity + transform only)
- Chapters: whileInView stagger via Motion
- If sticky-stack used: GSAP ScrollTrigger canonical start "top top", pin true, cleanup on unmount
- Max ONE marquee on entire site (prefer zero for this product)
- Every animation needs a reason (hierarchy or storytelling). No infinite float on all cards
- prefers-reduced-motion: all non-essential motion off

# CONTENT DENSITY
- Section headline ≤ 8 Chinese words where possible
- Body blurbs short; prefer short over clever
- No 20-row tables
- Long lists → grouped clusters or 2-col, not divide-y spam

# IMAGES
If image generation is available:
- Generate one 16:9 asset for hero right panel (dark, mint accent, abstract graph, no readable fake UI text clutter)
- Optional second asset for sandbox boundary metaphor
If not available:
- Leave labeled placeholders <!-- TODO: hero visual 1600x900 -->
- Do NOT fill with fake div dashboards or hand-rolled decorative SVG illustrations

# ACCESSIBILITY & QUALITY
- WCAG AA contrast for text and buttons
- Focus-visible rings using mint mix
- Semantic landmarks: header main footer nav
- Command blocks selectable, not images of code
- Interactive buttons need :active scale 0.98
- Mobile <768: single column, px-4, no horizontal overflow
- min-h-[100dvh] for hero, never h-screen

# DELIVERABLES (all required)
1. State Design Read + dials at top of your reply
2. Create the app package files (complete source)
3. package.json scripts and workspace wiring notes
4. README for the tutorial app: how to run
5. Token CSS / Tailwind theme mapping
6. Final Pre-Flight checklist results (tick each mechanically)

# PRE-FLIGHT (must all pass before you stop)
- [ ] Design Read declared
- [ ] Dials 7/5/3 explicit
- [ ] Zero em-dash / en-dash separators in visible copy
- [ ] Page theme lock dark
- [ ] One accent mint only
- [ ] One radius system documented
- [ ] No Inter, no purple, no 3 equal feature cards
- [ ] Hero fits viewport, ≤2 line H1, CTA visible, pt max 24
- [ ] Hero stack ≤4 text elements
- [ ] Eyebrow count ≤ ceil(sections/3)
- [ ] No split-header ban violation
- [ ] No 3+ zigzag image-text sections in a row
- [ ] No duplicate CTA intent
- [ ] No scroll cues, no section numbers, no version hero labels
- [ ] No fake div product UI
- [ ] Commands match repo reality
- [ ] Motion motivated + reduced-motion safe
- [ ] Mobile collapse explicit
- [ ] Nav one line desktop ≤80px height
- [ ] ≥4 layout families across page
- [ ] Copy self-audit: no hype verbs, no invented metrics
- [ ] Chinese primary tutorial readable

# IMPLEMENTATION ORDER
1. Scaffold apps/www with Vite React TS + Tailwind v4
2. Tokens + fonts + global styles
3. Nav + Hero + truths strip
4. Journey chapters with real commands
5. Discipline + Hub + Sandbox + Hardening
6. Closing + footer
7. Motion leaves + reduced motion
8. Pre-flight fix pass
9. README

Start implementing now. Do not ask questions unless a single blocking ambiguity remains (there should be none).
```

---

## Prompt 2 — 产品壳轻改（可选，教程站完成后再跑）

```text
# ROLE
Execute redesign-existing-projects + only the applicable parts of
design-taste-frontend (type, spacing, color consistency). This is NOT a
marketing landing build.

# TARGET
DeepSonar monorepo apps/web (React 19 + @xyflow/react + Tailwind 4)
Existing dark ink/mint system in apps/web/src/styles.css must be PRESERVED
and refined, not replaced with a new brand.

# MODE
Redesign - Preserve
- Keep routes, page names, IA, API client contracts
- Keep canvas semantics (nodesDraggable=false, process surface)
- Keep mint accent and ink neutrals

# DIALS (product UI)
DESIGN_VARIANCE: 4
MOTION_INTENSITY: 3
VISUAL_DENSITY: 7

# AUDIT FIRST (write before edits)
Document:
- Current tokens (ink/acc/run/warn/crit)
- Shell layout (rail, frame, grain)
- Inconsistent radii, card overuse, type scale issues
- Any AI-slop tells

# MODERNIZE ORDER (stop when done; do not full rebrand)
1) Typography hierarchy (sizes/weight/muted)
2) Spacing rhythm in shell and page headers
3) Color recalibration (unify neutrals; keep mint)
4) Micro-interactions only on buttons/focus (no scroll hijack)
5) Empty states for Projects/Tasks/Canvas/Jobs with ONE primary CTA each

# FORBIDDEN
- Turning dashboard into bento marketing
- Purple gradients
- Replacing Noto Sans SC if it is intentional for CN product UI
- Em-dashes in new copy
- Fake metrics
- Changing API field names or route paths
- Making canvas nodes free-drag

# DELIVER
1. Audit notes
2. Minimal file-level diffs
3. Empty-state components if missing
4. Before/after token notes
5. typecheck clean for apps/web
```

---

## Prompt 3 — 先图后码（可选视觉定稿）

有图生成能力时，在 Prompt 1 之前执行：

```text
Use skill: imagegen-frontend-web

Generate ONE separate horizontal 16:9 image PER section for DeepSonar
operator tutorial site. Dark instrument aesthetic. Background near #07090b.
Single accent mint #3ddc9e. No purple, no Inter, no glossy AI blobs, no fake
OS window chrome, no readable lorem in fake UI.

Images:
1. hero-split.jpg — left negative space for type, right abstract fact/intent
   node graph with sparse mint edges
2. journey-stack.jpg — three stacked dark panels suggesting project→job→finding
3. sandbox-boundary.jpg — outer ring "scheduler", inner isolated cell "agent",
   no key icons leaking inward
4. command-strip.jpg — monospaced terminal band, only show:
   pnpm db:up / pnpm dev / pnpm dev:web
5. closing-cta.jpg — quiet charcoal field, single mint rectangular button shape

Style: premium security tool, editorial restraint, high contrast type areas,
subtle grain. No watermarks. No section numbers. No em-dashes in any text.

Output files and short alt text for each.
```

图生成后，在 Prompt 1 的 `# IMAGES` 段追加：

```text
Use these exact local assets as section visuals:
- /images/hero-split.jpg
- /images/journey-stack.jpg
- /images/sandbox-boundary.jpg
- /images/command-strip.jpg
- /images/closing-cta.jpg
Match composition closely (image-to-code discipline).
```

若要用官方图→码流水线：

```text
Use skill: image-to-code
Implement the DeepSonar tutorial page to match the generated section
images as closely as possible. Prefer full section references, not crops.
Also enforce design-taste-frontend pre-flight and the product truths from
docs/TASTE_SKILL_TUTORIAL_LANDING_PROMPTS.md Prompt 1.
Stack: Vite React TS + Tailwind v4 + Motion. Package path: apps/www.
```

---

## Prompt 4 — 工业硬核方向变体（可选替换气质）

若希望更「瑞士印刷 / 军工终端」而不是冷静软质：

```text
Use skill: industrial-brutalist-ui + design-taste-frontend

DeepSonar is a code-audit scheduler, not a consumer app.
Language: Swiss type scale contrast, hairline grids that organize REAL
content only (not decoration), mono for IDs and job status, sharp corners
OR 4px max radius.

Ban: soft pastel, glass cards, friendly mascot, "seamless AI" copy.
Copy verbs: claim, provision, reap, derive, freeze snapshot, emit finding.

Deliver a 1-page "Operator Manual" tutorial with:
- Masthead lockup
- 6 operational chapters as dense but readable strips
- One full-width diagram of the four truths (DB / Canvas / Sandbox / Scheduler)

Still honor all product truths and real commands from Prompt 1.
Dials: VARIANCE 8 / MOTION 4 / DENSITY 5
Zero em-dashes. No purple. No Inter.
```

---

## Prompt 5 — 产品内嵌首次引导空状态（可选）

```text
You are redesigning empty states and first-run guidance inside
DeepSonar (React 19 + Tailwind 4 + existing ink/mint tokens in apps/web).

Do NOT build a marketing landing page.
Use taste-skill principles for hierarchy, contrast, copy density only.

Screens:
1. Projects empty - one primary action "新建项目"
2. Task empty - explain one-task-one-canvas in ≤25 Chinese characters subtext
3. Canvas empty - show what will appear after first job (fact nodes), no fake nodes
4. Settings - role_configs vs frozen agent_snapshot_json in plain language

Rules:
- Chinese copy, concrete, no 赋能/闭环/一站式
- Max one accent (mint)
- Loading skeleton matches final layout
- Empty state has ONE primary CTA intent per screen
- Zero em-dashes
- Preserve routes and API contracts
```

---

## Prompt 6 — 操作手册纯文案（可先落 docs，后进站）

```text
Write the DeepSonar Operator Tutorial copy (Chinese).

Voice: precise, slightly dry, instrument manual. No startup hype.
Structure as 7 chapters:
0. The Instrument — 四层真相
1. First Blood — 起库与双进程
2. Cast a Task — 项目 / 任务 / 画布
3. Proposal, Not Power — 白名单与规则引擎
4. Hub Loop — fact-intent，默认关
5. Evidence Chain — finding 与派生
6. Real Sandbox — fake → real
7. Hardening — 并发、reaper、幂等、凭据边界

Each chapter:
- 1-line purpose
- 3-6 concrete steps with real commands from the repo
- 1 "failure mode" callout
- 1 "why the system is designed this way" note

Commands that must appear accurately:
pnpm db:up
pnpm dev
pnpm dev:web
AGENT_MODE=fake / real
python agent-harness/test-local-project-api.py
npx agentbox image build --provider local-docker --file agent-harness/image.mjs

Never invent metrics. Never use em-dash. Never say 赋能/无缝/下一代.
Output as Markdown suitable for docs/OPERATOR_MANUAL.md
```

---

## 超级合并版（只想复制一次）

```text
Execute design-taste-frontend (Taste Skill v2) + full-output-enforcement.

Build COMPLETE apps/www tutorial site for DeepSonar (multi-project
code-audit scheduler). Chinese primary. Dark precision instrument.

Design Read: B2B security-ops landing+tutorial for engineers; dark instrument;
Geist + mint; not AI SaaS.

Dials: VARIANCE 7 / MOTION 5 / DENSITY 3.

Truths: Local DB only truth; Canvas process truth; Sandbox execution truth;
Scheduler only side effects. Agents propose only via emit_progress,
emit_finding, mark_job_done, request_human. Rule engine derives verify.
Hub fact-intent event-driven, default off. AGENT_MODE fake|real.
Plane optional; default local project/task API.
Commands exact: pnpm db:up; pnpm dev; pnpm dev:web; pnpm build; pnpm typecheck;
python agent-harness/test-local-project-api.py;
npx agentbox image build --provider local-docker --file agent-harness/image.mjs

Visual lock: bg #07090b, accent #3ddc9e only, hairlines, radius 12, Phosphor
icons only, no Inter, no purple, no em-dash, no en-dash separators, no 3 equal
cards, no centered hero, no scroll cues, no section numbers, no fake dashboards,
no invented metrics, no 赋能/无缝/下一代.

Stack: Vite React TS + Tailwind v4 + Motion; GSAP only for sticky-stack with
cleanup; self-host fonts; new package apps/www; do not break apps/web.

Page sections (≥4 layout families):
1 Nav ≤72px + CTA「打开控制台」
2 Asymmetric hero「可回放的审计过程」sub「本地库记真相，画布记过程，沙箱只执行。」
3 Four truths strip
4 Sticky or chapter journey: First Blood / Cast Task / Proposal / Evidence / Real Sandbox with real commands
5 Discipline + state machine mono flow
6 Hub loop diagram + default off
7 Sandbox credential boundary
8 Hardening 3 clusters
9 Quiet closing CTA + minimal footer

Motion: motivated only; reduced-motion safe; max one marquee (prefer 0).
Images: generate if possible else labeled TODO slots, never fake div UI.
Deliver full source + README + tokens + mechanical pre-flight checklist all green.
Implement now end-to-end.
```

---

## 推荐执行顺序

```
1. (可选) Prompt 3  → 5 张 section 参考图
2. Prompt 1 或 超级合并版 → apps/www 完整落地
3. (可选) Prompt 6 → docs/OPERATOR_MANUAL.md 文案沉淀
4. (可选) Prompt 2 → apps/web 壳层轻改
5. (可选) Prompt 5 → 产品内空状态
```

## 与仓库其它文档的关系

| 文档 | 关系 |
|------|------|
| `docs/ARCHITECTURE.md` | 产品真相源；Prompt 不得与之矛盾 |
| `docs/ONE_CLICK_DEPLOYMENT.md` | 部署细节；教程站只链过去，不重复发明 |
| `docs/TASTE_SKILL_TUTORIAL_LANDING_PROMPTS.md` | 本文：视觉与落地指令源 |

---

## 验收速查（交付后人工扫一眼）

- [ ] `apps/www` 可 `pnpm dev:www` 独立打开
- [ ] 命令与仓库一致，无编造 API
- [ ] 全站 dark + 单 mint 强调
- [ ] 无 em-dash、无紫光、无三等分营销卡
- [ ] Hero 首屏完整，主 CTA 可见
- [ ] 中文可读，语气像操作手册而非创业路演
- [ ] 未改坏 `apps/web` / `apps/scheduler`
```
