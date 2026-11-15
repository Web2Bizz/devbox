# Evolution log — amber-phoenix-qt7

| Epoch | Hypothesis → Evidence → Decision | Status |
|---|---|---|
| 01 Coarse hypothesis | Своим транспортом дотягиваем 5 пунктов; Trello-карточки + builder-метки | confirmed |
| 02 Evidence gathering | Прочитаны sse-relay (нет ping), harness 1056+ (нет cursor), controller (нет ?session=), sessions-client (FAIL LOUD parse), useChat (sending-гард до session-фильтра, setError на транзиент), chat-window (error заменяет тред), page (нет ?agent=) | confirmed |
| 03 Decision foundation | heartbeat=`: ping` коммент; error=`stream.error`+end; cursor=`Last-Event-ID`+`id:`; `?session=` optional+filter defense; fail-soft safeParse; подписка всегда, гарды разделены; URL path+`?agent=`; resync online/visibility | confirmed |
| 04 Refinement | 7 карточек C0–C6, порядок root→branch→leaf, complexity/риск/builder назначены | confirmed |
| 05 Validation | Сверено с AppLogger-only, boundary-schemas, C4-gate без утечки, yaml-зеркалом, no-opencode guard | confirmed |
| 06 Finalize | PLAN.md + evolution-log.md синтезированы | confirmed |

Superseded: нет (первый проход, конфликтов с откатом решений не было).
Конфликты, разрешённые в Epoch 3: sending-гард vs подписка (разделены); транзиент vs терминал (тишина vs ErrorState); heartbeat-кадр vs коммент (коммент); ?session= обязательный vs optional (optional); cursor кастомный vs Last-Event-ID (Last-Event-ID).
