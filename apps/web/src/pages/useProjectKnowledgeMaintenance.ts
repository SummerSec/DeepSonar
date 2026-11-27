import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { projectKnowledgeApi } from "../ProjectKnowledgeApi";

/** 保存成功后决定编辑草稿的去留：内容没再变就收起，变了就挪到新版本上继续写。 */
export function rebaseEditDraft(current: EditDraft | null, snapshot: EditDraft,
  result: { version: number; version_ref: string }): EditDraft | null {
  if (!current || current.itemId !== snapshot.itemId) return current;
  const untouched = current.title === snapshot.title && current.content === snapshot.content
    && current.reason === snapshot.reason;
  if (untouched) return null;
  return { ...current, versionId: result.version_ref, expectedVersion: result.version };
}

/** 切条目/切版本后的草稿去留：同条目同版本保留，刚被保存挪到新版本的草稿多活一轮。 */
export function nextEditDraft(current: EditDraft | null, context: {
  selectedId: string | null; versionId: string | null; keepRebased: boolean;
}): EditDraft | null {
  if (!current || current.itemId !== context.selectedId) return null;
  if (current.versionId === context.versionId) return current;
  return context.keepRebased ? current : null;
}

export interface EditDraft {
  itemId: string;
  versionId: string;
  expectedVersion: number;
  title: string;
  content: string;
  /** 可选修订原因，随这一版一起保存。 */
  reason?: string;
}

/**
 * 逻辑键由系统生成：纯中文标题折叠后为空，同名英文也会撞，所以再带一个
 * 本份草稿固定的短后缀——同一份草稿重试时不变，不同草稿（含连续新建两条
 * 中文标题）不会互相占用同一个标识。
 */
export function generatedLogicalKey(title: string, draftSuffix: string): string {
  const slug = title.trim().toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 80);
  return `human-${slug || "note"}-${draftSuffix}`;
}

export interface MaintenanceInput {
  projectId: string;
  selectedId: string | null;
  versionId: string | null;
  refreshKey: number;
  onSelectItem: (itemId: string) => void;
  onSelectVersion?: (versionId: string) => void;
  onRefresh: () => void;
}

export function useProjectKnowledgeMaintenance(input: MaintenanceInput) {
  const { projectId, selectedId, versionId, refreshKey, onSelectItem, onSelectVersion, onRefresh } = input;
  // 新建草稿按项目隔离：切到别的项目不会带着上一个项目的正文，回到原项目还能接着写。
  interface CreateDraft { open: boolean; title: string; content: string; suffix: string }
  const [drafts, setDrafts] = useState<Record<string, CreateDraft>>({});
  const draftsRef = useRef<Record<string, CreateDraft>>({});
  draftsRef.current = drafts;
  const newSuffix = (): string => Math.random().toString(36).slice(2, 8);
  const draft: CreateDraft = drafts[projectId] ?? { open: false, title: "", content: "", suffix: newSuffix() };
  const updateDraft = useCallback((change: Partial<CreateDraft>) => {
    setDrafts((map) => {
      const current = map[projectId] ?? { open: false, title: "", content: "", suffix: newSuffix() };
      return { ...map, [projectId]: { ...current, ...change } };
    });
  }, [projectId]);
  const createOpen = draft.open;
  const setCreateOpen = useCallback((value: boolean) => updateDraft({ open: value }), [updateDraft]);
  const draftTitle = draft.title;
  const setDraftTitle = useCallback((value: string) => updateDraft({ title: value }), [updateDraft]);
  const draftContent = draft.content;
  const setDraftContent = useCallback((value: string) => updateDraft({ content: value }), [updateDraft]);
  const draftSuffix = draft.suffix;
  // 提交状态与反馈也按项目隔离：A 的进行中/失败不影响 B 的按钮与提示。
  interface SubmitState { busy: boolean; notice: string | null; error: string | null }
  const [submits, setSubmits] = useState<Record<string, SubmitState>>({});
  const submitState = submits[projectId] ?? { busy: false, notice: null, error: null };
  const patchSubmit = useCallback((target: string, change: Partial<SubmitState>) => {
    setSubmits((map) => {
      const base: SubmitState = map[target] ?? { busy: false, notice: null, error: null };
      return { ...map, [target]: { ...base, ...change } };
    });
  }, []);
  const createBusy = submitState.busy;
  const createNotice = submitState.notice;
  const createError = submitState.error;
  const [editDraft, setEditDraft] = useState<EditDraft | null>(null);
  const editDraftRef = useRef<EditDraft | null>(null);
  editDraftRef.current = editDraft;
  const keepRebasedDraft = useRef(false);
  const [editBusy, setEditBusy] = useState(false);
  const [editNotice, setEditNotice] = useState<string | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  // 一次下架对应一张可消费回执：撤销后回执消失，允许再次下架与再次撤销。
  const [archiveReceipts, setArchiveReceipts] = useState<Record<string, { receiptId: string }>>({});
  const [undoBusy, setUndoBusy] = useState(false);

  const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
  // 切条目或切版本后旧草稿一律作废：草稿只属于打开它时的「项目+条目+基准版本」。
  // 例外：保存成功后草稿已经挪到新版本上（versionId 等于当前版本），此时要保留它继续写。
  const noticeScope = useRef({ projectId, selectedId });
  useEffect(() => {
    if (noticeScope.current.projectId !== projectId || noticeScope.current.selectedId !== selectedId) {
      noticeScope.current = { projectId, selectedId };
      setEditNotice(null); setEditError(null);
    }
    const keepRebased = keepRebasedDraft.current;
    keepRebasedDraft.current = false;
    setEditDraft((current) => nextEditDraft(current, { selectedId, versionId, keepRebased }));
  }, [selectedId, versionId, projectId]);

  const editActive = Boolean(editDraft && editDraft.itemId === selectedId && editDraft.versionId === versionId);
  const draftKey = useMemo(() => generatedLogicalKey(draftTitle, draftSuffix), [draftTitle, draftSuffix]);
  const canUndoArchive = useCallback((itemId: string) => Boolean(archiveReceipts[itemId]), [archiveReceipts]);

  const currentProject = useRef(projectId);
  const requestProjectRef = useRef(projectId);
  requestProjectRef.current = projectId;
  currentProject.current = projectId;
  // 提交成功后的处理抽成独立函数：判断草稿是否被继续编辑过、必要时保留草稿并换新标识。
  const settleCreate = useCallback((requestProject: string, snapshot: { title: string; content: string },
    itemRef: string, suffixAfterSubmit: string): void => {
    const current = draftsRef.current[requestProject];
    const unchanged = !current || (current.title === snapshot.title && current.content === snapshot.content);
    setDrafts((map) => {
      if (unchanged) {
        const next = { ...map };
        delete next[requestProject];
        return next;
      }
      const kept = map[requestProject];
      if (!kept) return map;
      return { ...map, [requestProject]: { ...kept, suffix: suffixAfterSubmit } };
    });
    if (currentProject.current !== requestProject) {
      patchSubmit(requestProject, { busy: false, notice: "新建知识成功（在其它项目完成）" });
      return;
    }
    if (!unchanged) {
      patchSubmit(requestProject, { busy: false, notice: "上一次提交已成功；当前草稿已保留，可继续提交" });
      return;
    }
    patchSubmit(requestProject, { busy: false, notice: "新建知识成功，已打开该条目" });
    onSelectItem(itemRef);
    onRefresh();
  }, [patchSubmit, onSelectItem, onRefresh]);

  const submitCreate = useCallback(() => {
    // 请求与草稿都绑定打开表单时的项目；迟到的回调只更新它自己的项目。
    const requestProject = projectId;
    const snapshot = { title: draftTitle, content: draftContent };
    patchSubmit(requestProject, { busy: true, notice: null, error: null });
    projectKnowledgeApi.create(requestProject, {
      kind: "memory", logical_key: draftKey, title: draftTitle.trim(), content: draftContent,
    }).then((result) => settleCreate(requestProject, snapshot, result.item_ref, newSuffix()))
      .catch((error) => patchSubmit(requestProject, { busy: false, error: message(error) }));
  }, [projectId, draftTitle, draftContent, draftKey, patchSubmit, settleCreate]);

  // 编辑保存后的结算抽成独立函数：内容与快照一致才收起，否则挪到新版本上继续写。
  const editRequest = useRef<{ requestId: number; projectId: string; itemId: string } | null>(null);
  const settleEdit = useCallback((snapshot: EditDraft, requestId: number, result: { version: number; version_ref: string }): void => {
    // 回执只对「这次请求 + 当前项目与条目」生效：切到别的项目/条目后，迟到的成功或失败都不能改当前编辑。
    if (editRequest.current?.requestId !== requestId) return;
    editRequest.current = null;
    editBusyRef.current = false;
    setEditBusy(false);
    if (currentProject.current !== requestProjectRef.current) return;
    // 同步算出草稿去留：setState 的更新函数是渲染期才执行，不能在里面取结果。
    const next = rebaseEditDraft(editDraftRef.current, snapshot, result);
    const keptDraft = Boolean(next && next !== editDraftRef.current);
    keepRebasedDraft.current = keptDraft;
    setEditDraft(next);
    if (keptDraft) onSelectVersion?.(result.version_ref);
    setEditNotice(`已生成 v${result.version}`);
    onRefresh();
  }, [onRefresh]);

  const editBusyRef = useRef(false);
  const failEdit = useCallback((requestId: number, projectIdOfRequest: string, error: unknown): void => {
    if (editRequest.current?.requestId !== requestId) return;
    editRequest.current = null;
    editBusyRef.current = false;
    setEditBusy(false);
    if (currentProject.current !== projectIdOfRequest) return;
    setEditError(message(error));
  }, []);
  const submitEdit = useCallback(() => {
    if (!editDraft || editBusyRef.current) return;
    const snapshot = editDraft;
    const requestId = Date.now() + Math.random();
    editRequest.current = { requestId, projectId, itemId: snapshot.itemId };
    editBusyRef.current = true;
    setEditBusy(true);
    setEditError(null);
    projectKnowledgeApi.revise(projectId, snapshot.itemId, {
      expected_version: snapshot.expectedVersion, title: snapshot.title.trim(), content: snapshot.content,
      ...(snapshot.reason?.trim() ? { reason: snapshot.reason.trim() } : {}),
    }).then((result) => settleEdit(snapshot, requestId, result))
      .catch((error) => failEdit(requestId, projectId, error))
      .finally(() => { editBusyRef.current = false; });
  }, [projectId, editDraft, settleEdit, failEdit]);

  const archiveItem = useCallback((itemId: string) => {
    setUndoBusy(true); patchSubmit(projectId, { error: null });
    projectKnowledgeApi.archive(projectId, itemId)
      .then(() => { setArchiveReceipts((map) => ({ ...map, [itemId]: { receiptId: `${itemId}:${Date.now()}` } })); onRefresh(); })
      .catch((error) => patchSubmit(projectId, { error: message(error) }))
      .finally(() => setUndoBusy(false));
  }, [projectId, onRefresh, patchSubmit]);

  const undoArchive = useCallback((itemId: string) => {
    setUndoBusy(true); patchSubmit(projectId, { error: null });
    projectKnowledgeApi.restore(projectId, itemId)
      .then(() => { setArchiveReceipts((map) => { const next = { ...map }; delete next[itemId]; return next; }); onRefresh(); })
      .catch((error) => patchSubmit(projectId, { error: message(error) }))
      .finally(() => setUndoBusy(false));
  }, [projectId, onRefresh, patchSubmit]);

  const openEdit = useCallback((draft: EditDraft) => {
    setEditDraft(draft); setEditNotice(null); setEditError(null);
  }, []);


  return {
    createOpen, setCreateOpen, draftTitle, setDraftTitle, draftContent, setDraftContent, draftKey,
    createBusy, createNotice, createError, submitCreate,
    editDraft, setEditDraft, editActive, editBusy, editNotice, editError, submitEdit, openEdit,
    archiveReceipts, canUndoArchive, undoBusy, archiveItem, undoArchive,
  };
}
