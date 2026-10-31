import { CaretDown, Check, MagnifyingGlass, X } from "@phosphor-icons/react";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { filterSelectOptions, optionTitle, toggleMultiValue, type SelectOption } from "./searchable-select-model";

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
    const width = Math.min(Math.max(rect.width, 360), Math.max(24, window.innerWidth - 24));
    const estimatedHeight = Math.min(420, 112 + options.length * 44);
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
      className="searchable-select-popup theme-drawer fixed z-[140] overflow-hidden rounded-lg border shadow-2xl"
      style={{ top: position.top, left: position.left, width: position.width, maxHeight }}>
      <div className="searchable-select-popup-search border-b p-2">
        <label className="flex h-9 items-center gap-2 rounded-md border px-2.5 focus-within:border-acc-400/35">
          <MagnifyingGlass size={14} className="theme-muted shrink-0" aria-hidden="true" />
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
            className="min-w-0 flex-1 bg-transparent text-[12px] text-[var(--text)] outline-none placeholder:text-[var(--muted)]"
            placeholder="搜索选项…" aria-label="搜索选项" />
          {query && <button type="button" onClick={() => setQuery("")} className="theme-muted hover:text-[var(--text)]" aria-label="清空搜索"><X size={13} /></button>}
        </label>
      </div>
      <div className="max-h-[250px] overflow-y-auto p-1.5">
        {visible.length ? visible.map((option, index) => {
          const checked = selected.includes(option.value);
          const highlighted = index === activeIndex;
          const rowClass = "flex min-h-8 w-full items-start gap-2 rounded-md px-2.5 py-1.5 text-left text-[12px] transition-colors disabled:opacity-35 " + (checked ? "bg-acc-500/[.12] text-acc-400" : highlighted ? "bg-[var(--surface-tint-strong)] text-[var(--text)]" : "text-[var(--muted)] hover:bg-[var(--surface-tint-strong)] hover:text-[var(--text)]");
          const markClass = "grid size-4 shrink-0 place-items-center border mt-0.5 " + (multiple ? "rounded " : "rounded-full ") + (checked ? "border-acc-400/50 bg-acc-500/20 text-acc-400" : "border-[var(--line-strong)] text-transparent");
          return <button id={popupId + "-option-" + index} key={option.value} type="button" role="option" aria-selected={checked} disabled={option.disabled} title={optionTitle(option)} onMouseEnter={() => setActiveIndex(index)} onClick={() => onSelect(option.value)} className={rowClass}>
            <span className={markClass}><Check size={10} weight="bold" /></span>
            <span className="min-w-0 flex-1">
              <span className="block whitespace-normal break-words">{option.label}</span>
              {option.hint ? <span className="theme-muted mt-0.5 block text-[10px] leading-4">{option.hint}</span> : null}
            </span>
          </button>;
        }) : <div className="theme-muted px-3 py-8 text-center text-[11px]">{emptyText}</div>}
      </div>
      {(multiple || (clearable && selected.length > 0)) && <div className="theme-divider flex items-center justify-between border-t px-2.5 py-2">
        <span className="theme-muted font-mono text-[9px]">{multiple ? "已选 " + selected.length + " 项" : "单选"}</span>
        <div className="flex items-center gap-1.5">
          {clearable && selected.length > 0 && <button type="button" onClick={onClear} className="theme-muted rounded px-2 py-1 text-[10px] hover:bg-[var(--surface-tint-strong)] hover:text-[var(--text)]">清空</button>}
          {multiple && <button type="button" onClick={onClose} className="rounded bg-acc-500/[.12] px-2.5 py-1 text-[10px] text-acc-400 ring-1 ring-acc-400/20">完成</button>}
        </div>
      </div>}
    </div>, document.body,
  );
}

function Trigger({ selectedOptions, placeholder, label, ariaLabel, open, popupId, triggerRef, onToggle, className }: {
  selectedOptions: readonly SelectOption[];
  placeholder: string;
  label?: string;
  ariaLabel?: string;
  open: boolean;
  popupId: string;
  triggerRef: RefObject<HTMLButtonElement | null>;
  onToggle: () => void;
  className?: string;
}) {
  const title = selectedOptions.map(optionTitle).join("；") || undefined;
  const content: ReactNode = selectedOptions.length === 0
    ? <span className="theme-muted">{placeholder}</span>
    : selectedOptions.length === 1
      ? <>
          <span className="searchable-select-trigger-primary">{selectedOptions[0].label}</span>
          {selectedOptions[0].hint ? <span className="searchable-select-trigger-hint">{selectedOptions[0].hint}</span> : null}
        </>
      : <span className="searchable-select-trigger-primary">{selectedOptions[0].label} <span className="text-acc-300">+{selectedOptions.length - 1}</span></span>;
  return <div className={className ?? "filter-control"}>
    {label && <span>{label}</span>}
    <button ref={triggerRef} type="button" role="combobox" aria-label={ariaLabel ?? label ?? placeholder}
      title={title}
      aria-expanded={open} aria-controls={open ? popupId : undefined} aria-haspopup="listbox" onClick={onToggle}
      className="searchable-select-trigger flex min-h-8 min-w-[9rem] items-center justify-between gap-2 rounded-md border px-2.5 py-1.5 text-left text-[11px] outline-none transition-colors hover:border-[var(--line-strong)] focus:border-acc-400/35">
      <span className="searchable-select-trigger-copy min-w-0 flex-1">{content}</span>
      <CaretDown size={12} className={"theme-muted shrink-0 transition-transform " + (open ? "rotate-180" : "")} aria-hidden="true" />
    </button>
  </div>;
}

export function SearchableSelect({ value, onChange, options, placeholder, label, ariaLabel, className, emptyText = "没有匹配选项", clearable = true }: SearchableSelectProps) {
  const popupId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const selectedOptions = options.filter((option) => option.value === value);
  return <>
    <Trigger selectedOptions={selectedOptions} placeholder={placeholder} label={label} ariaLabel={ariaLabel} open={open} popupId={popupId} triggerRef={triggerRef} onToggle={() => setOpen((current) => !current)} className={className} />
    {open && triggerRef.current && <SelectPopup options={options} selected={value ? [value] : []} multiple={false} clearable={clearable}
      onSelect={(next) => { onChange(next); setOpen(false); }} onClear={() => { onChange(""); setOpen(false); }} onClose={() => setOpen(false)} anchor={triggerRef.current} popupId={popupId} emptyText={emptyText} />}
  </>;
}

export function SearchableMultiSelect({ value, onChange, options, placeholder, label, ariaLabel, className, emptyText = "没有匹配选项" }: SearchableMultiSelectProps) {
  const popupId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const selectedOptions = options.filter((option) => value.includes(option.value));
  return <>
    <Trigger selectedOptions={selectedOptions} placeholder={placeholder} label={label} ariaLabel={ariaLabel} open={open} popupId={popupId} triggerRef={triggerRef} onToggle={() => setOpen((current) => !current)} className={className} />
    {open && triggerRef.current && <SelectPopup options={options} selected={value} multiple clearable
      onSelect={(next) => onChange(toggleMultiValue(value, next))} onClear={() => onChange([])} onClose={() => setOpen(false)} anchor={triggerRef.current} popupId={popupId} emptyText={emptyText} />}
  </>;
}
