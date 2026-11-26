import { useCallback, useEffect, useMemo, useState } from "react";
import { projectKnowledgeApi } from "../ProjectKnowledgeApi";

export interface EditDraft {
  itemId: string;
  versionId: string;
  expectedVersion: number;
  title: string;
  content: string;
}

/** 逻辑键由系统生成：用户只填标题，避免手写标识与后端格式/唯一性冲突。 */
export function generatedLogicalKey(title: string): string {
  const slug = title.trim().toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 100);
  return `human-${slug || "note"}`;
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
  const [createOpen, setCreateOpen] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftContent, setDraftContent] = useState("");
  const [createBusy, setCreateBusy] = useState(false);
  const [createNotice, setCreateNotice] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<EditDraft | null>(null);
  const [editBusy, setEditBusy] = useState(false);
  const [editNotice, setEditNotice] = useState<string | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [archivedHere, setArchivedHere] = useState<string[]>([]);
  const [undoneHere, setUndoneHere] = useState<string[]>([]);
  const [undoBusy, setUndoBusy] = useState(false);

  const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
  // 切条目、切版本或刷新后旧草稿一律作废：草稿只属于打开它时的「项目+条目+基准版本」。
  useEffect(() => {
    setEditDraft(null); setEditNotice(null); setEditError(null);
  }, [selectedId, versionId, refreshKey, projectId]);

  const editActive = Boolean(editDraft && editDraft.itemId === selectedId && editDraft.versionId === versionId);

  const submitCreate = useCallback(() => {
    setCreateBusy(true); setCreateNotice(null); setCreateError(null);
    projectKnowledgeApi.create(projectId, {
      kind: "memory", logical_key: generatedLogicalKey(draftTitle), title: draftTitle.trim(), content: draftContent,
    }).then((result) => {
      setCreateOpen(false); setDraftTitle(""); setDraftContent("");
      setCreateNotice("新建知识成功，已打开该条目");
      onSelectItem(result.item_ref);
      onRefresh();
    }).catch((error) => setCreateError(message(error))).finally(() => setCreateBusy(false));
  }, [projectId, draftTitle, draftContent, onSelectItem, onRefresh]);

  const submitEdit = useCallback(() => {
    if (!editDraft) return;
    setEditBusy(true); setEditNotice(null); setEditError(null);
    projectKnowledgeApi.revise(projectId, editDraft.itemId, {
      expected_version: editDraft.expectedVersion, title: editDraft.title.trim(), content: editDraft.content,
    }).then((result) => {
      setEditDraft(null); setEditNotice(`已生成 v${result.version}`); onRefresh();
    }).catch((error) => setEditError(message(error))).finally(() => setEditBusy(false));
  }, [projectId, editDraft, onRefresh]);

  const archiveItem = useCallback((itemId: string) => {
    setUndoBusy(true); setCreateError(null);
    projectKnowledgeApi.archive(projectId, itemId)
      .then(() => { setArchivedHere((list) => [...new Set([...list, itemId])]); onRefresh(); })
      .catch((error) => setCreateError(message(error)))
      .finally(() => setUndoBusy(false));
  }, [projectId, onRefresh]);

  const undoArchive = useCallback((itemId: string) => {
    setUndoBusy(true); setCreateError(null);
    projectKnowledgeApi.restore(projectId, itemId)
      .then(() => { setUndoneHere((list) => [...new Set([...list, itemId])]); onRefresh(); })
      .catch((error) => setCreateError(message(error)))
      .finally(() => setUndoBusy(false));
  }, [projectId, onRefresh]);

  const openEdit = useCallback((draft: EditDraft) => {
    setEditDraft(draft); setEditNotice(null); setEditError(null);
  }, []);

  const draftKey = useMemo(() => generatedLogicalKey(draftTitle), [draftTitle]);

  return {
    createOpen, setCreateOpen, draftTitle, setDraftTitle, draftContent, setDraftContent, draftKey,
    createBusy, createNotice, createError, submitCreate,
    editDraft, setEditDraft, editActive, editBusy, editNotice, editError, submitEdit, openEdit,
    archivedHere, undoneHere, undoBusy, archiveItem, undoArchive,
  };
}
