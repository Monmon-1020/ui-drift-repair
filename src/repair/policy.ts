/**
 * policy — 診断ラベルから修復タイプを決定する
 * ハードコード。LLM 不使用。
 */

import type { DiagnosisLabel, PatchType } from '../types.js';

/**
 * 診断ラベルから修復タイプを決定する
 */
export function choosePatchType(label: DiagnosisLabel): PatchType | null {
  switch (label) {
    case 'ELEMENT_NOT_FOUND':
      return 'REPLACE_TARGET';
    case 'AMBIGUOUS':
      return 'REPLACE_TARGET';
    case 'DISABLED':
      return 'INSERT_STEP';
    case 'POST_MISMATCH':
      return 'UPDATE_POSTCONDITION';
    case 'SUCCESS':
    case 'EXEC_FAILED':
      return null; // 修復対象外
  }
}

/**
 * 修復対象かどうか
 */
export function isRepairTarget(label: DiagnosisLabel): boolean {
  return choosePatchType(label) !== null;
}
