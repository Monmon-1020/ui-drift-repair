/**
 * 全型定義
 * contract.json の実際のフォーマットに合わせる
 */

import type { Locator } from 'playwright';

// ============================================================================
// Contract (入力データ)
// ============================================================================

export interface Contract {
  tutorial_id: string;
  doc_url: string;
  start_url?: string;
  steps: Step[];
  meta: ContractMeta;
}

export interface Step {
  step_id: string;
  action: { type: 'click' | 'type' | 'check' | 'select' | 'press'; target?: string; value?: string };
  anchor: Anchor;
  post: PostCondition;
}

export interface Anchor {
  role: string;
  name: string;
  signature?: {
    container_kind?: string;
    section_path?: string[];
    context_text?: string[];
  };
}

export interface PostCondition {
  must_have_heading?: string[];
  url_pattern?: string;
  element_exists?: string;
  description?: string;
}

export interface ContractMeta {
  source: string;
  drift_type: string;
  patch_type: PatchType;
  change_date: string;
  rationale: string;
  commit?: string | null;
  [key: string]: unknown;
}

// ============================================================================
// Observe
// ============================================================================

export interface Candidate {
  eid: string;
  role: string;
  name: string;
  visible: boolean;
  enabled: boolean;
  container: string;
  nearestHeading: string;
  href?: string;
}

export interface PageSnapshot {
  url: string;
  title: string;
  candidates: Candidate[];
}

// ============================================================================
// Resolve
// ============================================================================

export type ResolveResult =
  | { status: 'FOUND'; locator: Locator; candidate: Candidate; score: number }
  | { status: 'AMBIGUOUS'; topCandidates: Candidate[] }
  | { status: 'NOT_FOUND' };

// ============================================================================
// Act
// ============================================================================

export type ActResult =
  | { status: 'ok' }
  | { status: 'disabled' }
  | { status: 'error'; message: string };

// ============================================================================
// Verify
// ============================================================================

export interface VerifyResult {
  passed: boolean;
  checks: Array<{ predicate: string; result: boolean }>;
}

// ============================================================================
// Diagnose
// ============================================================================

export type DiagnosisLabel =
  | 'SUCCESS'
  | 'ELEMENT_NOT_FOUND'
  | 'AMBIGUOUS'
  | 'DISABLED'
  | 'POST_MISMATCH'
  | 'EXEC_FAILED';

export interface Diagnosis {
  label: DiagnosisLabel;
  step_id: string;
  resolve: ResolveResult;
  act: ActResult | null;
  verify: VerifyResult | null;
  snapshot: PageSnapshot;
}

// ============================================================================
// Repair
// ============================================================================

export type PatchType =
  | 'REPLACE_TARGET'
  | 'INSERT_STEP'
  | 'UPDATE_POSTCONDITION';

export interface Patch {
  patch_type: PatchType;
  step_id: string;
  changes: ReplaceTargetChanges | InsertStepChanges | UpdatePostconditionChanges;
  rationale: string;
}

export interface ReplaceTargetChanges {
  new_anchor: { role: string; name: string };
}

export interface InsertStepChanges {
  insert_before: boolean;
  new_step: Step;
}

export interface UpdatePostconditionChanges {
  new_post: PostCondition;
}

// ============================================================================
// Runner (全体パイプライン)
// ============================================================================

export interface StepResult {
  step_id: string;
  diagnosis: Diagnosis;
}

export interface CaseResult {
  case_id: string;
  steps: StepResult[];
  needs_repair: boolean;
  patch?: Patch;
  replay_success?: boolean;
}
