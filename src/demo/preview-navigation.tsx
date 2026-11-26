import { useEffect, useState, type RefObject } from 'react';
import { useReaderSearch } from '../renderer/use-reader-search';

export function ReadingSearch({ documentKey, source, onClose }: { documentKey: string; source: string; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState({ query: '', index: -1 });
  const { result, status } = useReaderSearch(documentKey, source, true, query);
  const matches = result?.matches ?? [];
  const selected = cursor.query === query ? cursor.index : -1;
  function jump(step: number) {
    if (!matches.length) return;
    const index = selected < 0 ? step < 0 ? matches.length - 1 : 0 : (selected + step + matches.length) % matches.length;
    const { range, block } = matches[index];
    if (!block.isConnected || !range.startContainer.isConnected) return;
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    block.scrollIntoView({ block: 'center', inline: 'nearest' });
    setCursor({ query, index });
  }
  return <form className="search-bar" aria-label="查找预览" onSubmit={event => { event.preventDefault(); jump(1); }}
    onKeyDown={event => {
      if (event.nativeEvent.isComposing || event.keyCode === 229) return;
      if (event.key === 'Escape') { event.stopPropagation(); onClose(); }
      if (event.key === 'Enter' && event.shiftKey) { event.preventDefault(); jump(-1); }
    }}>
    <input autoFocus aria-label="查找预览文字" placeholder="查找预览文字" value={query}
      onChange={event => { setQuery(event.target.value); setCursor({ query: '', index: -1 }); }} />
    <button type="button" disabled={!matches.length} onClick={() => jump(-1)}>上一处</button>
    <button type="submit" disabled={!matches.length}>下一处</button>
    <span role="status">{status === 'pending' ? '查找中…' : status === 'error' ? '无法查找当前预览'
      : status === 'ready' ? matches.length ? `${Math.max(0, selected + 1)} / ${matches.length}${result?.truncated ? '+' : ''}` : '无匹配' : ''}</span>
    <button type="button" aria-label="关闭查找" onClick={onClose}>×</button>
  </form>;
}

export function useSplitScroll(sourcePane: RefObject<HTMLElement | null>, reading: RefObject<HTMLDivElement | null>,
  documentKey: number, enabled: boolean) {
  useEffect(() => {
    const source = sourcePane.current?.querySelector<HTMLElement>('.cm-scroller');
    const target = reading.current;
    if (!enabled || !source || !target) return;
    let frame = 0;
    let pending: { origin: HTMLElement; destination: HTMLElement } | undefined;
    const synchronized = new WeakMap<HTMLElement, number>();
    function sync(origin: HTMLElement, destination: HTMLElement) {
      const expected = synchronized.get(origin);
      synchronized.delete(origin);
      if (expected !== undefined && Math.abs(origin.scrollTop - expected) < 2) return;
      pending = { origin, destination };
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (!pending) return;
        const { origin, destination } = pending;
        pending = undefined;
        const available = origin.scrollHeight - origin.clientHeight;
        if (available <= 0) return;
        const top = origin.scrollTop / available * (destination.scrollHeight - destination.clientHeight);
        if (Math.abs(destination.scrollTop - top) < 2) return;
        destination.scrollTop = top;
        synchronized.set(destination, destination.scrollTop);
      });
    }
    const fromSource = () => sync(source, target);
    const fromReading = () => sync(target, source);
    source.addEventListener('scroll', fromSource, { passive: true });
    target.addEventListener('scroll', fromReading, { passive: true });
    return () => {
      source.removeEventListener('scroll', fromSource);
      target.removeEventListener('scroll', fromReading);
      cancelAnimationFrame(frame);
    };
  }, [sourcePane, reading, documentKey, enabled]);
}
