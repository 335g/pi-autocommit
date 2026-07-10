{
  "id": "d1ab1df2",
  "title": "scope-resolver.ts を新設",
  "tags": [],
  "status": "done",
  "created_at": "2026-07-10T17:36:46.084Z"
}

`src/scope-resolver.ts` を新設。`resolveScope(paths: string[], config): string | null` を公開。cascade: マッピング（picomatch、最長リテラル優先）→ ヒューリスティック（既存 determineScope 相当）→ null。混在時は null。`hasScopeMapping` もエクスポート。
