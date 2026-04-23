/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * In-memory implementation of ISloStore. Used as the bootstrap store until the
 * saved-objects repository is available (in CoreStart); see
 * server/services/slo/slo_saved_object_store.ts for the persistent backend.
 */

import type { ISloStore, SloDocument } from './slo_types';

export class InMemorySloStore implements ISloStore {
  private docs = new Map<string, SloDocument>();

  async get(id: string): Promise<SloDocument | null> {
    return this.docs.get(id) ?? null;
  }

  async list(datasourceId?: string): Promise<SloDocument[]> {
    const all = Array.from(this.docs.values());
    if (!datasourceId) return all;
    return all.filter((d) => d.spec.datasourceId === datasourceId);
  }

  async save(doc: SloDocument): Promise<void> {
    this.docs.set(doc.id, doc);
  }

  async delete(id: string): Promise<boolean> {
    return this.docs.delete(id);
  }
}
