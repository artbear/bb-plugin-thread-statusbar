# Аналоги и границы данных

Проверено 2026-10-30 по README, исходникам проектов и документации провайдеров. Это выборка найденных решений, не доказательство отсутствия других плагинов.

| Решение | Среда и показатели | Отличие от этой задачи |
| --- | --- | --- |
| [CodexStatusbar](https://github.com/dongyue-19/codex-statusbar) | Codex Desktop Windows: output TPS, суммарные токены, кеш | Отдельный overlay, читает локальные Desktop records; TPS рассчитан по объединению model item windows |
| [Turn TPS](https://github.com/bottlebrushes/bb-plugin-turn-tps) | BB: output tokens / полная длительность завершённого хода | Близкий аналог скорости; включает tools/wait и честно не заявляет decode-rate. UI опирается на DOM, активный ход получает показатель после завершения |
| [Usage Bar](https://github.com/dmitriikapustin/bb-plugins-by-kapustin/tree/HEAD/plugins/usage-bar) | BB: квоты/reset, токены за день и месяц | Account/host сводка над sidebar footer, не показатели текущего треда |
| [Provider Usage](https://github.com/braedonsaunders/bb-plugin-provider-usage) | BB: квоты, история, текущий расход | Rate включает input+output и выражается в токенах за минуту. Cursor counters оцениваются по тексту; это не official output TPS |
| [Agent TV](https://github.com/MacHatter1/bb-plugin-agent-tv) | BB: модель, контекст, инструменты, streaming/activity | График активности считает события; время последней активности не является elapsed хода |
| [Agent Graph](https://github.com/nathancolgate/bb-plugin-agent-graph) | BB: граф ходов, инструментов и агентов с длительностями | Не предоставляет общего per-thread токенного speed/total/cache meter |
| [cursor-statusline](https://github.com/tnaoyak/cursor-statusline) | Cursor CLI: модель, context, input/output | Читает JSON native statusline обычного CLI. Этот payload не гарантирован в ACP |
| [cursor-hud](https://github.com/huai-xia/cursor-hud) | Cursor CLI: модель, context, plan, tools/subagents | Другая поверхность CLI; token speed не заявлен, часть полей использует transcript/hooks и internal usage endpoint |

Для Codex CLI также найдены [codex-statusline](https://github.com/Moviw/codex-statusline) и [cxstatusline](https://github.com/adrijshikhar/cxstatusline); для VS Code/Cursor — [AI Usage Status Bar](https://github.com/cleocn/ai-usage-status-bar). Они полезны как аналоги, но не добавляют native строку текущего треда BB.

## Почему различаются скорости

В исходном Desktop overlay официальный output делится на объединение временных окон reasoning/message. BB хранит нормализованные события, некоторые reasoning windows могут быть синтезированы при приёме уже готового item. Поэтому v1 использует более простую воспроизводимую среднюю выдачу Codex за весь ход с явной подписью, включая инструменты и ожидания.

Token usage, total и context — разные величины. Cached input уже включён в input, reasoning output уже включён в output. Текущий ход нельзя вычислять из первого неизвестного cumulative snapshot без baseline.

## Cursor ACP

[Команда Cursor 19.10.2026 подтвердила отсутствие usage в ACP](https://forum.cursor.com/t/cli-emit-acp-usage-update-so-clients-like-zed-can-show-a-context-window-indicator/165358/9). BB умеет принять context usage, но не может восстановить отсутствующие официальные input/output/cache counters. [Семантика ACP usage](https://agentclientprotocol.com/rfds/session-usage) также различает заполнение контекста и token accounting.

Поэтому для Cursor v1 показывает наблюдаемые Unicode символы в секунду с единицей `симв/с`; токены, кеш и контекст появляются только по фактически полученным данным. Никакого characters/4 и выдачи оценки за tok/s. Отдельные Cursor SDK/Admin/Analytics интеграции потребовали бы дополнительных прав и не нужны для этой строки.

## Точка расширения BB

[Публичный Plugin SDK](https://github.com/get-bb/bb/tree/main/packages/plugin-sdk/src) предоставляет `experimental_threadContextSegment`, read-only thread events с seq/createdAt/scope и context measurement. Плагин использует эти данные внутри BB; desktop IPC, auth/session scanners и private endpoints не требуются. Совместимость проверяется с установленными BB 0.48.0 и SDK 0.6.94.
