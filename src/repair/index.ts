/**
 * repair — LLM でパッチを生成する
 */

import OpenAI from 'openai';
import type { Diagnosis, Patch, PatchType, Step } from '../types.js';
import { choosePatchType } from './policy.js';
import { buildPrompt } from './prompt.js';

/**
 * 診断結果からパッチを生成する
 * @returns パッチ、または修復不要/不可能の場合 null
 */
export async function repair(
  step: Step,
  diagnosis: Diagnosis
): Promise<Patch | null> {
  const patchType = choosePatchType(diagnosis.label);
  if (!patchType) return null;

  const prompt = buildPrompt(patchType, step, diagnosis);

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY required');

  const openai = new OpenAI({ apiKey });
  const model = process.env.LLM_MODEL || 'gpt-4o';

  // 3件生成して最初に有効なものを採用
  for (let i = 0; i < 3; i++) {
    try {
      const response = await openai.chat.completions.create({
        model,
        messages: [
          {
            role: 'system',
            content: 'You are a precise patch generator for UI tutorial steps. Output valid JSON only.',
          },
          { role: 'user', content: prompt },
        ],
        temperature: i === 0 ? 0 : 0.3,
        response_format: { type: 'json_object' },
      });

      const content = response.choices[0]?.message?.content;
      if (!content) continue;

      const parsed = JSON.parse(content) as Patch;

      // 基本検証
      if (parsed.patch_type !== patchType) continue;
      if (!parsed.changes) continue;

      return parsed;
    } catch (error: any) {
      console.warn(`[repair] attempt ${i + 1} failed: ${error.message}`);
    }
  }

  console.warn(`[repair] all 3 attempts failed for ${step.step_id}`);
  return null;
}
