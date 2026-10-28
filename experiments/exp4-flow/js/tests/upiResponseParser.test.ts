import { understandUpiResponse, upiResponseForBackend } from '../zn/upiResponseParser';

/**
 * Mirror of the payments API decision (payments-api
 * src/services/api.verify-upi-payment.ts, isClientFailedConfirmed) applied to the string we send.
 */
function backendClientFailedConfirmed(upiResponse: string): boolean {
  const params = new URLSearchParams(upiResponse);
  const get = (key: string): string | null => {
    for (const [k, v] of params.entries()) if (k.toLowerCase() === key.toLowerCase()) return v;
    return null;
  };
  const resCode = get('resultCode');
  const status = (get('Status') || '').toUpperCase();
  const respCode = get('responseCode') || '';
  const okOrAbsent = !resCode || resCode === '-1';
  const zeroOrAbsent = !resCode || resCode === '0';
  return (
    upiResponse === 'EXPIRED' ||
    upiResponse === 'CANCELLED' ||
    (okOrAbsent && status === 'FAILURE') ||
    (okOrAbsent && status === 'FAILED' && respCode === '01') ||
    (zeroOrAbsent && (status === 'SUBMITTED' || status === 'CANCELLED') && (respCode === '02' || respCode === 'U69')) ||
    (zeroOrAbsent && status === 'FAILURE' && get('AppID') === 'com.dreamplug.androidapp')
  );
}

function send(event: Record<string, any> | string) {
  const parsed = understandUpiResponse(event);
  return { parsed, upi: upiResponseForBackend(parsed, event) };
}

describe('understandUpiResponse (Flutter UPIHandlerUtils.understandResponse parity)', () => {
  it('Back pressed with no extras -> CANCELLED, sends RESULTCODE=0', () => {
    const { parsed, upi } = send({ resultCode: 0 });
    expect(parsed.status).toBe('CANCELLED');
    expect(upi).toBe('RESULTCODE=0');
  });

  it('PhonePe cancel (SUBMITTED + responseCode 02) -> CANCELLED and backend cancels instantly', () => {
    const { parsed, upi } = send({
      resultCode: 0,
      response: 'txnId=&responseCode=02&Status=SUBMITTED&txnRef=TR123',
      Status: 'SUBMITTED',
      responseCode: '02',
    });
    expect(parsed.status).toBe('CANCELLED');
    expect(upi).toBe('RESULTCODE=0&STATUS=SUBMITTED&RESPONSECODE=02&TXNID=&TXNREF=TR123');
    expect(backendClientFailedConfirmed(upi)).toBe(true);
  });

  it('GPay failure (resultCode -1, Status FAILURE) -> FAILED and backend fails instantly', () => {
    const { parsed, upi } = send({
      resultCode: -1,
      response: 'txnId=AXI123&responseCode=ZM&Status=FAILURE&txnRef=TR123',
      Status: 'FAILURE',
    });
    expect(parsed.status).toBe('FAILED');
    expect(upi).toBe('RESULTCODE=-1&STATUS=FAILURE&TXNID=AXI123&RESPONSECODE=ZM&TXNREF=TR123');
    expect(backendClientFailedConfirmed(upi)).toBe(true);
  });

  it('Success with bank ref -> VERIFY, keeps ApprovalRefNo / txnId for the backend', () => {
    const { parsed, upi } = send({
      resultCode: -1,
      response: 'txnId=YBL123&responseCode=00&Status=SUCCESS&txnRef=TR123&ApprovalRefNo=612345678901',
    });
    expect(parsed.status).toBe('VERIFY');
    expect(upi).toBe('RESULTCODE=-1&TXNID=YBL123&RESPONSECODE=00&STATUS=SUCCESS&TXNREF=TR123&APPROVALREFNO=612345678901');
    expect(backendClientFailedConfirmed(upi)).toBe(false);
  });

  it('top-level extras win over the nested response (putIfAbsent)', () => {
    const { upi } = send({ resultCode: -1, Status: 'SUCCESS', response: 'Status=FAILURE&txnId=1' });
    expect(upi).toBe('RESULTCODE=-1&STATUS=SUCCESS&TXNID=1');
  });

  it('URL-encoded nested response is decoded like Dart (decodeComponent then splitQueryString)', () => {
    const { upi } = send({ resultCode: -1, response: 'txnId%3DA%2BB%26Status%3DSUCCESS' });
    expect(upi).toBe('RESULTCODE=-1&TXNID=A B&STATUS=SUCCESS');
  });

  it('malformed percent-encoding falls back to a raw split', () => {
    const { parsed, upi } = send({ resultCode: -1, response: 'txnId=50%&Status=SUCCESS' });
    expect(parsed.status).toBe('VERIFY');
    expect(upi).toBe('RESULTCODE=-1&TXNID=50%&STATUS=SUCCESS');
  });

  it('SUBMITTED with a bank txnId and RESULT_CANCELED stays VERIFY (money may be in flight)', () => {
    const { parsed } = send({ resultCode: 0, Status: 'SUBMITTED', txnId: 'YBL999' });
    expect(parsed.status).toBe('VERIFY');
  });

  it('SUBMITTED, RESULT_CANCELED, no txnId -> CANCELLED', () => {
    const { parsed } = send({ resultCode: 0, Status: 'SUBMITTED' });
    expect(parsed.status).toBe('CANCELLED');
  });

  it('RESULT_OK with nothing else -> VERIFY (backend decides)', () => {
    const { parsed, upi } = send({ resultCode: -1 });
    expect(parsed.status).toBe('VERIFY');
    expect(upi).toBe('RESULTCODE=-1');
  });

  it('cached map from SharedPreferences (all values strings) parses the same as the live map', () => {
    const live = send({ resultCode: 0, Status: 'SUBMITTED', responseCode: '02' });
    const cached = send({ resultCode: '0', Status: 'SUBMITTED', responseCode: '02' });
    expect(cached.parsed.status).toBe(live.parsed.status);
    expect(cached.upi).toBe(live.upi);
  });

  it('null/undefined extras are skipped', () => {
    const { upi } = send({ resultCode: -1, Status: 'SUCCESS', txnRef: null });
    expect(upi).toBe('RESULTCODE=-1&STATUS=SUCCESS');
  });

  it('plain query string event', () => {
    const { parsed, upi } = send('Status=SUCCESS&txnId=1');
    expect(parsed.status).toBe('VERIFY');
    expect(upi).toBe('STATUS=SUCCESS&TXNID=1');
  });
});
