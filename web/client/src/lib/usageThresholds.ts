import { useEffect, useState } from 'react';

export const CPU_THRESHOLD_KEY = 'usageCpuThreshold';
export const MEMORY_THRESHOLD_KEY = 'usageMemoryThreshold';
export const DEFAULT_USAGE_THRESHOLD = 70;

export const THRESHOLDS_CHANGED_EVENT = 'usage-thresholds-changed';

export function clampThreshold(value: unknown): number {
  const n = typeof value === 'string' ? Number.parseFloat(value) : Number(value);
  if (!Number.isFinite(n)) return DEFAULT_USAGE_THRESHOLD;
  return Math.min(100, Math.max(1, Math.round(n)));
}

export function readThreshold(key: string, fallback = DEFAULT_USAGE_THRESHOLD): number {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null || raw === '') return fallback;
    const n = Number.parseFloat(raw);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(100, Math.max(1, Math.round(n)));
  } catch {
    return fallback;
  }
}

export function readCpuThreshold(): number {
  return readThreshold(CPU_THRESHOLD_KEY);
}

export function readMemoryThreshold(): number {
  return readThreshold(MEMORY_THRESHOLD_KEY);
}

function persistThreshold(key: string, value: number): void {
  try {
    window.localStorage.setItem(key, String(value));
  } catch {
    /* storage unavailable — selection just won't persist */
  }
  try {
    window.dispatchEvent(new CustomEvent(THRESHOLDS_CHANGED_EVENT));
  } catch {
    /* ignore */
  }
}

export function writeCpuThreshold(value: unknown): number {
  const next = clampThreshold(value);
  persistThreshold(CPU_THRESHOLD_KEY, next);
  return next;
}

export function writeMemoryThreshold(value: unknown): number {
  const next = clampThreshold(value);
  persistThreshold(MEMORY_THRESHOLD_KEY, next);
  return next;
}

export function useUsageThresholds(): { cpu: number; memory: number } {
  const [cpu, setCpu] = useState<number>(() => readCpuThreshold());
  const [memory, setMemory] = useState<number>(() => readMemoryThreshold());

  useEffect(() => {
    const refresh = () => {
      setCpu(readCpuThreshold());
      setMemory(readMemoryThreshold());
    };
    window.addEventListener('storage', refresh);
    window.addEventListener(THRESHOLDS_CHANGED_EVENT, refresh);
    return () => {
      window.removeEventListener('storage', refresh);
      window.removeEventListener(THRESHOLDS_CHANGED_EVENT, refresh);
    };
  }, []);

  return { cpu, memory };
}
