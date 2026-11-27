import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { projectKnowledgeApi } from "../ProjectKnowledgeApi";

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
  onRefresh: () => void;
}

export function useProjectKnowledgeMaintenance(input: MaintenanceInput) {
  const { projectId, selectedId, versionId, refreshKey, onSelectItem, onRefresh } = input;
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
  const [editBusy, setEditBusy] = useState(false);
  const [editNotice, setEditNotice] = useState<string | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  // 一次下架对应一张可消费回执：撤销后回执消失，允许再次下架与再次撤销。
  const [archiveReceipts, setArchiveReceipts] = useState<Record<string, { receiptId: string }>>({});
  const [undoBusy, setUndoBusy] = useState(false);

  const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
  // 切条目、切版本或刷新后旧草稿一律作废：草稿只属于打开它时的「项目+条目+基准版本」。
  useEffect(() => {
    setEditDraft(null); setEditNotice(null); setEditError(null);
  }, [selectedId, versionId, projectId]);

  const editActive = Boolean(editDraft && editDraft.itemId === selectedId && editDraft.versionId === versionId);
  const draftKey = useMemo(() => generatedLogicalKey(draftTitle, draftSuffix), [draftTitle, draftSuffix]);
  const canUndoArchive = useCallback((itemId: string) => Boolean(archiveReceipts[itemId]), [archiveReceipts]);

  const currentProject = useRef(projectId);
  currentProject.current = projectId;
  const submitCreate = useCallback(() => {
    // 请求与草稿都绑定打开表单时的项目；迟到的回调只更新它自己的项目。
    const requestProject = projectId;
    // 用「提交时的内容快照」判断这份草稿是否已被用户改过，而不是用逻辑键后缀。
    const submitSnapshot = { title: draftTitle, content: draftContent };
    patchSubmit(requestProject, { busy: true, notice: null, error: null });
    projectKnowledgeApi.create(requestProject, {
      kind: "memory", logical_key: draftKey, title: draftTitle.trim(), content: draftContent,
    }).then((result) => {
      // 只清「这一次提交」的那代草稿：等待期间用户重新输入的内容不能被回执覆盖。
      const unchanged = ((): boolean => {
        const current = draftsRef.current[requestProject];
        if (!current) return true;
        return current.title === submitSnapshot.title && current.content === submitSnapshot.content;
      })();
      if (unchanged) {
        setDrafts((map) => {
          const next = { ...map };
          delete next[requestProject];
          return next;
        });
      }
      if (currentProject.current !== requestProject) {
        patchSubmit(requestProject, { busy: false, notice: "新建知识成功（在其它项目完成）" });
        return;
      }
      if (!unchanged) {
        // 用户已经接着输入新内容：保留草稿，也不自动切走当前编辑。
        patchSubmit(requestProject, { busy: false, notice: "上一次提交已成功；当前草稿已保留" });
        return;
      }
      patchSubmit(requestProject, { busy: false, notice: "新建知识成功，已打开该条目" });
      onSelectItem(result.item_ref);
      onRefresh();
    }).catch((error) => patchSubmit(requestProject, { busy: false, error: message(error) }));
  }, [projectId, draftTitle, draftContent, draftKey, draftSuffix, onSelectItem, onRefresh, patchSubmit]);

  const submitEdit = useCallback(() => {
    if (!editDraft) return;
    setEditBusy(true); setEditNotice(null); setEditError(null);
    projectKnowledgeApi.revise(projectId, editDraft.itemId, {
      expected_version: editDraft.expectedVersion, title: editDraft.title.trim(), content: editDraft.content,
      ...(editDraft.reason?.trim() ? { reason: editDraft.reason.trim() } : {}),
    }).then((result) => {
      setEditDraft(null); setEditNotice(`已生成 v${result.version}`); onRefresh();
    }).catch((error) => setEditError(message(error))).finally(() => setEditBusy(false));
  }, [projectId, editDraft, onRefresh]);

  const archiveItem = useCallback((itemId: string) => {
    setUndoBusy(true); patchSubmit(projectId, { error: null });
    projectKnowledgeApi.archive(projectId, itemId)
      .then(() => { setArchiveReceipts((map) => ({ ...map, [itemId]: { receiptId: `${itemId}:${Date.now()}` } })); onRefresh(); })
      .catch((error) => patchSubmit(projectId, { error: message(error) }))
      .finally(() => setUndoBusy(false));
  }, [projectId, onRefresh]);

  const undoArchive = useCallback((itemId: string) => {
    setUndoBusy(true); patchSubmit(projectId, { error: null });
    projectKnowledgeApi.restore(projectId, itemId)
      .then(() => { setArchiveReceipts((map) => { const next = { ...map }; delete next[itemId]; return next; }); onRefresh(); })
      .catch((error) => patchSubmit(projectId, { error: message(error) }))
      .finally(() => setUndoBusy(false));
  }, [projectId, onRefresh]);

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
