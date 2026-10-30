import { useEffect, useState } from 'react';
import { definePluginApp, type ExperimentalThreadContextSegmentProps } from '@get-bb/plugin-sdk/app';
import { metricView } from './metrics';
import { supports } from './observe-thread';
import { useThreadStatus } from './use-thread-status';
const number = (n: number | null) => n == null ? '—' : new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(n);
const duration = (n: number | null) => n == null ? '—' : `${Math.floor(n / 60).toString().padStart(2, '0')}:${Math.floor(n % 60).toString().padStart(2, '0')}`;
const statuses: Record<string, string> = { active: 'Работает', idle: 'Готов', error: 'Ошибка', pending: 'Ожидание', starting: 'Запуск', stopping: 'Остановка', provisioning: 'Подготовка', 'waiting-for-host': 'Ожидание машины' };
export function Summary(props: ExperimentalThreadContextSegmentProps) {
  const state = useThreadStatus(props.threadId);
  const [now, setNow] = useState(Date.now);
  const active = state.phase === 'ready' && ['active', 'starting', 'stopping', 'pending'].includes(state.thread?.status ?? '');
  useEffect(() => {
    if (!active || state.metrics.turn?.closed) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active, state.metrics.turn?.id, state.metrics.turn?.closed]);
  const provider = state.thread?.providerId ?? '';
  const v = metricView(state.metrics, provider, active, now);
  const ready = state.phase === 'ready';
  const metric = (key: string, text: string) => <span data-metric={key} style={{ whiteSpace: 'nowrap' }}>{text}</span>;
  return <button type="button" onClick={props.onToggle} aria-expanded={props.isExpanded} aria-label="Метрики хода: определения и ограничения"
    data-thread-statusbar={props.threadId} data-thread-id={props.threadId}
    style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.25rem 0.65rem', minWidth: 0, maxWidth: '100%', textAlign: 'left', fontSize: '0.75rem', color: 'inherit', background: 'transparent', border: 0, padding: '0.2rem', cursor: 'pointer' }}>
    {metric('provider', provider === 'codex' ? 'Codex' : provider === 'acp-cursor' ? 'Cursor' : 'Метрики')}
    {metric('model', ready ? v.model ?? '—' : '—')}
    {metric('status', state.phase === 'loading' ? 'Загрузка метрик…' : !ready ? 'Метрики недоступны' : statuses[state.thread?.runtime.displayStatus ?? ''] ?? '—')}
    {metric('elapsed', duration(ready ? v.elapsed : null))}
    {metric('speed', `${provider === 'codex' ? 'сред. ' : ''}${number(ready ? v.speed : null)} ${provider === 'codex' ? 'ток/с' : 'симв/с'}`)}
    {metric('total', `Всего ${number(ready ? v.total : null)} ток`)}
    {metric('cache', `Кеш ${ready && v.cache != null ? number(v.cache) + '%' : '—'}`)}
    {metric('context', `Контекст ${ready && v.context ? `${v.context.estimated ? '≈' : ''}${number(v.context.usedTokens)}/${number(v.context.modelContextWindow)}` : '—'}`)}
  </button>;
}
export function Details({ isExpanded }: ExperimentalThreadContextSegmentProps) {
  if (!isExpanded) return null;
  return <div style={{ fontSize: '0.8rem', padding: '0.5rem', overflowWrap: 'anywhere' }}>
    <p>Время хода включает инструменты и ожидания, начиная с подтверждённого запуска BB. Завершённый ход сохраняет итоговое время. Модель относится к выполнению хода.</p>
    <p>Codex: средняя выдача за весь ход, включая инструменты и ожидания; не скорость декодирования модели. Прирост официального output делится на время хода; reasoning уже включён. Для активного хода нужен достоверный счётчик до начала. Для завершённого хода плагин может восстановить официальный итог того же native turn из локального Codex rollout на машине выполнения.</p>
    <p>Cursor: Unicode символы видимого ответа основного хода за полное время хода. Это наблюдаемые символы, а не токены; завершённый текст заменяет дельты.</p>
    <p>Всего: input + output последнего официального снимка сессии. Кеш: cached input / input. Контекст измеряется провайдером отдельно, ≈ означает оценку. «—» означает отсутствие достоверных данных, начала хода, полного текста или baseline; после ошибки чтения метрики скрыты до успешной сверки.</p>
  </div>;
}
export default definePluginApp(app => {
  app.slots.experimental_threadContextSegment({ id: 'statusbar', title: 'Метрики хода', group: 'statusbar', summary: Summary, details: Details,
    useVisible({ threadId }) { const state = useThreadStatus(threadId); return state.thread != null && supports(state.thread.providerId); } });
});
