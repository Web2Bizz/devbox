# evolution-log.md — opal-fork-k2

| Epoch | Decision | Rationale | Status |
|-------|----------|-----------|--------|
| 01 | Coarse hypothesis: текстовые fork/revert + hover у copy; lucide источник уточнить | Факт из чтения `chat-message.tsx:196-234`, `package.json` | confirmed |
| 01 | Прецедент `FEEDBACK_TOGGLE_CLASS` (`hover:bg-transparent`) применим к copy | Тот же kit-механизм `cn`+tailwind-merge | confirmed |
| 02 | revert → `History` (не `Undo2`) | Семантика: откат к снапшоту = history | confirmed |
| 02 | fork → `GitFork`, fallback `GitBranch`→`Split` | Семантика: ветвление = fork | confirmed |
| 02 | `lucide-react ^0.577.0` прямой dep фронта (align с китом 0.26.3) | Транзитив хрупок; root hoist отсутствует (проверено) | confirmed |
| 02 | copy: `hover:bg-transparent` в `className`, variant ghost не менять | Минимальный дифф, DESIGN (no hex) | confirmed |

- Superseded: нет.
- Conflicts: нет (все разрешения получены, depth=low — финал без epoch-03).
