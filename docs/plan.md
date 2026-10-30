# План и локальные тикеты

Контракт: [спецификация](specification.md), [решения](autonomous-decisions/thread-statusbar.md). Поиск и исследование API выполняются параллельно, рецензент спецификации и финальный ревьюер получают чистые контексты. Код реализуется одним владельцем в отдельном Git worktree; интеграция и проверка живого BB принадлежат оркестратору.

Исследовательские записки служат справкой об API. При выборе UI, полей и метрик приоритет имеет утверждённая спецификация.

## STB-1 — штатная строка и привязка к ходу

Provider filter, модель/состояние/elapsed, нативный context segment. Тесты lifecycle, изоляции тредов, unmount/reload и late responses. Блокеров нет.

## STB-2 — метрики и восстановление

Зависит от STB-1. Официальные total/cache/context, Codex сред. output ток/с, Cursor Unicode симв/с; bounded paginated replay, дедупликация, session/reset/error semantics. Приёмка: сценарии 3–6 спецификации, совпадение replay/live.

## STB-3 — проверка и публикация

Зависит от STB-2. Удалить scaffold demo, оформить README/overview/license, запуск тестов/typecheck/public SDK scan/build, чистая Git install сборка, live smoke Codex/Cursor/узкая панель/темы, отдельное чистое ревью и исправление замечаний. Затем новый публичный GitHub repository с финальным проверенным commit.

Состояние тикетов и доказательства завершения фиксируются в docs/validation.md после выполнения. Внешний tracker для этой отдельной задачи не создаётся.
