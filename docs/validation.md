# Проверки реализации

BB 0.48.0, Plugin SDK 0.6.94, standalone package 0.1.0. Проверки реализации выполнены 2026-10-30. Состояние STB-1 и STB-2: исходники и автоматические проверки готовы; STB-3: локальная сборка готова, интеграционные проверки и публикация выполняются отдельно.

- `npm ci --cache /tmp/statusbar-npm-cache --ignore-scripts`: чистая установка зависимостей разработки.
- `npm run test`: 26 тестов в 3 файлах проходят. Детерминированные метрики, официальный SDK app harness и fake SDK observer. Покрыты baseline, повторные counters, session/reset/clear, Unicode и completed snapshot, неполный replay, nested/tool исключения, freeze, модель, context null/estimated/zero, пагинация, предел истории, reconnect, ошибки, смена треда, отмена, StrictMode и cleanup.
- `experimental_scanPublicSdkOnly`: выполняется внутри тестов; нет private imports и private dependencies. Разрешённые дополнительные импорты ограничены React, Vitest и Testing Library.
- `npm run typecheck`: strict TypeScript, включая тесты, без пропуска проверки SDK declarations.
- `bb plugin build`: app и пустой server собраны. Метаданные: pluginId `thread-statusbar`, version `0.1.0`, SDK `0.6.94`, format `1`; runtime slots только `jsxRuntime`, `pluginSdkApp`, `react`.
- В отдельной чистой копии исходников: `npm ci --omit=dev --omit=optional --ignore-scripts --cache /tmp/statusbar-npm-cache`, затем `bb plugin build`. Установка без runtime dependencies и сборка установленным BB CLI проходят; dev runtime imports не нужны.
- Чистая установка разработки: 149 пакетов, `npm audit` — 0 уязвимостей.
- `git diff --check`: без ошибок whitespace. Demo todo, пример навыка и неиспользуемые vendored components/hooks/lib удалены. README/overview и навык соответствуют read-only поведению; MIT, artbear.

Живой BB не устанавливался и не перезагружался исполнителем реализации. Следующие проверки остаются интегратору: native layout и раскрытие, narrow/light/dark, два открытых треда/панели, живой streaming Codex и Cursor, navigation/reload/disable, Git install из публичного репозитория и независимое ревью. jsdom подтверждает контракт регистрации и поведение компонентов, но не host CSS и арбитраж нескольких segments.

Ограничения: история ограничена 2 000 подходящими событиями; без нужного начала/счётчика/текста метрика неизвестна. Первый ход Codex обычно не имеет доказанного baseline. Cursor ACP может не предоставлять token/context usage. Неизвестное окончание не восстанавливается из updatedAt. Плагин зависит от экспериментального API SDK 0.6.94, поэтому manifest честно закрепляет эту версию.
