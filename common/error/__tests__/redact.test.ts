/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { redactForDisplay } from '../redact';

describe('redactForDisplay', () => {
  it('returns empty string for empty/undefined input', () => {
    expect(redactForDisplay('')).toBe('');
    expect(redactForDisplay(undefined)).toBe('');
    expect(redactForDisplay(null)).toBe('');
  });

  it('preserves ordinary actionable text', () => {
    expect(redactForDisplay('invalid PromQL: parse error at position 12')).toBe(
      'invalid PromQL: parse error at position 12'
    );
  });

  it('redacts URLs', () => {
    expect(redactForDisplay('failed to reach https://host.internal:9090/api/v1/rules now')).toBe(
      'failed to reach <redacted-url> now'
    );
  });

  it('redacts ARNs', () => {
    const out = redactForDisplay('denied for arn:partition:svc:region:acct:resource/name');
    expect(out).toContain('<redacted-arn>');
    expect(out).not.toContain('resource/name');
  });

  it('redacts bare IPv4 with port', () => {
    expect(redactForDisplay('connection refused 10.1.2.3:9200')).toBe(
      'connection refused <redacted-ip>'
    );
  });

  it('redacts FQDN-like hosts with generic infra suffixes', () => {
    expect(redactForDisplay('lookup failed for cortex.svc.cluster.local')).toContain(
      '<redacted-host>'
    );
  });

  it('redacts UUIDs and long opaque ids', () => {
    expect(redactForDisplay('request 123e4567-e89b-12d3-a456-426614174000 failed')).toBe(
      'request <redacted-id> failed'
    );
    expect(redactForDisplay('account 123456789012 blocked')).toBe('account <redacted-id> blocked');
  });

  it('redacts long mixed-alphanumeric tokens but leaves plain words', () => {
    expect(redactForDisplay('token aB3xY7kLm9QpZ2wR5tN8vD1c present')).toContain('<redacted-token>');
    expect(redactForDisplay('rulesmissingfromnamespace')).toBe('rulesmissingfromnamespace');
  });

  it('is idempotent', () => {
    const once = redactForDisplay('see https://host.cloud/x and 10.0.0.1');
    expect(redactForDisplay(once)).toBe(once);
  });
});
