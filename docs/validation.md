# Проверки реализации

BB 0.48.0, Plugin SDK 0.6.94, standalone package 0.1.0. Проверки реализации выполнены 2026-10-30. Состояние STB-1 и STB-2: исходники и автоматические проверки готовы; STB-3: локальная сборка готова, интеграционные проверки и публикация выполняются отдельно.

- `npm ci --cache /tmp/statusbar-npm-cache --ignore-scripts`: чистая установка зависимостей разработки.
- `npm run test`: 37 тестов в 3 файлах проходят. Детерминированные метрики, официальный SDK app harness и fake SDK observer. Покрыты baseline, повторные counters, session/reset/clear, Unicode и completed snapshot, неполный replay, nested/tool исключения, freeze, модель, context null/estimated/zero, пагинация, предел истории, reconnect, ошибки, смена треда, отмена, StrictMode и cleanup.
- `experimental_scanPublicSdkOnly`: выполняется внутри тестов; нет private imports и private dependencies. Разрешённые дополнительные импорты ограничены React, Vitest и Testing Library.
- `npm run typecheck`: strict TypeScript, включая тесты, без пропуска проверки SDK declarations.
- `bb plugin build`: app и пустой server собраны. Метаданные: pluginId `thread-statusbar`, version `0.1.0`, SDK `0.6.94`, format `1`; runtime slots только `jsxRuntime`, `pluginSdkApp`, `react`.
- В отдельной чистой копии исходников: `npm ci --omit=dev --omit=optional --ignore-scripts --cache /tmp/statusbar-npm-cache`, затем `bb plugin build`. Установка без runtime dependencies и сборка установленным BB CLI проходят; dev runtime imports не нужны.
- Чистая установка разработки: 149 пакетов, `npm audit` — 0 уязвимостей.
- `git diff --check`: без ошибок whitespace. Demo todo, пример навыка и неиспользуемые vendored components/hooks/lib удалены. README/overview и навык соответствуют read-only поведению; MIT, artbear.

Живой BB не устанавливался и не перезагружался исполнителем реализации. Следующие проверки остаются интегратору: native layout и раскрытие, narrow/light/dark, два открытых треда/панели, живой streaming Codex и Cursor, navigation/reload/disable, Git install из публичного репозитория и независимое ревью. jsdom подтверждает контракт регистрации и поведение компонентов, но не host CSS и арбитраж нескольких segments.

Ограничения: история ограничена 2 000 подходящими событиями; без нужного начала/счётчика/текста метрика неизвестна. Первый ход Codex обычно не имеет доказанного baseline. Cursor ACP может не предоставлять token/context usage. Неизвестное окончание не восстанавливается из updatedAt. Плагин зависит от экспериментального API SDK 0.6.94, поэтому manifest честно закрепляет эту версию.

## Исправления независимого ревью

Регрессионные traces проверены против findings Standards и Spec на исходном commit 73bbe41. Поздний usage своего закрытого хода уточняет output, completed agentMessage — текст, при неизменном end. Изменившийся usage прежнего хода не становится числителем текущего и делает его baseline недостоверным. Некорректные/регрессирующие поздние counters также инвалидируют скорость. JSON counters проверяются как неотрицательные safe integers, включая безопасную сумму input + output; вычисленные elapsed/speed дополнительно проверяются на конечность.

Session usage ведётся отдельно от выбранного root turn. SDK 0.6.94 описывает token usage как turn-scoped событие с providerThreadId и cumulative total, но без parentToolCallId. Codex translation передаёт providerTurnId; assembler сохраняет соответствие providerTurnId → BB turnId и допускает usage после закрытия (current-or-last turn). Поэтому snapshot-only даёт сессионные total/cache по официальной принадлежности события данному thread/session, не утверждая root-принадлежность и не создавая baseline скорости. Известные nested turn ids исключены; несовпадающий providerThreadId и чужой threadId игнорируются. Если start отсутствует, root-принадлежность не угадывается. Восстановленный root start необходим для turn accounting, но не для сессионных totals. Классификация и per-turn snapshots ограничены 2 000 записями.

Все пять исходных trace-оракулов ревью теперь совпадают: late-own speed 6, late-invalid speed/total null, snapshot-only total 1200/cache 40%, late-prior speed null, late-completed-text speed 1.5. Дополнительные тесты покрывают unsafe integer и finite overflow, неизменившиеся поздние snapshots прежнего хода, известный nested scope, чужую сессию и независимость сохранённого состояния reducer.

Imports и package не менялись; повторная production-dependencies установка не требовалась. Плагин при исправлении не устанавливался и не перезагружался. Повторная live-проверка принадлежит интегратору.
