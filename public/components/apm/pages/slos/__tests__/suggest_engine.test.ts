/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import type { PrometheusSli, SingleSli } from '../../../../../../common/slo/slo_types';
import { generateSuggestionsFromServices } from '../suggest_engine';

function getPromSli(
  sli: SingleSli | { type: string; definition?: { backend: string } }
): PrometheusSli {
  if (
    'type' in sli &&
    sli.type === 'single' &&
    'definition' in sli &&
    sli.definition &&
    sli.definition.backend === 'prometheus'
  ) {
    return sli.definition as PrometheusSli;
  }
  throw new Error(`expected single + prometheus SLI, got ${JSON.stringify(sli)}`);
}

describe('generateSuggestionsFromServices', () => {
  it('emits two drafts per service (availability + latency) with the expected keys', () => {
    const out = generateSuggestionsFromServices({
      datasourceId: 'ds-2',
      services: [
        { serviceName: 'checkout', environment: 'generic:default' },
        { serviceName: 'cart' },
      ],
    });
    expect(out).toHaveLength(4);
    expect(out.map((s) => s.key).sort()).toEqual([
      'apm-avail:cart',
      'apm-avail:checkout',
      'apm-lat:cart',
      'apm-lat:checkout',
    ]);
  });

  it('returns an empty list when there are no services', () => {
    expect(generateSuggestionsFromServices({ datasourceId: 'ds-2', services: [] })).toEqual([]);
  });

  it('skips entries with an empty serviceName', () => {
    const out = generateSuggestionsFromServices({
      datasourceId: 'ds-2',
      services: [{ serviceName: '' }, { serviceName: 'checkout' }],
    });
    expect(out).toHaveLength(2);
    expect(out.every((s) => s.input.spec.service === 'checkout')).toBe(true);
  });

  it('builds custom-PromQL SLIs with the service scoped to span-derived (server-side) metrics', () => {
    const [avail, latency] = generateSuggestionsFromServices({
      datasourceId: 'ds-2',
      services: [{ serviceName: 'checkout' }],
    });

    // Availability: good = request - fault, total = request; both scoped to the server-side
    // (remoteService="") span-derived namespace.
    const availDef = getPromSli(avail.input.spec.sli);
    expect(availDef.type).toBe('custom');
    const availExpr =
      availDef.customExpr?.mode === 'events'
        ? availDef.customExpr
        : ((undefined as never) as { goodQuery: string; totalQuery: string });
    expect(availExpr.goodQuery).toContain('request{service="checkout"');
    expect(availExpr.goodQuery).toContain('fault{service="checkout"');
    expect(availExpr.goodQuery).toContain('remoteService=""');
    expect(availExpr.goodQuery).toContain('namespace="span_derived"');
    expect(availExpr.totalQuery).toContain('sum(request{service="checkout"');

    // Latency: good = bucket <= 0.5s, total = +Inf bucket.
    const latDef = getPromSli(latency.input.spec.sli);
    expect(latDef.type).toBe('custom');
    const latExpr =
      latDef.customExpr?.mode === 'events'
        ? latDef.customExpr
        : ((undefined as never) as { goodQuery: string; totalQuery: string });
    expect(latExpr.goodQuery).toContain('latency_seconds_bucket{service="checkout"');
    expect(latExpr.goodQuery).toContain('le="0.5"');
    expect(latExpr.totalQuery).toContain('le="+Inf"');
  });

  it('propagates environment into the `detected` map when present', () => {
    const [avail] = generateSuggestionsFromServices({
      datasourceId: 'ds-2',
      services: [{ serviceName: 'checkout', environment: 'generic:default' }],
    });
    expect(avail.detected).toEqual({ service: 'checkout', environment: 'generic:default' });
  });

  it('omits environment from `detected` when the service has no environment', () => {
    const [avail] = generateSuggestionsFromServices({
      datasourceId: 'ds-2',
      services: [{ serviceName: 'checkout' }],
    });
    expect(avail.detected).toEqual({ service: 'checkout' });
  });

  it('produces stable keys so React list reconciliation is not churned by order', () => {
    const a = generateSuggestionsFromServices({
      datasourceId: 'ds-2',
      services: [{ serviceName: 'a' }, { serviceName: 'b' }],
    });
    const b = generateSuggestionsFromServices({
      datasourceId: 'ds-2',
      services: [{ serviceName: 'b' }, { serviceName: 'a' }],
    });
    expect(a.map((s) => s.key).sort()).toEqual(b.map((s) => s.key).sort());
  });

  it('defaults targets to 99% availability and 95% latency', () => {
    const [avail, latency] = generateSuggestionsFromServices({
      datasourceId: 'ds-2',
      services: [{ serviceName: 'checkout' }],
    });
    expect(avail.input.spec.objectives[0].target).toBeCloseTo(0.99, 5);
    expect(latency.input.spec.objectives[0].target).toBeCloseTo(0.95, 5);
  });
});
