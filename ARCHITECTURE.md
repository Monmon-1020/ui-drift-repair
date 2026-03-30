# ARCHITECTURE.md — システムアーキテクチャ

## 概要

ヘルプ記事の操作手順（Contract）を実際の Web UI 上で自動実行し、
UI 更新によって壊れた手順を検出・分類・修復するシステム。

```
Contract ──→ [検査] ──→ [診断] ──→ [修復] ──→ [再検証]
               │           │          │           │
            observe      diagnose    repair      replay
            resolve      (rules)     (LLM)      (Playwright)
            act
            verify
```

## パイプライン

### Phase 0: ヘルプ → Contract 変換 (`convert/`)

```
入力: ヘルプ記事 (markdown) + 対象サイト URL
処理: LLM がヘルプの手順を解析し、サイトの DOM 要素と照合
出力: contract.json
```

- Playwright でページの要素一覧を取得
- GPT-4o に markdown + 要素一覧を渡して StepSpec JSON を生成
- 各ステップに anchor (role + name) と postcondition を付与

### Phase 1: 検査 (`observe/` → `resolve/` → `act/` → `verify/`)

Contract の各ステップを順に実行し、成功/失敗を記録する。

```
1. observe(page)     → ページ上の全インタラクティブ要素を抽出
2. resolve(anchor)   → anchor.role + name に一致する要素をスコアリング
3. act(element)      → クリック / 入力 等のアクション実行
4. verify(post)      → 事後条件の検証（URL, 見出し, 要素存在）
```

#### observe の抽出対象

| セレクタ | 取得する情報 |
|---|---|
| `button, a[href], input, select, [role=tab], [role=menuitem]` | role, name (aria-label/textContent), visible, enabled, container |

#### resolve のスコアリング

| 条件 | 加点 |
|---|---|
| name 完全一致 | +5 |
| name 部分一致 | +2 |
| role 一致 | +2 |
| visible かつ enabled | +1 |
| container (sidebar/main 等) 一致 | +1 |
| 近傍見出し一致 | +1 |

1位と2位の差 < 1 → **AMBIGUOUS**

#### verify の検証内容

`post` フィールドに応じて:
- `must_have_heading`: ページ上の h1-h6 にテキストが含まれるか
- `url_pattern`: 現在の URL にパターンが含まれるか
- `element_exists`: 指定要素が存在するか

### Phase 2: 診断 (`diagnose/`)

検査結果から失敗ラベルを決定論的に付与する。**LLM 不使用。**

```
要素が見つからない                    → ELEMENT_NOT_FOUND
同名要素が複数あって選べない           → AMBIGUOUS
要素はあるが disabled                → DISABLED
クリック成功したが事後条件 NG         → POST_MISMATCH
クリック自体が失敗                    → EXEC_FAILED
```

### Phase 3: 修復タイプ決定 (`repair/policy.ts`)

ラベルから修復タイプを決定する。**LLM 不使用。ハードコード。**

| 診断ラベル | 修復タイプ | 意味 |
|---|---|---|
| ELEMENT_NOT_FOUND | **REPLACE_TARGET** | 要素が消えた → 代替要素に差し替え |
| AMBIGUOUS | **REPLACE_TARGET** | 曖昧 → より具体的な指定に |
| DISABLED | **INSERT_STEP** | 押せない → 前提操作を挿入 |
| POST_MISMATCH | **UPDATE_POSTCONDITION** | 操作OK、確認方法が古い → 条件更新 |

### Phase 4: パッチ生成 (`repair/prompt.ts` + LLM)

修復タイプが決まった後、**具体的な修正内容だけ**を LLM が生成する。

- 入力: 失敗コンテキスト + ページ上の候補要素リスト
- 出力: パッチ JSON（どの要素に差し替えるか、何を挿入するか等）
- 検証: Zod スキーマ + 候補リスト外の要素を参照していないか

### Phase 5: 再検証 (`replay/`)

パッチを Contract に適用し、Playwright で全ステップを再実行。
全ステップ成功 → 修復成功。失敗 → 修復失敗。

## 3つの修復タイプ

### A. REPLACE_TARGET（操作対象の差し替え）

```
例: 「Teams」リンクが「Teams management」に名前変更された
旧: anchor.name = "Teams"
新: anchor.name = "Teams management"
```

**LLMの仕事:** 候補要素リストから最も近いものを選ぶ

### B. INSERT_STEP（中間ステップの挿入）

```
例: 「Teams」がサイドバーから消え、Settings → Teams に移動した
旧: [click Teams]
新: [click Settings] → [click Teams]
```

**LLMの仕事:** 何をクリックすればゲートが開くかを判断する

### C. UPDATE_POSTCONDITION（成功条件の更新）

```
例: ページ見出しが「Actions secrets」から「Actions secrets and variables」に変わった
旧: must_have_heading = ["Actions secrets"]
新: must_have_heading = ["Actions secrets and variables"]
```

**LLMの仕事:** 操作後のページから新しい成功条件を抽出する

## データフロー

```
contract.json
    │
    ▼
┌─────────┐    candidates[]     ┌──────────┐
│ observe  │ ──────────────────→ │ resolve  │
└─────────┘                     └──────────┘
                                     │ resolved_element
                                     ▼
                                ┌──────────┐
                                │   act    │
                                └──────────┘
                                     │ action_result
                                     ▼
                                ┌──────────┐
                                │  verify  │
                                └──────────┘
                                     │ verify_result
                                     ▼
                                ┌──────────┐
                                │ diagnose │ ← ルールベース
                                └──────────┘
                                     │ label (ELEMENT_NOT_FOUND etc.)
                                     ▼
                                ┌──────────┐
                                │  policy  │ ← ハードコード
                                └──────────┘
                                     │ patch_type (REPLACE_TARGET etc.)
                                     ▼
                                ┌──────────┐
                                │  repair  │ ← GPT-4o
                                └──────────┘
                                     │ patch JSON
                                     ▼
                                ┌──────────┐
                                │  replay  │ ← Playwright
                                └──────────┘
                                     │ success / failure
                                     ▼
                                   結果
```

## モジュール間インターフェース

### observe → resolve

```typescript
type Candidate = {
  eid: string;          // 一意ID（data-eid属性）
  role: string;         // button, link, tab, etc.
  name: string;         // aria-label or textContent
  visible: boolean;
  enabled: boolean;
  container: string;    // sidebar, main, header, etc.
  nearestHeading?: string;
};
```

### resolve → act

```typescript
type ResolveResult =
  | { status: 'FOUND'; element: Locator; candidate: Candidate }
  | { status: 'AMBIGUOUS'; topCandidates: Candidate[] }
  | { status: 'NOT_FOUND' };
```

### act → verify

```typescript
type ActResult =
  | { status: 'ok' }
  | { status: 'disabled' }
  | { status: 'error'; message: string };
```

### verify → diagnose

```typescript
type VerifyResult = {
  passed: boolean;
  checks: Array<{ predicate: string; result: boolean }>;
};
```

### diagnose 出力

```typescript
type DiagnosisLabel =
  | 'SUCCESS'
  | 'ELEMENT_NOT_FOUND'
  | 'AMBIGUOUS'
  | 'DISABLED'
  | 'POST_MISMATCH'
  | 'EXEC_FAILED';
```

## 設計原則

1. **LLM は最小限**: 診断・タイプ決定はルールベース。LLM はパッチの「中身」だけ
2. **証拠駆動**: 証拠がなければ `unresolved` を返す。推測でパッチを作らない
3. **再現可能**: 同じ入力 → 同じ診断ラベル（LLM 以外は決定論的）
4. **安全**: 破壊的操作（delete, remove 等）はブロックリストで拒否
