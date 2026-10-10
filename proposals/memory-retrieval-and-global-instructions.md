# Proposal: Better Basic Memory discovery and bounded reading

**Status:** Agent-review design.  
**Workstream:** 2 of 2 — lookup, search, reading.  
**Companion:** [Unified gardener](unified-memory-gardener.md).

## Objective

Give all Copilot CLI agents a **small global retrieval policy** and one detailed reference/skill for efficient BM lookup. Avoid automatic full-note reads, unnecessary graph expansions, metadata mistakes, and repeated token-heavy searches. Do not create a new search service or rewrite the capture extension.

## Search decision tree

1. **Know the project?** Scope to it explicitly. If not, discover BM projects first; search multiple projects only when needed. For current-state questions, prefer active projects. For historical questions, include relevant \`*-archive\` projects or archive folders.
2. **Know a structured field?** Use \`search_notes(metadata_filters=...)\` rather than searching frontmatter text. Examples: \`{"thread_id":"copilot:<sessionId>"}\`, \`{"status":"active"}\`, \`{"priority":{"$in":["high","critical"]}}\`. Multiple fields are ANDed. For exact capture identity, **never** rely on FTS matching the YAML \`thread_id\`.
3. **Know an exact identifier or literal?** Use \`search_type="text"\` or \`"title"\`; FTS is useful for facts buried in the note body, error strings, symbols, and filenames.
4. **Have a conceptual query with uncertain wording?** Use \`search_type="hybrid"\` when local embeddings are enabled; otherwise text with synonyms. Hybrid combines lexical and vector recall. If semantic search is disabled, don't assume it ran.
5. **Need a particular class of fact?** Try \`entity_types=["observation"]\`, \`categories=["decision"]\` (or \`["risk"]\`, etc.), \`note_types\`, \`tags\`, and metadata. Search returns ranked candidates, not necessarily proof.
6. **Need related context?** After finding a reliable anchor note, inspect its explicit relations or use \`build_context\` at depth 1. Increase depth only if needed; avoid wildcard/folder-wide context loads by default.
7. **Need the source passage?** Use a small search page (\`page_size=3–5\`), inspect snippets/headings, and read only the relevant section or line range. Use \`read_note(start_line=N,end_line=M)\` when supported, or \`bm grep "term" -C 3 --max-matches 5\` then bounded read. If the version lacks these, use a local file line-range reader. **Do not automatically call unsliced \`read_note\` on a 50 KB note.**
8. **Need only metadata?** If supported, \`read_note(identifier=...,include_content=false)\` avoids the body. \`search_notes(compact=true)\` is useful for identifier/metadata discovery, but it intentionally removes content snippets; don't use it when a snippet would answer the question.
9. **Need the current truth?** Check source dates, status, supersession and evidence. Index/mtime is not source-authored or effective date. A newer note is not necessarily more authoritative. If using \`valid_at\`, know that undated observations are excluded, so repeat without it when appropriate.
10. **Stop once the evidence is sufficient.** Cite the source note/permalink and relevant section; distinguish observed facts from inference. Don't flood the model with related notes merely because they exist.

## Concrete tool examples (verify against installed BM)

\`\`\`text
search_notes(
  metadata_filters={"thread_id":"copilot:<sessionId>"},
  project="<actual-project>", page_size=5
)

search_notes(
  query="socket timeout",
  search_type="text",
  project="<actual-project>", page_size=5
)

search_notes(
  query="how does the worker recover after disconnect",
  search_type="hybrid",
  project="<actual-project>", page_size=5
)

search_notes(
  query="retry",
  entity_types=["observation"],
  categories=["decision"],
  metadata_filters={"status":"active"},
  project="<actual-project>", page_size=5
)

read_note(
  identifier="<exact permalink>",
  project="<actual-project>",
  start_line=80, end_line=125
)
\`\`\`

**Metadata syntax:** The upstream skill is named **\`memory-metadata-search\`**, not \`memory-metadata\`. It documents equality, \`$in\`, range comparisons, arrays, and nested dot notation. Do not treat the Markdown frontmatter as a full-text index. Do not assume metadata exists on imported non-Markdown resources.

**Reading caveats:** \`read_note(page/page_size)\` paginate fallback search suggestions, **not** note content. In current upstream versions \`start_line/end_line\` are inclusive 1-based ranges. They may not exist in an older installed MCP server. Line positions can shift after an edit; refresh if source changed. \`bm grep -C\` returns literal-match windows from FTS candidates; it is not an exhaustive raw filesystem grep.

**Project/archive caveats:** Search across all projects only when necessary, not by default. When archived knowledge is relevant, include it explicitly; don't assume all archives are included in active-project search. The current upstream \`move_note\` API operates within the selected project; separate archive-project support needs validation.

## Two-level instruction design

- **Global Copilot instructions:** minimal, universally applicable, ~200 words; copy the companion [global snippet](copilot-global-memory-instructions.md) to the global-instructions location supported by the installed Copilot CLI. Don't duplicate long skill documentation in every agent definition.
- **One detailed lookup reference/skill:** extend or wrap the existing upstream \`memory-metadata-search\` / \`memory-continue\` guidance with the decision tree above, after checking installed tool versions. Keep the global policy short.

Do **not** force every agent turn to query BM; use it when past knowledge would materially help. Don't create new skills for each search mode. Prefer one lookup reference that complements the single gardening process.

## Tests

- Find an exact technical identifier buried deep in a 50 KB note without full-note MCP output.
- Find a semantically related note despite different vocabulary; verify the fallback when embeddings are off.
- Find a capture by exact \`thread_id\` using metadata.
- Search only active status for current answers; include archive for a historical query.
- Follow one typed relation from an identified anchor, without loading all neighbors.
- A query requiring a dated assertion correctly handles supersession and undated observations.
- A second query needing no more evidence causes no unnecessary read or graph expansion.

## References

- [Upstream \`memory-metadata-search\` skill](https://github.com/basicmachines-co/basic-memory/blob/main/skills/memory-metadata-search/SKILL.md)
- [\`search_notes\` reference](https://github.com/basicmachines-co/basic-memory/blob/main/src/basic_memory/man/man3/search-notes(3).md)
- [\`read_note\` reference](https://github.com/basicmachines-co/basic-memory/blob/main/src/basic_memory/man/man3/read-note(3).md)
- [\`bm grep\` reference](https://github.com/basicmachines-co/basic-memory/blob/main/src/basic_memory/man/man1/grep(1).md)
