/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { extractRulerErrorEnvelope } from '../slo_api_client';

describe('extractRulerErrorEnvelope', () => {
  it('returns null for non-error inputs', () => {
    expect(extractRulerErrorEnvelope(null)).toBeNull();
    expect(extractRulerErrorEnvelope(undefined)).toBeNull();
    expect(extractRulerErrorEnvelope('oops')).toBeNull();
    expect(extractRulerErrorEnvelope(new Error('network'))).toBeNull();
  });

  it('returns null when attributes is absent or unrecognized', () => {
    expect(extractRulerErrorEnvelope({ body: { message: 'oops' } })).toBeNull();
    expect(
      extractRulerErrorEnvelope({
        body: { message: 'oops', attributes: { code: 'SOME_OTHER_CODE' } },
      })
    ).toBeNull();
  });

  it('extracts a RULER_VALIDATION_FAILED envelope from the OSD error body', () => {
    // Shape mirrors res.customError({ body: { message, attributes } }) →
    // IHttpFetchError.body = { message, attributes }.
    const err = {
      body: {
        message: 'Ruler rejected',
        attributes: {
          error: 'Ruler rejected',
          code: 'RULER_VALIDATION_FAILED',
          httpStatus: 400,
          rawBody: 'invalid PromQL: parse error at char 42',
        },
      },
    };
    expect(extractRulerErrorEnvelope(err)).toEqual({
      error: 'Ruler rejected',
      code: 'RULER_VALIDATION_FAILED',
      httpStatus: 400,
      rawBody: 'invalid PromQL: parse error at char 42',
    });
  });

  it('extracts RULER_AUTH_FAILED and RULER_UNREACHABLE variants', () => {
    const auth = {
      body: {
        attributes: {
          error: 'auth',
          code: 'RULER_AUTH_FAILED',
          httpStatus: 401,
          rawBody: 'no org id',
        },
      },
    };
    const unreachable = {
      body: {
        attributes: {
          error: 'unreachable',
          code: 'RULER_UNREACHABLE',
          httpStatus: 0,
          rawBody: 'connection refused',
        },
      },
    };
    expect(extractRulerErrorEnvelope(auth)?.code).toBe('RULER_AUTH_FAILED');
    expect(extractRulerErrorEnvelope(unreachable)?.code).toBe('RULER_UNREACHABLE');
  });

  it('defaults missing optional fields', () => {
    const env = extractRulerErrorEnvelope({
      body: { attributes: { code: 'RULER_VALIDATION_FAILED' } },
    });
    expect(env).toEqual({
      error: 'Ruler dual-write failed',
      code: 'RULER_VALIDATION_FAILED',
      httpStatus: 0,
      rawBody: '',
    });
  });
});
