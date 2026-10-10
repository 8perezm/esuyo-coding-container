import { createContext, useCallback, useContext, useId, useState } from 'react';
import type { ButtonHTMLAttributes, HTMLAttributes, KeyboardEvent, ReactNode } from 'react';

/**
 * Shadcn-style tabs (same Tabs/TabsList/TabsTrigger/TabsContent API as
 * shadcn/ui, dependency-free: no Radix, just buttons + ARIA practices).
 *
 * Panels stay mounted when hidden so background polling (e.g. job output)
 * keeps running while another tab is visible.
 */

interface TabsContextValue {
  value: string;
  setValue: (next: string) => void;
  baseId: string;
}

const TabsContext = createContext<TabsContextValue | null>(null);

function useTabsContext(component: string): TabsContextValue {
  const ctx = useContext(TabsContext);
  if (!ctx) throw new Error(`${component} must be used inside <Tabs>`);
  return ctx;
}

interface TabsProps extends Omit<HTMLAttributes<HTMLDivElement>, 'defaultValue' | 'onChange'> {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  children: ReactNode;
}

export function Tabs({ value, defaultValue = '', onValueChange, children, ...rest }: TabsProps) {
  const [internal, setInternal] = useState(defaultValue);
  const baseId = useId();
  const controlled = value !== undefined;
  const current = controlled ? value : internal;
  const setValue = useCallback(
    (next: string) => {
      if (!controlled) setInternal(next);
      onValueChange?.(next);
    },
    [controlled, onValueChange],
  );
  return (
    <TabsContext.Provider value={{ value: current, setValue, baseId }}>
      <div {...rest}>{children}</div>
    </TabsContext.Provider>
  );
}

interface TabsListProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
}

export function TabsList({ children, ...rest }: TabsListProps) {
  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    const tabs = Array.from(
      e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]:not([disabled])'),
    );
    if (tabs.length === 0) return;
    e.preventDefault();
    const active = document.activeElement as HTMLElement | null;
    const index = tabs.findIndex((t) => t === active || t.contains(active));
    let next = 0;
    if (e.key === 'ArrowRight') next = (index + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
    else if (e.key === 'End') next = tabs.length - 1;
    tabs[next].focus();
    tabs[next].click();
  }

  return (
    <div role="tablist" {...rest} onKeyDown={onKeyDown} className={`tabs-list ${rest.className ?? ''}`.trim()}>
      {children}
    </div>
  );
}

interface TabsTriggerProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  value: string;
  /** Shows a small activity dot (e.g. a job running in that tab). */
  activity?: boolean;
  children: ReactNode;
}

export function TabsTrigger({ value, activity = false, children, ...rest }: TabsTriggerProps) {
  const { value: current, setValue, baseId } = useTabsContext('TabsTrigger');
  const selected = current === value;
  return (
    <button
      type="button"
      role="tab"
      id={`${baseId}-tab-${value}`}
      aria-selected={selected}
      aria-controls={`${baseId}-panel-${value}`}
      tabIndex={selected ? 0 : -1}
      data-state={selected ? 'active' : 'inactive'}
      data-value={value}
      {...rest}
      onClick={(e) => {
        rest.onClick?.(e);
        if (!e.defaultPrevented) setValue(value);
      }}
      className={`tabs-trigger ${rest.className ?? ''}`.trim()}
    >
      {children}
      {activity ? <span aria-hidden="true" data-ref="tabs-trigger-activity" className="tabs-trigger-activity" /> : null}
    </button>
  );
}

interface TabsContentProps extends HTMLAttributes<HTMLDivElement> {
  value: string;
  children: ReactNode;
}

export function TabsContent({ value, children, ...rest }: TabsContentProps) {
  const { value: current, baseId } = useTabsContext('TabsContent');
  const selected = current === value;
  return (
    <div
      role="tabpanel"
      id={`${baseId}-panel-${value}`}
      aria-labelledby={`${baseId}-tab-${value}`}
      hidden={!selected}
      {...rest}
    >
      {children}
    </div>
  );
}
