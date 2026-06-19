{
  "id": "11b2efba",
  "title": "Phase 0: pi-coding-agent agent_end イベント構造調査",
  "tags": [],
  "status": "completed",
  "created_at": "2026-06-19T14:20:07.931Z"
}

- pi-coding-agent の型定義を調査
- agent_end イベントに systemPrompt / rawUserPrompt が含まれないことを確認
- before_agent_start イベントに prompt / systemPrompt があることを確認
- 実装方針を確定: before_agent_start で保存 → FIFO キュー → agent_end で紐付け
- 調査結果レポートを作成: `.pi/research/agent-end-event-investigation.md`
- 実装プランを Phase 0 結果に基づいて更新
