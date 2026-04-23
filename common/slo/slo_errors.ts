/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Typed errors thrown by SloService. Handlers map these to HTTP status codes:
 *   SloValidationError      → 400
 *   SloNotFoundError        → 404
 *   SloVersionConflictError → 409
 *
 * Grouped by purpose — they're always imported together.
 */

/* eslint-disable max-classes-per-file */

import type { SloDocument } from './slo_types';

export class SloValidationError extends Error {
  constructor(public readonly errors: Record<string, string>) {
    super(`SLO validation failed: ${JSON.stringify(errors)}`);
    this.name = 'SloValidationError';
  }
}

export class SloNotFoundError extends Error {
  constructor(public readonly id: string) {
    super(`SLO not found: ${id}`);
    this.name = 'SloNotFoundError';
  }
}

export class SloVersionConflictError extends Error {
  constructor(public readonly current: SloDocument, public readonly attemptedVersion: number) {
    super(
      `SLO version conflict: client sent version ${attemptedVersion} but server has ${current.status.version}`
    );
    this.name = 'SloVersionConflictError';
  }
}
