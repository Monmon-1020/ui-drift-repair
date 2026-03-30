/**
 * resolve — anchor に一致する要素をスコアリングで特定する
 */

import type { Page } from 'playwright';
import type { Anchor, Candidate, ResolveResult } from '../types.js';

/**
 * anchor.role + anchor.name に対して候補をスコアリングし、
 * 最も一致する要素を返す。
 */
export function resolve(
  page: Page,
  anchor: Anchor,
  candidates: Candidate[]
): ResolveResult {
  const targetRole = anchor.role.toLowerCase();
  const targetName = anchor.name.toLowerCase().trim();
  const containerHint = anchor.signature?.container_kind?.toLowerCase();

  // 全候補をスコアリング（role は加点要素であってフィルタではない）
  const scored = candidates
    .map((c) => ({
      candidate: c,
      score: scoreCandidate(c, targetRole, targetName, containerHint),
    }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) {
    return { status: 'NOT_FOUND' };
  }

  // 1位と2位の差が1未満 → AMBIGUOUS（ただし diagnose/repair で救える）
  if (scored.length >= 2 && scored[0].score - scored[1].score < 1) {
    return {
      status: 'AMBIGUOUS',
      topCandidates: scored.slice(0, 5).map((s) => s.candidate),
    };
  }

  const best = scored[0];
  const locator = buildLocator(page, best.candidate, candidates);

  return {
    status: 'FOUND',
    locator,
    candidate: best.candidate,
    score: best.score,
  };
}

function scoreCandidate(
  c: Candidate,
  targetRole: string,
  targetName: string,
  containerHint?: string
): number {
  let score = 0;
  const cName = c.name.toLowerCase().trim();

  // 名前一致
  if (cName === targetName) {
    score += 5; // 完全一致
  } else if (cName.includes(targetName) || targetName.includes(cName)) {
    score += 2; // 部分一致
  } else {
    return 0; // 名前が全く合わなければ0
  }

  // role 一致（加点のみ、フィルタではない）
  if (c.role.toLowerCase() === targetRole) {
    score += 2;
  }

  // visible かつ enabled
  if (c.visible && c.enabled) {
    score += 1;
  }

  // container ヒント一致
  if (containerHint && c.container.toLowerCase().includes(containerHint)) {
    score += 1;
  }

  // 近傍見出しヒント
  const sectionHints = targetName.split(/\s+/);
  if (c.nearestHeading && sectionHints.some((h) =>
    c.nearestHeading.toLowerCase().includes(h)
  )) {
    score += 1;
  }

  return score;
}

/**
 * ロケータを構築する。
 * strict mode violation 防止のため常に .first() をつける。
 */
function buildLocator(page: Page, candidate: Candidate, _allCandidates: Candidate[]) {
  const role = candidate.role as any;
  const name = candidate.name;
  return page.getByRole(role, { name, exact: false }).first();
}
