# evolution-log — chat-decompose-k7

| Epoch | Title | Key decisions | Status |
|-------|-------|---------------|--------|
| 01 | Coarse hypothesis | Гипотеза: монолит chat-window + дубль ChatThread + вложенный features/chat + нет layout сегмента; визуал ок, режем только композицию | superseded by 02 (подтверждена чтением) |
| 02 | Evidence gathering | Факты: 8 файлов chat-window, ChatThreadProps=ChatWindowProps, пин absolute z-20 в chat-section, только page.tsx без layout, Content chat z-0/Header z-30, контроли сейчас красные | active (фактура) |
| 03 | Decision foundation | D1 тред=компонент/фича=тонкая; D2 удалить chat-window; D3 ряды по папкам + live-status; D4 геометрия в layout; D5 page Server; D6 flatten chat/ (usage out-of-scope) | active |
| 04 | Refinement | D7 grid sticky-пин (не absolute); D8 таблица было→стало 17 строк; D9 пропсы/types.ts | active |
| 05 | Validation | D10 реестр DESIGN §3 + AGENTS; D11 тесты; D12 барелли без ChatWindow-алиаса; точные grep-контроли (остерегаться client-only комментария) | active |
| 06 | Implementation specifics | D13 8 шагов; D14 stop-лист (шелл/css/usage/rename/useChat не трогать) | active |
| 07 | Final controls | D15 команды дословно; D16 приёмка 7 пунктов; D17 риски R1–R4 | active |

Ни одно решение не отменено; Epoch 1 гипотеза уточнена Epoch 2–4 без инверсий.
