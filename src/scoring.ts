// 월드컵 승부예측 채점 — 순수 함수 (Slack 무관, 테스트 대상)
// 일회성 테스트 이벤트 기능. 제거 시 app.ts와 함께 삭제.

export type Pred = { home: number; away: number }; // home=대한민국, away=남아공

const SCORE_CAP = 49; // 점수 상한. goalDiff 최대 98(<100)로 묶어 "결과 맞춤 우선" 불변식 보호.

export function parseScore(text: string): Pred | null {
  const m = text.match(/(\d+)\s*:\s*(\d+)/);
  if (!m) return null;
  const home = Number(m[1]);
  const away = Number(m[2]);
  if (home > SCORE_CAP || away > SCORE_CAP) return null; // 비현실적/장난 입력 차단
  return { home, away };
}

// 거리: 작을수록 잘 맞춤. 승부(승/무/패) 틀리면 +100, 거기에 골차 합계.
export function distance(p: Pred, ans: Pred): number {
  const sign = (d: number) => (d > 0 ? 1 : d < 0 ? -1 : 0);
  const resultMiss = sign(p.home - p.away) !== sign(ans.home - ans.away) ? 100 : 0;
  const goalDiff = Math.abs(p.home - ans.home) + Math.abs(p.away - ans.away);
  return resultMiss + goalDiff;
}

export type Ranked = { uid: string; p: Pred; d: number };
export type RankResult = { ranked: Ranked[]; losers: string[]; allTie: boolean };

// 근접순 정렬 + 꼴찌(들) 판정. best===worst(전원 동점/1명)면 꼴찌 없음.
export function rankAndFind(entries: [string, Pred][], ans: Pred): RankResult {
  const ranked = entries
    .map(([uid, p]) => ({ uid, p, d: distance(p, ans) }))
    .sort((a, b) => a.d - b.d);
  if (ranked.length === 0) return { ranked, losers: [], allTie: false };
  const best = ranked[0].d;
  const worst = ranked[ranked.length - 1].d;
  const allTie = best === worst; // 가릴 수 없음 → 꼴찌 없음 (전원 정답·1명 포함)
  const losers = allTie ? [] : ranked.filter((r) => r.d === worst).map((r) => r.uid);
  return { ranked, losers, allTie };
}
