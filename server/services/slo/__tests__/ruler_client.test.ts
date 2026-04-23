/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ruler client tests — pins the DirectQuery contract for W1.5:
 *   - Path shape:  /_plugins/_directquery/_resources/{encoded-dqName}/api/v1/rules/{encoded-ns}[/{group}]
 *   - HTTP method: POST for upsert, DELETE for delete
 *   - Body shape:  POST body is YAML serializing the GeneratedRuleGroup
 *   - Error surface: SloRulerError with stable code + upstream status + raw body
 *   - No retry: transport.request called exactly once on failure
 */

import { load as yamlLoad } from 'js-yaml';
import { DirectQueryRulerClient, ruleGroupToYaml } from '../ruler_client';
import { SloRulerError } from '../../../../common/slo/slo_errors';
import type { AlertingOSClient, Datasource, Logger } from '../../../../common/types/alerting/types';
import type { GeneratedRuleGroup } from '../../../../common/slo/slo_types';

function noopLogger(): Logger {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  };
}

function mockClient(
  handler?: (params: unknown) => Promise<unknown>
): {
  client: AlertingOSClient;
  requestMock: jest.Mock;
} {
  const requestMock = jest.fn(async (params: unknown) => {
    if (handler) return handler(params);
    return { statusCode: 200, body: {} };
  });
  return {
    client: ({ transport: { request: requestMock } } as unknown) as AlertingOSClient,
    requestMock,
  };
}

function promDatasource(overrides: Partial<Datasource> = {}): Datasource {
  return {
    id: 'ds-1',
    name: 'my Cortex',
    type: 'prometheus',
    url: '',
    enabled: true,
    directQueryName: 'my-cortex-connection',
    ...overrides,
  };
}

function sampleGroup(): GeneratedRuleGroup {
  return {
    groupName: 'slo:checkout_api_availability_a1b2c3d4',
    interval: 60,
    rules: [
      {
        type: 'recording',
        name: 'slo:sli_error:ratio_rate_5m:checkout_a1b2c3d4',
        expr: '1 - (sum(rate(m{s="a"}[5m])) / sum(rate(m{s="a"}[5m])))',
        labels: { slo_id: 'slo-1', slo_name: 'checkout', slo_window: '5m' },
        description: 'rec',
      },
      {
        type: 'alerting',
        name: 'SLO_BurnRate_PageQuick_checkout_a1b2c3d4',
        expr: 'foo{a="b"} > 0.5\nand\nbar > 0.5',
        for: '2m',
        labels: { slo_severity: 'critical', slo_alarm_type: 'burn_rate' },
        annotations: { summary: 'burn rate 14.4x' },
        description: 'alert',
      },
    ],
    yaml: '',
  };
}

describe('ruleGroupToYaml', () => {
  it('serializes to valid YAML that round-trips through js-yaml with the expected shape', () => {
    const yaml = ruleGroupToYaml(sampleGroup());
    const parsed = yamlLoad(yaml) as {
      name: string;
      interval: string;
      rules: Array<Record<string, unknown>>;
    };
    expect(parsed.name).toBe('slo:checkout_api_availability_a1b2c3d4');
    expect(parsed.interval).toBe('1m');
    expect(parsed.rules).toHaveLength(2);
    expect(parsed.rules[0]).toMatchObject({
      record: 'slo:sli_error:ratio_rate_5m:checkout_a1b2c3d4',
    });
    expect(parsed.rules[1]).toMatchObject({
      alert: 'SLO_BurnRate_PageQuick_checkout_a1b2c3d4',
      for: '2m',
    });
    expect((parsed.rules[0] as { expr: string }).expr).toContain('sum(rate(m{');
    // alerting rule preserves annotations
    expect((parsed.rules[1] as { annotations: Record<string, string> }).annotations.summary).toBe(
      'burn rate 14.4x'
    );
  });

  it('omits labels/annotations when empty so the YAML is tidy', () => {
    const group: GeneratedRuleGroup = {
      groupName: 'g1',
      interval: 60,
      rules: [
        {
          type: 'recording',
          name: 'r1',
          expr: 'vector(1)',
          labels: {},
          description: '',
        },
      ],
      yaml: '',
    };
    const yaml = ruleGroupToYaml(group);
    expect(yaml).not.toContain('labels:');
    expect(yaml).not.toContain('annotations:');
  });
});

describe('DirectQueryRulerClient.upsertRuleGroup', () => {
  it('POSTs to /_plugins/_directquery/_resources/{dqName}/api/v1/rules/{namespace} with YAML body', async () => {
    const { client, requestMock } = mockClient();
    const svc = new DirectQueryRulerClient(noopLogger());
    await svc.upsertRuleGroup(
      client,
      promDatasource({ directQueryName: 'my cortex' }), // space to force encoding
      'slo-generated-ws1',
      sampleGroup()
    );

    expect(requestMock).toHaveBeenCalledTimes(1);
    const call = requestMock.mock.calls[0][0] as {
      method: string;
      path: string;
      body: string;
    };
    expect(call.method).toBe('POST');
    expect(call.path).toBe(
      '/_plugins/_directquery/_resources/my%20cortex/api/v1/rules/slo-generated-ws1'
    );
    expect(typeof call.body).toBe('string');
    const parsed = yamlLoad(call.body) as { name: string; rules: unknown[] };
    expect(parsed.name).toBe('slo:checkout_api_availability_a1b2c3d4');
    expect(parsed.rules).toHaveLength(2);
  });

  it('throws if the datasource has no directQueryName', async () => {
    const { client } = mockClient();
    const svc = new DirectQueryRulerClient(noopLogger());
    await expect(
      svc.upsertRuleGroup(
        client,
        promDatasource({ directQueryName: undefined }),
        'ns',
        sampleGroup()
      )
    ).rejects.toThrow(/no directQueryName/);
  });
});

describe('DirectQueryRulerClient.deleteRuleGroup', () => {
  it('DELETEs to /_plugins/_directquery/_resources/{dqName}/api/v1/rules/{namespace}/{groupName}', async () => {
    const { client, requestMock } = mockClient();
    const svc = new DirectQueryRulerClient(noopLogger());
    await svc.deleteRuleGroup(client, promDatasource(), 'slo-generated-ws1', 'slo:group_abcd');

    expect(requestMock).toHaveBeenCalledTimes(1);
    const call = requestMock.mock.calls[0][0] as { method: string; path: string };
    expect(call.method).toBe('DELETE');
    expect(call.path).toBe(
      '/_plugins/_directquery/_resources/my-cortex-connection/api/v1/rules/slo-generated-ws1/slo%3Agroup_abcd'
    );
  });
});

describe('DirectQueryRulerClient error classification', () => {
  // Helper that rejects with a synthetic OpenSearch transport error.
  function rejectWith(err: unknown) {
    return mockClient(() => {
      return Promise.reject(err);
    });
  }

  it('400 → RULER_VALIDATION_FAILED preserves rawBody and httpStatus', async () => {
    const { client, requestMock } = rejectWith({
      statusCode: 400,
      body: { message: 'rule group exceeds maximum size' },
    });
    const svc = new DirectQueryRulerClient(noopLogger());
    await expect(
      svc.upsertRuleGroup(client, promDatasource(), 'ns', sampleGroup())
    ).rejects.toMatchObject({
      name: 'SloRulerError',
      code: 'RULER_VALIDATION_FAILED',
      httpStatus: 400,
      rawBody: expect.stringContaining('rule group exceeds maximum size'),
    });
    expect(requestMock).toHaveBeenCalledTimes(1); // no retry
  });

  it('401 → RULER_AUTH_FAILED', async () => {
    const { client } = rejectWith({ statusCode: 401, body: 'no org id' });
    const svc = new DirectQueryRulerClient(noopLogger());
    await expect(
      svc.upsertRuleGroup(client, promDatasource(), 'ns', sampleGroup())
    ).rejects.toMatchObject({
      name: 'SloRulerError',
      code: 'RULER_AUTH_FAILED',
      httpStatus: 401,
      rawBody: 'no org id',
    });
  });

  it('403 → RULER_AUTH_FAILED', async () => {
    const { client } = rejectWith({ statusCode: 403, body: 'forbidden' });
    const svc = new DirectQueryRulerClient(noopLogger());
    await expect(
      svc.upsertRuleGroup(client, promDatasource(), 'ns', sampleGroup())
    ).rejects.toMatchObject({ code: 'RULER_AUTH_FAILED', httpStatus: 403 });
  });

  it('503 → RULER_UNREACHABLE', async () => {
    const { client, requestMock } = rejectWith({
      statusCode: 503,
      body: 'upstream timeout',
    });
    const svc = new DirectQueryRulerClient(noopLogger());
    await expect(
      svc.upsertRuleGroup(client, promDatasource(), 'ns', sampleGroup())
    ).rejects.toMatchObject({ code: 'RULER_UNREACHABLE', httpStatus: 503 });
    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it('network error (no statusCode) → RULER_UNREACHABLE', async () => {
    const netErr = Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' });
    const { client, requestMock } = rejectWith(netErr);
    const svc = new DirectQueryRulerClient(noopLogger());
    await expect(
      svc.upsertRuleGroup(client, promDatasource(), 'ns', sampleGroup())
    ).rejects.toMatchObject({
      code: 'RULER_UNREACHABLE',
      httpStatus: 0,
      rawBody: 'ECONNREFUSED',
    });
    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it('extracts status from error.meta.statusCode when top-level absent', async () => {
    const { client } = rejectWith({
      message: 'wrapped',
      meta: { statusCode: 400, body: { reason: 'invalid PromQL' } },
    });
    const svc = new DirectQueryRulerClient(noopLogger());
    await expect(
      svc.upsertRuleGroup(client, promDatasource(), 'ns', sampleGroup())
    ).rejects.toBeInstanceOf(SloRulerError);
    await expect(
      svc.upsertRuleGroup(client, promDatasource(), 'ns', sampleGroup())
    ).rejects.toMatchObject({
      code: 'RULER_VALIDATION_FAILED',
      httpStatus: 400,
      rawBody: expect.stringContaining('invalid PromQL'),
    });
  });

  it('deleteRuleGroup classifies auth failures the same way', async () => {
    const { client, requestMock } = rejectWith({ statusCode: 401, body: 'unauth' });
    const svc = new DirectQueryRulerClient(noopLogger());
    await expect(
      svc.deleteRuleGroup(client, promDatasource(), 'ns', 'group-1')
    ).rejects.toMatchObject({ code: 'RULER_AUTH_FAILED', httpStatus: 401 });
    expect(requestMock).toHaveBeenCalledTimes(1);
  });
});
