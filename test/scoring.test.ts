// 채점 로직 검증 — Slack/토큰 불필요. 실행: npx tsx test/scoring.test.ts
import assert from 'node:assert';
import { type Pred, parseScore, distance, rankAndFind } from '../src/scoring.js';

let passed = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${(e as Error).message}`);
    process.exitCode = 1;
  }
}

const p = (home: number, away: number): Pred => ({ home, away });

// 1. 기본: 정답 2:1, 꼴찌는 결과 틀린 D
check('기본 — 1등 정확, 꼴찌는 결과 틀린 사람', () => {
  const ans = p(2, 1);
  const r = rankAndFind([['A', p(2, 1)], ['B', p(1, 0)], ['C', p(3, 2)], ['D', p(0, 2)]], ans);
  assert.strictEqual(r.ranked[0].uid, 'A', '1등은 A');
  assert.strictEqual(r.ranked[0].d, 0, 'A 거리 0');
  assert.deepStrictEqual(r.losers, ['D'], '꼴찌는 D');
  assert.strictEqual(distance(p(0, 2), ans), 103, 'D 거리 103(+100 결과틀림 +3 골차)');
  assert.strictEqual(r.allTie, false);
});

// 2. 공동 꼴찌: 결과 틀린 두 명이 같은 거리
check('공동 꼴찌 — 같은 최대 거리 둘 다 표시', () => {
  const ans = p(2, 1);
  // E:0:1 결과틀림(+100)+골차2=102, F:1:2 결과틀림(+100)+골차2=102 → 동률 꼴찌
  const r = rankAndFind([['A', p(2, 1)], ['E', p(0, 1)], ['F', p(1, 2)]], ans);
  assert.strictEqual(distance(p(0, 1), ans), 102);
  assert.strictEqual(distance(p(1, 2), ans), 102);
  assert.deepStrictEqual(r.losers.sort(), ['E', 'F'], 'E,F 공동 꼴찌');
});

// 3. 전원 정답 → 꼴찌 없음 (전원 커피 아님)
check('전원 정답 — allTie, losers 없음', () => {
  const ans = p(2, 1);
  const r = rankAndFind([['A', p(2, 1)], ['B', p(2, 1)], ['C', p(2, 1)]], ans);
  assert.strictEqual(r.allTie, true);
  assert.deepStrictEqual(r.losers, []);
});

// 4. 참가자 1명 → 혼자 커피 강요 안 함
check('참가자 1명 — allTie, losers 없음', () => {
  const r = rankAndFind([['A', p(0, 5)]], p(2, 1));
  assert.strictEqual(r.allTie, true);
  assert.deepStrictEqual(r.losers, []);
});

// 5. 무승부 정답 1:1 — 무승부 예측자가 승부 예측자보다 상위
check('무승부 정답 — 무승부 예측 우선, 승부 예측이 꼴찌', () => {
  const ans = p(1, 1);
  const r = rankAndFind([['A', p(1, 1)], ['B', p(0, 0)], ['C', p(2, 1)]], ans);
  assert.strictEqual(r.ranked[0].uid, 'A', '정확히 맞춘 A가 1등');
  assert.deepStrictEqual(r.losers, ['C'], '승부(한국승) 예측한 C가 꼴찌');
  assert.strictEqual(distance(p(2, 1), ans), 101, 'C: 무승부 못맞춤+100, 골차1');
  assert.strictEqual(distance(p(0, 0), ans), 2, 'B: 무승부 맞춤, 골차2');
});

// 6. 큰 스코어 차단 (불변식 보호)
check('스코어 상한 — 50 이상 차단, 49 허용', () => {
  assert.strictEqual(parseScore('100:0'), null, '100 차단');
  assert.strictEqual(parseScore('50:0'), null, '50 차단');
  assert.deepStrictEqual(parseScore('49:0'), p(49, 0), '49 허용');
});

// 7. 파싱
check('파싱 — 점수 추출/거부', () => {
  assert.deepStrictEqual(parseScore('예측 2:1'), p(2, 1));
  assert.deepStrictEqual(parseScore('정답 0 : 3'), p(0, 3), '공백 허용');
  assert.strictEqual(parseScore('안녕'), null, '점수 없으면 null');
});

console.log(process.exitCode ? '\n❌ 일부 실패' : `\n✅ all passed (${passed} cases)`);
