import { CaretDown, Check, MagnifyingGlass, X } from "@phosphor-icons/react";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { filterSelectOptions, toggleMultiValue, type SelectOption } from "./searchable-select-model";

interface BaseProps {
  options: readonly SelectOption[];
  placeholder: string;
  label?: string;
  ariaLabel?: string;
  className?: string;
  emptyText?: string;
  clearable?: boolean;
}

interface SearchableSelectProps extends BaseProps {
  value: string;
  onChange: (value: string) => void;
}

interface SearchableMultiSelectProps extends BaseProps {
  value: readonly string[];
  onChange: (value: string[]) => void;
}

function SelectPopup({ options, selected, multiple, clearable, onSelect, onClear, onClose, anchor, popupId, emptyText }: {
  options: readonly SelectOption[];
  selected: readonly string[];
  multiple: boolean;
  clearable: boolean;
  onSelect: (value: string) => void;
  onClear: () => void;
  onClose: () => void;
  anchor: HTMLElement;
  popupId: string;
  emptyText: string;
}) {
  const popupRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [position, setPosition] = useState({ top: 0, left: 0, width: 260, above: false });
  const visible = filterSelectOptions(options, query);

  useEffect(() => setActiveIndex(0), [query]);

  const updatePosition = useCallback(() => {
    const rect = anchor.getBoundingClientRect();
    const width = Math.min(Math.max(rect.width, 260), Math.max(280, window.innerWidth - 24));
    const estimatedHeight = Math.min(360, 112 + options.length * 34);
    const above = window.innerHeight - rect.bottom < estimatedHeight && rect.top > estimatedHeight;
    setPosition({
      top: above ? Math.max(12, rect.top - estimatedHeight - 6) : rect.bottom + 6,
      left: Math.min(Math.max(12, rect.left), Math.max(12, window.innerWidth - width - 12)),
      width,
      above,
    });
  }, [anchor, options.length]);

  useLayoutEffect(() => {
    updatePosition();
    searchRef.current?.focus();
  }, [updatePosition]);

  useEffect(() => {
    const reposition = () => updatePosition();
    const dismiss = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!popupRef.current?.contains(target) && !anchor.contains(target)) onClose();
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        anchor.focus();
      }
    };
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", keydown);
    return () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", keydown);
    };
  }, [anchor, onClose, updatePosition]);

  const maxHeight = position.above ? "360px" : "min(360px, calc(100vh - " + (position.top + 12) + "px))";
  return createPortal(
    <div ref={popupRef} id={popupId} role="listbox" aria-multiselectable={multiple || undefined}
      className="searchable-select-popup fixed z-[140] overflow-hidden rounded-lg border border-white/[.1] bg-[#111619] shadow-2xl shadow-black/50"
      style={{ top: position.top, left: position.left, width: position.width, maxHeight, color: "var(--text)", background: "var(--panel-raised)", borderColor: "var(--line-strong)" }}>
      <div className="border-b border-white/[.07] p-2">
        <label className="flex h-9 items-center gap-2 rounded-md border border-white/[.08] bg-black/20 px-2.5 focus-within:border-acc-400/35">
          <MagnifyingGlass size={14} className="shrink-0 text-zinc-500" aria-hidden="true" />
          <input ref={searchRef} value={query} onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setActiveIndex((current) => visible.length ? (current + 1) % visible.length : 0);
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setActiveIndex((current) => visible.length ? (current - 1 + visible.length) % visible.length : 0);
              } else if (event.key === "Enter" && visible[activeIndex] && !visible[activeIndex].disabled) {
                event.preventDefault();
                onSelect(visible[activeIndex].value);
              }
            }}
            aria-activedescendant={visible[activeIndex] ? popupId + "-option-" + activeIndex : undefined}
            className="min-w-0 flex-1 bg-transparent text-[12px] text-zinc-200 outline-none placeholder:text-zinc-600"
            placeholder="搜索选项…" aria-label="搜索选项" />
          {query && <button type="button" onClick={() => setQuery("")} className="text-zinc-600 hover:text-zinc-300" aria-label="清空搜索"><X size={13} /></button>}
        </label>
      </div>
      <div className="max-h-[250px] overflow-y-auto p-1.5">
        {visible.length ? visible.map((option, index) => {
          const checked = selected.includes(option.value);
          const highlighted = index === activeIndex;
          const rowClass = "flex min-h-8 w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[12px] transition-colors disabled:opacity-35 " + (checked ? "bg-acc-500/[.12] text-acc-200" : highlighted ? "bg-white/[.05] text-zinc-200" : "text-zinc-400 hover:bg-white/[.05] hover:text-zinc-200");
          const markClass = "grid size-4 shrink-0 place-items-center border " + (multiple ? "rounded " : "rounded-full ") + (checked ? "border-acc-400/50 bg-acc-500/20 text-acc-300" : "border-white/[.12] text-transparent");
          return <button id={popupId + "-option-" + index} key={option.value} type="button" role="option" aria-selected={checked} disabled={option.disabled} onMouseEnter={() => setActiveIndex(index)} onClick={() => onSelect(option.value)} className={rowClass}>
            <span className={markClass}><Check size={10} weight="bold" /></span>
            <span className="min-w-0 flex-1 truncate">{option.label}</span>
          </button>;
        }) : <div className="px-3 py-8 text-center text-[11px] text-zinc-600">{emptyText}</div>}
      </div>
      {(multiple || (clearable && selected.length > 0)) && <div className="flex items-center justify-between border-t border-white/[.07] px-2.5 py-2">
        <span className="font-mono text-[9px] text-zinc-600">{multiple ? "已选 " + selected.length + " 项" : "单选"}</span>
        <div className="flex items-center gap-1.5">
          {clearable && selected.length > 0 && <button type="button" onClick={onClear} className="rounded px-2 py-1 text-[10px] text-zinc-500 hover:bg-white/[.05] hover:text-zinc-200">清空</button>}
          {multiple && <button type="button" onClick={onClose} className="rounded bg-acc-500/[.12] px-2.5 py-1 text-[10px] text-acc-200 ring-1 ring-acc-400/20">完成</button>}
        </div>
      </div>}
    </div>, document.body,
  );
}

function Trigger({ selectedLabels, placeholder, label, ariaLabel, open, popupId, triggerRef, onToggle, className }: {
  selectedLabels: string[];
  placeholder: string;
  label?: string;
  ariaLabel?: string;
  open: boolean;
  popupId: string;
  triggerRef: RefObject<HTMLButtonElement | null>;
  onToggle: () => void;
  className?: string;
}) {
  const content: ReactNode = selectedLabels.length === 0
    ? <span className="text-zinc-500">{placeholder}</span>
    : selectedLabels.length === 1
      ? <span className="truncate">{selectedLabels[0]}</span>
      : <span className="truncate">{selectedLabels[0]} <span className="text-acc-300">+{selectedLabels.length - 1}</span></span>;
  return <div className={className ?? "filter-control"}>
    {label && <span>{label}</span>}
    <button ref={triggerRef} type="button" role="combobox" aria-label={ariaLabel ?? label ?? placeholder}
      aria-expanded={open} aria-controls={open ? popupId : undefined} aria-haspopup="listbox" onClick={onToggle}
      style={{ color: "var(--text)", background: "var(--surface-tint)", borderColor: "var(--line)" }}
      className="searchable-select-trigger flex min-h-8 min-w-[9rem] items-center justify-between gap-2 rounded-md border border-white/[.08] bg-black/15 px-2.5 py-1.5 text-left text-[11px] text-zinc-300 outline-none transition-colors hover:border-white/[.14] focus:border-acc-400/35">
      <span className="min-w-0 flex-1">{content}</span>
      <CaretDown size={12} className={"shrink-0 text-zinc-600 transition-transform " + (open ? "rotate-180" : "")} aria-hidden="true" />
    </button>
  </div>;
}

export function SearchableSelect({ value, onChange, options, placeholder, label, ariaLabel, className, emptyText = "没有匹配选项", clearable = true }: SearchableSelectProps) {
  const popupId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const selectedLabels = options.filter((option) => option.value === value).map((option) => option.label);
  return <>
    <Trigger selectedLabels={selectedLabels} placeholder={placeholder} label={label} ariaLabel={ariaLabel} open={open} popupId={popupId} triggerRef={triggerRef} onToggle={() => setOpen((current) => !current)} className={className} />
    {open && triggerRef.current && <SelectPopup options={options} selected={value ? [value] : []} multiple={false} clearable={clearable}
      onSelect={(next) => { onChange(next); setOpen(false); }} onClear={() => { onChange(""); setOpen(false); }} onClose={() => setOpen(false)} anchor={triggerRef.current} popupId={popupId} emptyText={emptyText} />}
  </>;
}

export function SearchableMultiSelect({ value, onChange, options, placeholder, label, ariaLabel, className, emptyText = "没有匹配选项" }: SearchableMultiSelectProps) {
  const popupId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const selectedLabels = options.filter((option) => value.includes(option.value)).map((option) => option.label);
  return <>
    <Trigger selectedLabels={selectedLabels} placeholder={placeholder} label={label} ariaLabel={ariaLabel} open={open} popupId={popupId} triggerRef={triggerRef} onToggle={() => setOpen((current) => !current)} className={className} />
    {open && triggerRef.current && <SelectPopup options={options} selected={value} multiple clearable
      onSelect={(next) => onChange(toggleMultiValue(value, next))} onClear={() => onChange([])} onClose={() => setOpen(false)} anchor={triggerRef.current} popupId={popupId} emptyText={emptyText} />}
  </>;
}
