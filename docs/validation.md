# Проверки выпуска 0.1.0

BB 0.48.0, Plugin SDK 0.6.94, standalone package 0.1.0, Linux, Node.js 24.21.0. Проверено 2026-10-30. Интегрированный код b35a19f совпадает с независимо проверенным c38b86b; документация обновлена отдельно. Результаты относятся к этой версии и контрактам указанного SDK.

- `npm ci --cache /tmp/statusbar-npm-cache --ignore-scripts`: чистая установка зависимостей разработки.
- `npm run test`: 38 тестов в 3 файлах проходят. Детерминированные метрики, официальный SDK app harness и fake SDK observer. Покрыты baseline, повторные counters, session/reset/clear, Unicode и completed snapshot, неполный replay, nested/tool исключения, freeze, модель, context null/estimated/zero, пагинация, предел истории, reconnect, ошибки, смена треда, отмена, StrictMode и cleanup.
- `experimental_scanPublicSdkOnly`: выполняется внутри тестов; нет private imports и private dependencies. Разрешённые дополнительные импорты ограничены React, Vitest и Testing Library.
- `npm run typecheck`: strict TypeScript, включая тесты, без пропуска проверки SDK declarations.
- `bb plugin build`: app и пустой server собраны. Метаданные: pluginId `thread-statusbar`, version `0.1.0`, SDK `0.6.94`, format `1`; runtime slots только `jsxRuntime`, `pluginSdkApp`, `react`.
- В отдельной чистой копии интегрированного b35a19f: `npm ci --omit=dev --omit=optional --ignore-scripts --cache /tmp/statusbar-npm-cache`, затем `bb plugin build`. Обе команды завершились с exit 0; установка аудировала один пакет. Сборка установленным BB CLI проходит без dev runtime imports.
- Чистая установка разработки: 149 пакетов, `npm audit` — 0 уязвимостей.
- `git diff --check`: без ошибок whitespace. Demo todo, пример навыка и неиспользуемые vendored components/hooks/lib удалены. README/overview и навык соответствуют read-only поведению; MIT, artbear.

## Живой BB

Плагин установлен и проверен в действующем BB отдельным headless Chromium:

- Native context segment виден в реальных Codex/Cursor тредах; Enter открывает штатное пояснение показателей.
- Навигация и две одновременно открытые split-панели сохраняют правильный provider/thread. В завершённом ходе время и скорость перестают расти.
- При ширине 390 px каждое поле остаётся внутри панели, перенос работает. Проверены host light/dark; page errors отсутствуют.
- В отдельном Cursor-треде наблюдались start, потоковые изменения `симв/с`, completion и заморозка. Token/cache/context отсутствовали и оставались `—`.
- В отдельном Codex-треде первый ответ дал официальный snapshot; при втором ходе наблюдались start, обновление official total/cache/context, численная средняя скорость по известному baseline и заморозка завершения.
- Reload сохраняет ровно одну строку. Disable удаляет slot и прекращает его чтения events; enable восстанавливает одну строку и историческую скорость Cursor.

Полный браузерный smoke повторён после исправления метрик; lifecycle проверен на финальном коде. Это дополняет jsdom проверкой host CSS и нескольких segments. Скриншоты и сырые журналы пользовательских тредов в публичный репозиторий не включены. Публичный источник и команда установки приведены в README.

Ограничения: история ограничена 2 000 подходящими событиями; без нужного начала/счётчика/текста метрика неизвестна. Первый ход Codex обычно не имеет доказанного baseline. Cursor ACP может не предоставлять token/context usage. Неизвестное окончание не восстанавливается из updatedAt. Плагин зависит от экспериментального API SDK 0.6.94, поэтому manifest честно закрепляет эту версию.

## Исправления независимого ревью

Регрессионные traces проверены против findings Standards и Spec исходной реализации 9f785cf. Поздний usage своего закрытого хода уточняет output, completed agentMessage — текст, при неизменном end. Изменившийся usage прежнего хода не становится числителем текущего и делает его baseline недостоверным. Некорректные/регрессирующие поздние counters также инвалидируют скорость. JSON counters проверяются как неотрицательные safe integers, включая безопасную сумму input + output; вычисленные elapsed/speed дополнительно проверяются на конечность.

Session usage ведётся отдельно от выбранного root turn. SDK 0.6.94 описывает token usage как turn-scoped событие с providerThreadId и cumulative total, но без parentToolCallId. Codex translation передаёт providerTurnId; assembler сохраняет соответствие providerTurnId → BB turnId и допускает usage после закрытия (current-or-last turn). Поэтому snapshot-only даёт сессионные total/cache по официальной принадлежности события данному thread/session, не утверждая root-принадлежность и не создавая baseline скорости. Известные nested turn ids исключены; несовпадающий providerThreadId и чужой threadId игнорируются. Если start отсутствует, root-принадлежность не угадывается. Восстановленный root start необходим для turn accounting, но не для сессионных totals. Классификация и per-turn snapshots ограничены 2 000 записями.

Все пять исходных trace-оракулов ревью теперь совпадают: late-own speed 6, late-invalid speed/total null, snapshot-only total 1200/cache 40%, late-prior speed null, late-completed-text speed 1.5. Дополнительные тесты покрывают unsafe integer и finite overflow, неизменившиеся поздние snapshots прежнего хода, известный nested scope, чужую сессию и независимость сохранённого состояния reducer.

Недостоверный поздний snapshot также исключён из baseline следующего хода. Regression trace 160 → late150 → новый ход200 не даёт ложные 5 ток/с; следующий достоверный baseline200 → 260 за10s восстанавливает 6 ток/с. Финальный `npm run check` повторён после интеграции: все 38 тестов, strict typecheck и build прошли.

Независимые проверки описаны в [отчёте ревью](review.md). Новых runtime imports и зависимостей при исправлении не добавлено; сборка без dev dependencies проверяет контракт Git-установки. В исходниках проверено отсутствие секретов, локальных auth/transcript данных и частных машинных путей.

## 0.1.1: fixture-проверка восстановления завершённых Codex ходов

Регрессия сначала воспроизведена на observer seam: один retained BB usage без baseline и закрытый ход давали `speed=null` вместо golden `24 ток/с`. После внедрения own RPC/host reader тесты проверяют одинаковый full-turn rate для warm/cold/reload, UI rerender и frozen duration, отсутствие повторного native чтения на неизменившейся invalidation, late reply после next/clear/session/disconnect/dispose и восстановление BB observation при неответившем native RPC.

Parser/file fixtures полностью вымышлены: последний aggregate нескольких responses, метаданные и session/root/checkpoint/terminal, invalid/unsafe/regressing counters, нулевой output, повреждённый/неполный/oversized файл, архив и соседняя дата, неоднозначность и symlink/ownership, отмена. SDK backend/host/app harness проверяют load-safe factory, server routing на environment host, строгий вход только threadId/turnId, неподдержанный provider и незакрытый/чужой turn, public SDK imports.

`npm run check` включает эти проверки, TypeScript и app/server/host build. Чистая копия с `npm ci --omit=dev --omit=optional --cache /tmp/statusbar-npm-cache --ignore-scripts` также собирает все три артефакта. Live установка, исходный приватный reproducer и независимое ревью текущего дополнения выполняются интегратором отдельно; fixture-прогон не подменяет их.

После независимого review добавлены регрессии reader: завершённый target + незавершённый JSON следующего turn; детерминированный append непосредственно после initial fstat; повторное открытие target полной записью перед partial tail. Reader фиксирует byte boundary и читает только полные записи этого снимка, сохраняя все identity/terminal/counter guards. Регрессии observer проверяют completed с пригодным baseline → поздний NaN/regression собственного usage → первый native recovery; настоящая неудачная попытка по неизменившемуся key остаётся дедуплицированной.

### Итог интеграции 0.1.1

На `802b40f` независимо подтверждены Standards READY и Spec READY; все выявленные замечания закрыты. В основном checkout повторно выполнен `npm run check`: **78 тестов в пяти файлах**, strict TypeScript и app/server/host build — exit 0. Production-only сборка без dev/optional dependencies также прошла.

Исходная браузерная проверка на завершённом Codex-треде теперь проходит: численная скорость совпадает с официальным output полного native turn, остаётся одинаковой после cold-open и перезагрузки страницы и не растёт после завершения. Собственный SDK host harness проверил официальные итоги двух целевых завершённых ходов; один из них содержал множество model responses. Приватные идентификаторы, файлы и их содержимое в репозиторий не включены.

На исправленном коде повторён живой smoke активного Codex и Cursor, двух split-панелей, ширины 390 px, обеих тем и клавиатурного раскрытия; browser page errors отсутствуют. Исходники дополнительно проверены на секреты и частные машинные пути.
