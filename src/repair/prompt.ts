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
  _pageUrl: string
): string {
  const currentPost = JSON.stringify(step.post, null, 2);
  const before = diagnosis.snapshot;
  const after = diagnosis.postSnapshot;

  const beforeUrl = before.url;
  const afterUrl = after?.url || beforeUrl;
  const afterTitle = after?.title || before.title;
  const afterHeadings = (after?.headings || []).slice(0, 15);

  // ナビゲーションかin-pageかをURL変化で判定
  const urlChanged = beforeUrl !== afterUrl;
  const navigationKind = urlChanged ? 'navigation' : 'in-page';

  return `You are repairing a failing UI tutorial step by updating its postcondition (success criteria).

## What a postcondition must guarantee
After this step runs, the UI is in the state required for the next step.
For the final step, the user has reached the intended page/state.
A postcondition is the precondition guarantee for whatever comes next.

## Signal strengths
- **url_pattern** — Strongest for page identity. If applicable, ALWAYS use it.
  Use a stable substring of the URL (e.g. "/settings/teams"), NOT the full URL with query strings or org-specific IDs.
- **must_have_heading** — Confirms page content. Weak alone (different pages can share headings).
  Combined with url_pattern → strong.
- **element_exists** — Confirms functional state of the page.
  Use only when URL doesn't change (SPA / in-page actions).
  Brittle: element names change with UI updates. Avoid unless URL is unavailable.

## Required combination
- **Navigation step (URL changes)** → url_pattern + must_have_heading. Necessary and sufficient.
- **In-page action (URL stays same)** → element_exists. URL/heading don't help.
- **SPA where URL doesn't change but it's a navigation** → must_have_heading + element_exists.

## Failing Step
- step_id: ${step.step_id}
- action: ${step.action.type} on "${step.anchor.name}"
- The action SUCCEEDED but the postcondition check FAILED.

## Current postcondition (broken)
${currentPost}

## Observed state
- URL before action: ${beforeUrl}
- URL after action: ${afterUrl}
- URL changed: ${urlChanged ? 'YES (this is a navigation step)' : 'NO (this is an in-page action or SPA)'}
- Detected step kind: ${navigationKind}
- Page title after: ${afterTitle}
- Headings on page after action:
${afterHeadings.map((h) => `  - ${h}`).join('\n') || '  (none)'}

## Rules
1. Pick the heading from the actual headings list above. Do NOT invent.
2. For url_pattern, use a short stable substring (no query strings, no random IDs).
3. ${urlChanged
    ? 'URL changed — output BOTH url_pattern AND must_have_heading.'
    : 'URL did NOT change — DO NOT include url_pattern. Use element_exists or must_have_heading from the observed headings.'}
4. Avoid generic headings like "Settings" or "Home" — pick something specific to this page.

Output JSON only:
{
  "patch_type": "UPDATE_POSTCONDITION",
  "step_id": "${step.step_id}",
  "changes": {
    "new_post": {
      ${urlChanged ? '"url_pattern": "/path/segment",\n      ' : ''}"must_have_heading": ["specific heading from list"]
    }
  },
  "rationale": "brief reason"
}`;
}
