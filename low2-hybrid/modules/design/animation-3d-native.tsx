/**
 * LOW 2.0 - Estudio de dibujo 3D estilo Feather.
 *
 * Monta el viewport WebGL (WebGLDesign3D) y superpone la UI flotante
 * (Toolbar / Properties / Layers) + toggle de fondo claro/oscuro. El motor es
 * dueño de la interacción y lee el store; los paneles solo mutan el store.
 *
 * @module design/animation-3d-native
 */

import React, { useEffect, useRef, useState } from 'react';
import { WebGLDesign3D, type Theme, type ViewName } from './engine/webgl-design3d';
import { lowStore } from '../../store/low-store';
import { Toolbar3D } from './components/Toolbar3D';
import { PropertiesPanel3D } from './components/PropertiesPanel3D';
import { LayerManager3D } from './components/LayerManager3D';
import { Panel3D } from './components/Panel3D';

const bg: Record<Theme, string> = {
  light: 'radial-gradient(120% 120% at 50% 10%, #ffffff 0%, #eef1f6 70%, #e6eaf1 100%)',
  dark: 'radial-gradient(120% 120% at 50% 15%, #1b2030 0%, #0e0f13 60%, #08090c 100%)',
};

interface Props {
  projectId?: string;
  readOnly?: boolean;
  onRequestClose?: () => void;
}

export const Animation3DNative: React.FC<Props> = ({ projectId = 'default', onRequestClose }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<WebGLDesign3D | null>(null);
  const [theme, setTheme] = useState<Theme>('light');

  useEffect(() => {
    if (!canvasRef.current || !containerRef.current) return;
    const engine = new WebGLDesign3D();
    engine.mount(canvasRef.current, containerRef.current);
    engine.setTheme(theme);
    engineRef.current = engine;
    (window as unknown as { __low3d?: WebGLDesign3D }).__low3d = engine;
    (window as unknown as { __lowStore?: typeof lowStore }).__lowStore = lowStore;
    return () => {
      engine.dispose();
      engineRef.current = null;
    };
    // solo al montar; los cambios de tema se aplican en el efecto de abajo
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  useEffect(() => {
    engineRef.current?.setTheme(theme);
  }, [theme]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !onRequestClose) return;
      event.preventDefault();
      onRequestClose();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [onRequestClose]);

  const [view, setView] = useState<ViewName>('persp');
  const [axes, setAxes] = useState(false);
  const [guideOpacity, setGuideOpacity] = useState(100);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const dark = theme === 'dark';
  const chipBg = dark ? 'rgba(20,22,28,0.6)' : 'rgba(255,255,255,0.7)';
  const chipFg = dark ? '#8a93a6' : '#5b6472';
  const chipActive = '#0078d4';

  const eng = () => engineRef.current;
  const saveProject = () => {
    const project = eng()?.exportProject();
    if (!project) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `${projectId || 'proyecto'}.low3d`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };
  const openProject = async (file?: File) => {
    if (!file) return;
    try { eng()?.importProject(JSON.parse(await file.text())); }
    catch (error) { window.alert(error instanceof Error ? error.message : 'No se pudo abrir el proyecto'); }
  };
  const applyView = (v: ViewName) => {
    eng()?.setView(v);
    setView(v);
  };

  const barBtn = (label: string, onClick: () => void, active = false, title?: string): React.ReactNode => (
    <button
      onClick={onClick}
      title={title ?? label}
      style={{
        height: 30,
        padding: '0 10px',
        borderRadius: 6,
        border: 'none',
        cursor: 'pointer',
        background: active ? chipActive : 'transparent',
        color: active ? '#fff' : chipFg,
        fontSize: 12,
      }}
    >
      {label}
    </button>
  );

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', background: bg[theme], overflow: 'hidden' }} ref={containerRef}>
      <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} onContextMenu={(e) => e.preventDefault()} />
      <input ref={fileInputRef} type="file" accept=".low3d,application/json" hidden
        onChange={(e) => { void openProject(e.target.files?.[0]); e.currentTarget.value = ''; }} />

      {onRequestClose && (
        <button onClick={onRequestClose} title="Cerrar módulo 3D (Esc)" style={{
          position: 'absolute', top: 14, left: 14, zIndex: 110, height: 36,
          padding: '0 12px', border: 'none', borderRadius: 8, cursor: 'pointer',
          background: chipBg, color: chipFg, fontSize: 12,
        }}>← Salir de 3D</button>
      )}

      <Panel3D title="Herramientas" initial={{ left: 14, top: 60 }}>
        <Toolbar3D />
      </Panel3D>
      <Panel3D title="Pincel / Superficie" initial={{ right: 14, top: 60 }} width={220}>
        <PropertiesPanel3D />
      </Panel3D>
      <Panel3D title="Capas" initial={{ left: 14, bottom: 14 }} width={240}>
        <LayerManager3D engine={engineRef} />
      </Panel3D>

      <div title="Joystick de orientación" style={{
        position: 'absolute', right: 14, bottom: 62, zIndex: 105,
        display: 'grid', gridTemplateColumns: 'repeat(3, 34px)', gap: 3,
        padding: 6, borderRadius: 12, background: chipBg,
      }}>
        <span />{barBtn('Y+', () => applyView('top'), view === 'top', 'Vista superior')}<span />
        {barBtn('X−', () => applyView('left'), view === 'left', 'Vista izquierda')}
        {barBtn('3D', () => applyView('persp'), view === 'persp', 'Vista perspectiva')}
        {barBtn('X+', () => applyView('right'), view === 'right', 'Vista derecha')}
        <span />{barBtn('Z+', () => applyView('front'), view === 'front', 'Vista frontal')}<span />
      </div>

      <button
        onClick={() => setTheme(dark ? 'light' : 'dark')}
        title="Fondo claro / oscuro"
        style={{
          position: 'absolute',
          top: 14,
          right: 250,
          zIndex: 100,
          width: 36,
          height: 36,
          borderRadius: 8,
          border: 'none',
          cursor: 'pointer',
          background: chipBg,
          color: chipFg,
          fontSize: 16,
        }}
      >
        {dark ? '☀' : '☾'}
      </button>

      {/* Barra superior central: deshacer/rehacer + vistas */}
      <div
        style={{
          position: 'absolute',
          top: 14,
          left: '50%',
          transform: 'translateX(-50%)',
          zIndex: 100,
          display: 'flex',
          alignItems: 'center',
          gap: 2,
          padding: 4,
          borderRadius: 8,
          background: chipBg,
        }}
      >
        {barBtn('⟲', () => eng()?.undo(), false, 'Deshacer (Ctrl+Z)')}
        {barBtn('⟳', () => eng()?.redo(), false, 'Rehacer (Ctrl+Alt+Z / Ctrl+Shift+Z)')}
        <span style={{ width: 1, height: 18, background: dark ? '#3a3f4b' : '#cfd4dd', margin: '0 4px' }} />
        {barBtn('Abrir', () => fileInputRef.current?.click(), false, 'Abrir proyecto LOW 3D')}
        {barBtn('Guardar', saveProject, false, 'Guardar proyecto LOW 3D')}
        <span style={{ width: 1, height: 18, background: dark ? '#3a3f4b' : '#cfd4dd', margin: '0 4px' }} />
        {barBtn('Persp', () => applyView('persp'), view === 'persp')}
        {barBtn('Frente', () => applyView('front'), view === 'front', 'Vista ortogonal de frente (para el primer dibujo)')}
        {barBtn('Detrás', () => applyView('back'), view === 'back', 'Vista ortogonal de atrás')}
        {barBtn('Izquierda', () => applyView('left'), view === 'left', 'Vista ortogonal desde la izquierda')}
        {barBtn('Derecha', () => applyView('right'), view === 'right', 'Vista ortogonal desde la derecha')}
        {barBtn('Arriba', () => applyView('top'), view === 'top', 'Vista ortogonal desde arriba')}
        {barBtn('Abajo', () => applyView('bottom'), view === 'bottom', 'Vista ortogonal desde abajo')}
        <span style={{ width: 1, height: 18, background: dark ? '#3a3f4b' : '#cfd4dd', margin: '0 4px' }} />
        {barBtn('XYZ', () => setAxes(!!eng()?.toggleAxes()), axes,
          'Ejes globales XYZ + puntos de fuga de cada eje (solo en perspectiva) — guía visual, no se dibuja ni exporta')}
      </div>

      <button
        onClick={() => engineRef.current?.deleteGuide()}
        title="Borrar la última guía creada (los trazos se conservan) — para borrar cualquier otra, Goma + click sobre ella"
        style={{
          position: 'absolute',
          top: 14,
          right: 294,
          zIndex: 100,
          height: 36,
          padding: '0 12px',
          borderRadius: 8,
          border: 'none',
          cursor: 'pointer',
          background: chipBg,
          color: chipFg,
          fontSize: 12,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
        }}
      >
        🗑 Borrar guía
      </button>

      <div
        title="Opacidad de las guías — bajala a 0 para dibujar 'en el aire' sin que la hoja estorbe visualmente; sigue dando soporte a los trazos aunque no se vea (truco de Feather)"
        style={{
          position: 'absolute', top: 14, right: 356, zIndex: 100,
          height: 36, padding: '0 10px', borderRadius: 8, background: chipBg,
          display: 'flex', alignItems: 'center', gap: 6,
        }}
      >
        <span style={{ fontSize: 11, color: chipFg }}>👻</span>
        <input type="range" min={0} max={100} value={guideOpacity}
          onChange={(e) => { const v = Number(e.target.value); setGuideOpacity(v); eng()?.setGuideOpacity(v / 100); }}
          style={{ width: 70, accentColor: '#0078d4' }} />
      </div>

      <div
        style={{
          position: 'absolute',
          bottom: 14,
          right: 14,
          zIndex: 100,
          color: chipFg,
          fontSize: 11,
          fontFamily: 'system-ui, sans-serif',
          background: chipBg,
          padding: '6px 10px',
          borderRadius: 6,
          lineHeight: 1.5,
          pointerEvents: 'none',
        }}
      >
Teclas: P lápiz · G guía · F dibujo libre (sin guía, scroll = profundidad) · V mover (click en una guía = mover/deformar con gizmo, Ctrl+D duplica; con rotar, arrastrá el eje rosa) · A puntos · E goma · C tijera · Shift recta · Alt hilo tenso (eje X/Y/Z) · Ctrl+C/V copia · Supr borra · Ctrl+Z/Ctrl+Alt+Z
      </div>
    </div>
  );
};

export default Animation3DNative;
