/**
 * prompt — 修復タイプ別の LLM プロンプトを構築する
 */

import type { Candidate, Diagnosis, PatchType, Step } from '../types.js';

export function buildPrompt(
  patchType: PatchType,
  step: Step,
  diagnosis: Diagnosis
): string {
  const candidates = diagnosis.snapshot.candidates;
  const pageUrl = diagnosis.snapshot.url;

  switch (patchType) {
    case 'REPLACE_TARGET':
      return buildReplaceTargetPrompt(step, candidates, pageUrl);
    case 'INSERT_STEP':
      return buildInsertStepPrompt(step, candidates, pageUrl);
    case 'UPDATE_POSTCONDITION':
      return buildUpdatePostconditionPrompt(step, diagnosis, pageUrl);
  }
}

function buildReplaceTargetPrompt(
  step: Step,
  candidates: Candidate[],
  pageUrl: string
): string {
  const list = candidates
    .filter((c) => c.visible && c.enabled)
    .slice(0, 15)
    .map((c) => `  - eid:${c.eid} role:${c.role} name:"${c.name}" container:${c.container}`)
    .join('\n');

  return `You are repairing a failing UI step by replacing the target element.

## Failing Step
- step_id: ${step.step_id}
- action: ${step.action.type}
- original target: role="${step.anchor.role}" name="${step.anchor.name}"
- page URL: ${pageUrl}

## Available Elements
${list}

## Task
Select the best replacement from the list above.
The replacement must serve the same purpose as the original target.

Output JSON only:
{
  "patch_type": "REPLACE_TARGET",
  "step_id": "${step.step_id}",
  "changes": {
    "new_anchor": { "role": "exact role", "name": "exact name from list" }
  },
  "rationale": "brief reason"
}`;
}

function buildInsertStepPrompt(
  step: Step,
  candidates: Candidate[],
  pageUrl: string
): string {
  const list = candidates
    .filter((c) => c.visible && c.enabled)
    .slice(0, 15)
    .map((c) => `  - eid:${c.eid} role:${c.role} name:"${c.name}" container:${c.container}`)
    .join('\n');

  return `You are repairing a failing UI step by inserting a prerequisite step before it.

## Failing Step
- step_id: ${step.step_id}
- action: ${step.action.type}
- target: role="${step.anchor.role}" name="${step.anchor.name}" (currently disabled or hidden)
- page URL: ${pageUrl}

## Available Elements
${list}

## Task
Identify which element must be clicked first to make the target accessible.
Common patterns: tab selection, menu expansion, navigation to a sub-page.

Output JSON only:
{
  "patch_type": "INSERT_STEP",
  "step_id": "${step.step_id}",
  "changes": {
    "insert_before": true,
    "new_step": {
      "step_id": "s_gate_${step.step_id}",
      "action": { "type": "click" },
      "anchor": { "role": "element role", "name": "element name from list" },
      "post": { "must_have_heading": [] }
    }
  },
  "rationale": "brief reason"
}`;
}

function buildUpdatePostconditionPrompt(
  step: Step,
  diagnosis: Diagnosis,
  pageUrl: string
): string {
  const currentPost = JSON.stringify(step.post, null, 2);
  const pageTitle = diagnosis.snapshot.title;

  return `You are repairing a failing UI step by updating its success condition.

## Failing Step
- step_id: ${step.step_id}
- action: ${step.action.type} on "${step.anchor.name}"
- The action SUCCEEDED but the postcondition check FAILED.

## Current Postcondition (broken)
${currentPost}

## Page After Action
- URL: ${pageUrl}
- Title: ${pageTitle}

## Task
Generate updated postcondition that matches what the page actually shows now.

Output JSON only:
{
  "patch_type": "UPDATE_POSTCONDITION",
  "step_id": "${step.step_id}",
  "changes": {
    "new_post": {
      "must_have_heading": ["actual heading text"],
      "url_pattern": "url pattern if applicable"
    }
  },
  "rationale": "brief reason"
}`;
}
