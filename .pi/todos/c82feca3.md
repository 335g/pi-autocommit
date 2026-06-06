{
  "id": "c82feca3",
  "title": "効果測定: 安価モデルで /git-agg-commit を5回以上実行し診断カウンターを収集",
  "tags": [
    "measurement",
    "p0"
  ],
  "status": "open",
  "created_at": "2026-06-06T14:14:26.955Z"
}

## 目的
P0（Few-shot例 + JSONリペア）の効果を実データで検証する。

## 手順
1. `analysis_model` に安価モデル（GPT-4o-mini など）を設定
2. 実際の変更があるリポジトリで `/git-agg-commit` を5回以上実行
3. 毎回 `/git-diagnostics` でカウンターを確認
4. 以下の指標を記録:
   - Layer 3+4 発動率（全parse中の割合）
   - Layer 4（regex）発動の有無
   - `msgIsGeneric` / `msgRefineTriggered` / `msgRefineUsedAI` の値
   - `msgSanitizeChanged` の発生率

## 判断基準
- Layer 3+4 発動率 > 20% → JSONリペアが有効
- Layer 3+4 発動率 < 2% → リペア不要（モデルが十分高品質）
- `msgIsGeneric` がゼロ → Few-shot 例が効いている
- `msgIsGeneric` が多発 → P1（分解再生成）の必要性が高い
