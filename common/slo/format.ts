/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

export interface FormatPctOptions {
  decimals?: number;
  fallback?: string;
}

export function formatPct(value: number, options: FormatPctOptions = {}): string {
  const { decimals = 1, fallback = '—' } = options;
  if (!Number.isFinite(value)) return fallback;
  return `${(value * 100).toFixed(decimals)}%`;
}
