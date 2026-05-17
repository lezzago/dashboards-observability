/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Memoized controlled `EuiBasicTable` (Phase 5). Page nav, sort, and
 * page-size changes flow upward via `onChange` so the parent's hook can
 * fire a new server request for the page. Memoization keeps the table
 * stable under the ancestor `EuiResizableContainer`'s mousemove
 * re-render cascade (mirrors `services_home.tsx`).
 */
import React from 'react';
import { EuiBasicTable } from '@elastic/eui';
import { UnifiedRuleSummary } from '../../../../common/types/alerting';

export interface MonitorsEuiTableProps {
  items: UnifiedRuleSummary[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- EuiBasicTable column type is complex
  columns: any[];
  loading: boolean;
  rowProps: (item: UnifiedRuleSummary) => React.HTMLAttributes<HTMLTableRowElement>;
  page: number;
  pageSize: number;
  total: number;
  sortField: string;
  sortDirection: 'asc' | 'desc';
  onChange: (e: {
    page?: { index: number; size: number };
    sort?: { field: keyof UnifiedRuleSummary | string; direction: 'asc' | 'desc' };
  }) => void;
}

export const MonitorsEuiTable = React.memo(
  ({
    items,
    columns,
    loading,
    rowProps,
    page,
    pageSize,
    total,
    sortField,
    sortDirection,
    onChange,
  }: MonitorsEuiTableProps) => (
    <EuiBasicTable
      items={items}
      columns={columns}
      loading={loading}
      pagination={{
        pageIndex: page,
        pageSize,
        totalItemCount: total,
        pageSizeOptions: [10, 20, 50, 100],
      }}
      sorting={{
        sort: { field: sortField as keyof UnifiedRuleSummary, direction: sortDirection },
      }}
      onChange={onChange}
      rowProps={rowProps}
    />
  )
);
