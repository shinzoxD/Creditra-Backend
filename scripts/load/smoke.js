import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate } from 'k6/metrics';

// Custom metrics
const errorRate = new Rate('errors');

// Test configuration
export const options = {
  stages: [
    { duration: '30s', target: 10 },  // Ramp up to 10 users over 30s
    { duration: '1m', target: 10 },   // Stay at 10 users for 1 minute
    { duration: '10s', target: 0 },   // Ramp down to 0 users
  ],
  thresholds: {
    http_req_duration: ['p(95)<500'], // 95% of requests must complete below 500ms
    http_req_failed: ['rate<0.05'],   // Error rate must be below 5%
    errors: ['rate<0.05'],            // Custom error rate below 5%
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
// Valid Ed25519-strkey shape (G + 55 base32 chars). Used only as a payload;
// the rules-engine provider does not talk to Horizon in CI.
const VALID_WALLET = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

function envelopeData(body) {
  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed === 'object' && parsed.data != null) {
      return parsed.data;
    }
    return parsed;
  } catch {
    return null;
  }
}

export default function () {
  // Test 1: Health check
  let healthRes = http.get(`${BASE_URL}/health`);
  check(healthRes, {
    'health status is 200': (r) => r.status === 200,
    'health response has status ok': (r) => envelopeData(r.body)?.status === 'ok',
  }) || errorRate.add(1);

  sleep(0.5);

  // Test 2: List credit lines
  let listRes = http.get(`${BASE_URL}/api/credit/lines?offset=0&limit=10`);
  check(listRes, {
    'list credit lines status is 200': (r) => r.status === 200,
    'list response has creditLines array': (r) =>
      Array.isArray(envelopeData(r.body)?.creditLines),
  }) || errorRate.add(1);

  sleep(0.5);

  // Test 3: Risk evaluation
  const riskPayload = JSON.stringify({
    walletAddress: VALID_WALLET,
  });

  const riskParams = {
    headers: {
      'Content-Type': 'application/json',
    },
  };

  let riskRes = http.post(`${BASE_URL}/api/risk/evaluate`, riskPayload, riskParams);
  check(riskRes, {
    'risk evaluate status is 200': (r) => r.status === 200,
    'risk response has walletAddress': (r) =>
      envelopeData(r.body)?.walletAddress !== undefined,
  }) || errorRate.add(1);

  sleep(1);
}
