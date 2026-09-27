import { useEffect, useRef, useState } from 'react';
import { getDocument, GlobalWorkerOptions, TextLayer, type PDFDocumentProxy } from 'pdfjs-dist';
import workerURL from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import 'pdfjs-dist/web/pdf_viewer.css';
import { t } from '../shared/i18n.ts';
import { officeMessage } from './office-messages';
GlobalWorkerOptions.workerSrc = workerURL;
export default function PdfPreview({ url, page, changePage, retry }: { url: string; page: number; changePage: (page: number) => void; retry: () => void }) {
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null), [error, setError] = useState('');
  const [zoom, setZoom] = useState<number | 'fit'>('fit'), [rendering, setRendering] = useState(false);
  const [availableWidth, setAvailableWidth] = useState(0);
  const canvas = useRef<HTMLCanvasElement>(null), textLayer = useRef<HTMLDivElement>(null), scroll = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = scroll.current; if (!element) return;
    const update = () => setAvailableWidth(Math.max(1, element.clientWidth - 30));
    update(); const observer = new ResizeObserver(update); observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    let alive = true; setError('');
    const task = getDocument({ url, withCredentials: true, cMapUrl: '/api/office-assets/cmaps/', cMapPacked: true,
      standardFontDataUrl: '/api/office-assets/standard_fonts/', wasmUrl: '/api/office-assets/wasm/', enableXfa: false });
    void task.promise.then(value => { if (alive) setDocument(value); }).catch(error => { if (alive) setError(officeMessage(error.name === 'PasswordException' ? 'office_encrypted' : 'office_invalid')); });
    return () => { alive = false; setDocument(null); void task.destroy(); };
  }, [url]);
  useEffect(() => {
    if (!document || (zoom === 'fit' && !availableWidth)) return;
    let alive = true; let task: ReturnType<Awaited<ReturnType<PDFDocumentProxy['getPage']>>['render']> | undefined;
    let layer: TextLayer | undefined; setRendering(true); setError('');
    void document.getPage(page).then(async value => {
      if (!alive || !canvas.current || !textLayer.current) return;
      const requestedScale = zoom === 'fit' ? availableWidth / value.getViewport({ scale: 1 }).width : zoom;
      const base = value.getViewport({ scale: requestedScale });
      const scale = requestedScale * Math.min(1, 4096 / Math.max(base.width, base.height));
      const viewport = value.getViewport({ scale }), ratio = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(16_000_000 / (viewport.width * viewport.height)));
      const element = canvas.current; element.width = Math.ceil(viewport.width * ratio); element.height = Math.ceil(viewport.height * ratio);
      element.style.width = `${viewport.width}px`; element.style.height = `${viewport.height}px`;
      const text = textLayer.current; text.replaceChildren(); text.style.setProperty('--scale-factor', String(scale));
      text.parentElement!.style.setProperty('--scale-factor', String(scale)); text.parentElement!.style.setProperty('--total-scale-factor', String(scale));
      task = value.render({ canvas: element, viewport, transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0] });
      await Promise.all([task.promise, value.getTextContent().then(async content => {
        if (!alive) return;
        layer = new TextLayer({ textContentSource: content, container: text, viewport });
        await layer.render();
      })]); if (alive) setRendering(false);
    }).catch(error => { if (alive && error.name !== 'RenderingCancelledException') { setError(officeMessage('office_invalid')); setRendering(false); } });
    return () => { alive = false; task?.cancel(); layer?.cancel(); };
  }, [document, page, zoom, availableWidth]);
  return <div className="office-pdf"><div className="office-document-controls">
    <button disabled={!document || page <= 1} onClick={() => changePage(page - 1)}>{t('上一页')}</button>
    <label>{t('页码')} <input type="number" min={1} max={document?.numPages || 1} value={page} onChange={event => {
      const next = Number(event.target.value); if (Number.isInteger(next) && next > 0 && next <= (document?.numPages || 1)) changePage(next);
    }} /> / {document?.numPages || '—'}</label>
    <button disabled={!document || page >= document.numPages} onClick={() => changePage(page + 1)}>{t('下一页')}</button>
    <label>{t('缩放')} <select value={zoom} onChange={event => setZoom(event.target.value === 'fit' ? 'fit' : Number(event.target.value))}><option value="fit">{t('适应宽度')}</option>{[0.5, 0.75, 1, 1.25, 1.5, 2].map(value => <option value={value} key={value}>{value * 100}%</option>)}</select></label>
    {rendering && <span role="status">{t('正在读取…')}</span>}</div>
    {error && <p className="office-error office-empty" role="alert">{error}<button onClick={retry}>{t('重试')}</button></p>}{!document && !error && <p role="status">{t('正在读取…')}</p>}
    <div className="office-pdf-scroll" ref={scroll} aria-busy={rendering} hidden={!!error}><div className="office-pdf-page"><canvas ref={canvas} aria-label={t('PDF 页面')} /><div className="textLayer" ref={textLayer} /></div></div>
  </div>;
}
