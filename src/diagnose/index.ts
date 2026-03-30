/**
 * diagnose — 検査結果から失敗ラベルを決定論的に付与する
 * LLM 不使用。優先順位付きの if-chain。
 */

import type {
  ActResult,
  Diagnosis,
  DiagnosisLabel,
  PageSnapshot,
  ResolveResult,
  Step,
  VerifyResult,
} from '../types.js';

/**
 * 検査結果をもとに診断ラベルを決定する
 */
export function diagnose(
  step: Step,
  resolveResult: ResolveResult,
  actResult: ActResult | null,
  verifyResult: VerifyResult | null,
  snapshot: PageSnapshot
): Diagnosis {
  const label = determineLabel(resolveResult, actResult, verifyResult);

  return {
    label,
    step_id: step.step_id,
    resolve: resolveResult,
    act: actResult,
    verify: verifyResult,
    snapshot,
  };
}

function determineLabel(
  resolve: ResolveResult,
  act: ActResult | null,
  verify: VerifyResult | null
): DiagnosisLabel {
  // 1. 要素が見つからない
  if (resolve.status === 'NOT_FOUND') {
    return 'ELEMENT_NOT_FOUND';
  }

  // 2. 要素が曖昧
  if (resolve.status === 'AMBIGUOUS') {
    return 'AMBIGUOUS';
  }

  // 3. 要素は見つかったが操作できなかった
  if (act === null) {
    return 'EXEC_FAILED';
  }

  if (act.status === 'disabled') {
    return 'DISABLED';
  }

  if (act.status === 'error') {
    return 'EXEC_FAILED';
  }

  // 4. 操作成功 + 事後条件チェック
  if (verify === null) {
    return 'SUCCESS'; // verify がなければ成功とみなす
  }

  if (verify.passed) {
    return 'SUCCESS';
  }

  // 5. 操作成功だが事後条件NG
  return 'POST_MISMATCH';
}
