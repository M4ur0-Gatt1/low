/**
 * Barra de herramientas 3D.
 *
 * - Herramientas: Lápiz, Mover, Borrar, Liquify
 * - Superficies guía: Plano, Cilindro, Esfera, Toro, Loft
 * - Modo espejo X
 * - Pincel: color y grosor (opacidad/dureza viven en PropertiesPanel3D)
 *
 * @module design/components/Toolbar3D
 */

import React, { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLowStore } from '../../../store/low-store';
import { ToolType, SurfaceType, GizmoMode, BrushSettings } from '../../../types/design-types';
import { ColorWheel } from './ColorWheel';

/** Presets de pincel: mismos parámetros del motor (size/hardness/presión/
 *  estabilizador), solo con distintos valores por defecto para que cada uno
 *  se sienta distinto — lápiz fino y parejo, tinta con calado marcado y
 *  brillo, pincel grueso y mate ("con volumen"). El color no se toca. */
const BRUSH_PRESETS: { id: string; label: string; values: Omit<BrushSettings, 'color'> }[] = [
  { id: 'fine', label: 'Fino', values: { size: 3, opacity: 1, hardness: 0.9, pressureSensitivity: 0.3, stabilization: 0.2 } },
  { id: 'pencil', label: 'Lápiz', values: { size: 6, opacity: 1, hardness: 0.3, pressureSensitivity: 0.25, stabilization: 0.2 } },
  { id: 'ink', label: 'Tinta', values: { size: 10, opacity: 1, hardness: 0.95, pressureSensitivity: 0.75, stabilization: 0.45 } },
  { id: 'marker', label: 'Marcador', values: { size: 34, opacity: 0.85, hardness: 0.6, pressureSensitivity: 0.1, stabilization: 0.3 } },
  { id: 'brush', label: 'Pincel', values: { size: 22, opacity: 0.92, hardness: 0.15, pressureSensitivity: 0.55, stabilization: 0.35 } },
  { id: 'charcoal', label: 'Carboncillo', values: { size: 28, opacity: 0.8, hardness: 0.05, pressureSensitivity: 0.8, stabilization: 0.35 } },
];

const Icons = {
  Pencil: () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 2l4 4-10 10H7v-5L18 2z"/></svg>,
  Guide: () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray="3 3" strokeLinecap="round"><line x1="3" y1="20" x2="21" y2="4"/></svg>,
  Move: () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="5 9 2 12 5 15"/><polyline points="9 5 12 2 15 5"/><polyline points="15 19 12 22 9 19"/><polyline points="19 9 22 12 19 15"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="12" y1="2" x2="12" y2="22"/></svg>,
  Select: () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 3l7 17 2-7 7-2z" strokeLinejoin="round"/><circle cx="4" cy="3" r="1.6" fill="currentColor" stroke="none"/><circle cx="11" cy="20" r="1.6" fill="currentColor" stroke="none"/><circle cx="18" cy="11" r="1.6" fill="currentColor" stroke="none"/></svg>,
  Eraser: () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20 20H7L3 16c-.8-.8-.8-2 0-2.8L14 2.2c.8-.8 2-.8 2.8 0L22 7.4c.8.8.8 2 0 2.8L12 20"/></svg>,
  Liquify: () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M8 3c-1.3 0-2.5.5-3.5 1.5C3.5 5.5 3 6.7 3 8s.5 2.5 1.5 3.5S7 13 8 13s2.5-.5 3.5-1.5S13 9 13 8s-.5-2.5-1.5-3.5S9 3 8 3z"/><path d="M16 11c-1.3 0-2.5.5-3.5 1.5S11 15 11 16s.5 2.5 1.5 3.5 2.5 1.5 3.5 1.5 2.5-.5 3.5-1.5 1.5-2.5 1.5-3.5-.5-2.5-1.5-3.5-2.5-1.5-3.5-1.5z"/></svg>,
  Scissors: () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><line x1="20" y1="4" x2="8.12" y2="15.88"/><line x1="14.47" y1="14.48" x2="20" y2="20"/><line x1="8.12" y1="8.12" x2="12" y2="12"/></svg>,
  FreeDraw: () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="1.8" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="6" strokeDasharray="2 3"/><circle cx="12" cy="12" r="10.5" strokeDasharray="2 4"/></svg>,
  Plane: () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="3"/></svg>,
  Cylinder: () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.7 4 3 9 3s9-1.3 9-3V5"/></svg>,
  Sphere: () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="9" ry="3"/><path d="M12 3v18"/></svg>,
  Torus: () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="9" ry="4"/></svg>,
  Loft: () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 7c3-2 6-2 9 0s6 2 9 0M3 17c3-2 6-2 9 0s6 2 9 0"/><path d="M3 7v10M21 7v10"/></svg>,
  Mirror: () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 3v18M3 12h18"/><path d="M8 7l-4 5 4 5M16 7l4 5-4 5"/></svg>,
  GizmoMove: () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2v20M2 12h20"/><path d="M9 5l3-3 3 3M9 19l3 3 3-3M5 9l-3 3 3 3M19 9l3 3-3 3"/></svg>,
  GizmoScale: () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="4" y="4" width="9" height="9"/><path d="M13 20h7v-7M20 20L11 11"/></svg>,
  GizmoRotate: () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7"/><polyline points="21 3 21 9 15 9"/></svg>,
};

/** Sección desplegable (toggle) de la barra. */
const Section: React.FC<{ title: string; open: boolean; onToggle: () => void; children: React.ReactNode }> = ({
  title, open, onToggle, children,
}) => (
  <div>
    <button
      onClick={onToggle}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        width: '100%', border: 'none', background: 'transparent', color: '#9aa3b2',
        cursor: 'pointer', fontSize: '10px', textTransform: 'uppercase',
        letterSpacing: '0.5px', padding: '4px 2px', fontFamily: 'system-ui, sans-serif',
      }}
    >
      <span>{title}</span>
      <span style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }}>▸</span>
    </button>
    {open && <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', padding: '2px 0 6px' }}>{children}</div>}
  </div>
);

const iconBtn = (active: boolean): React.CSSProperties => ({
  width: '40px', height: '40px', border: 'none', borderRadius: '6px',
  backgroundColor: active ? '#0078d4' : 'transparent', color: active ? '#fff' : '#ccc',
  cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'all 0.15s',
});
const hoverIn = (e: React.MouseEvent<HTMLButtonElement>, active: boolean) => {
  if (!active) { e.currentTarget.style.backgroundColor = '#3d3d3d'; e.currentTarget.style.color = '#fff'; }
};
const hoverOut = (e: React.MouseEvent<HTMLButtonElement>, active: boolean) => {
  if (!active) { e.currentTarget.style.backgroundColor = 'transparent'; e.currentTarget.style.color = '#ccc'; }
};

export const Toolbar3D: React.FC = () => {
  const {
    currentTool, setCurrentTool, activeSurface, setActiveSurface,
    mirrorMode, setMirrorMode, brushSettings, setBrushSettings, gizmoMode, setGizmoMode,
  } = useLowStore();
  const [showWheel, setShowWheel] = useState(false);
  const [wheelPos, setWheelPos] = useState<{ top: number; left: number } | null>(null);
  const swatchRef = useRef<HTMLButtonElement>(null);
  const toggleWheel = () => {
    if (!showWheel && swatchRef.current) {
      const r = swatchRef.current.getBoundingClientRect();
      setWheelPos({ top: r.top, left: r.right + 8 });
    }
    setShowWheel((v) => !v);
  };
  const [open, setOpen] = useState<Record<string, boolean>>({ dibujo: true, seleccion: false, superficies: false, pincel: true });
  const toggle = (k: string) => setOpen((o) => ({ ...o, [k]: !o[k] }));

  const draw: { id: ToolType; icon: React.FC; label: string }[] = [
    { id: 'pencil', icon: Icons.Pencil, label: 'Lápiz (P)' },
    { id: 'guide', icon: Icons.Guide, label: 'Línea guía — define un plano de dibujo (G)' },
    { id: 'eraser', icon: Icons.Eraser, label: 'Borrar (E)' },
    { id: 'scissors', icon: Icons.Scissors, label: 'Tijera — corta el trazo donde clickees encima (C)' },
    { id: 'liquify', icon: Icons.Liquify, label: 'Liquify — arrastrá para deformar el trazo (radio = tamaño de pincel) (L)' },
  ];
  const sel: { id: ToolType; icon: React.FC; label: string }[] = [
    { id: 'move', icon: Icons.Move, label: 'Seleccionar / Mover (click o lazo) (V)' },
    { id: 'select', icon: Icons.Select, label: 'Editar puntos del vector (A)' },
  ];
  const surfaces: { id: SurfaceType; icon: React.FC; label: string }[] = [
    { id: 'plane', icon: Icons.Plane, label: 'Plano' },
    { id: 'cylinder', icon: Icons.Cylinder, label: 'Cilindro' },
    { id: 'sphere', icon: Icons.Sphere, label: 'Esfera' },
    { id: 'torus', icon: Icons.Torus, label: 'Toro' },
    { id: 'loft', icon: Icons.Loft, label: 'Loft' },
  ];

  const toolBtn = (t: { id: ToolType; icon: React.FC; label: string }) => (
    <button key={t.id} onClick={() => setCurrentTool(t.id)} title={t.label} style={iconBtn(currentTool === t.id)}
      onMouseEnter={(e) => hoverIn(e, currentTool === t.id)} onMouseLeave={(e) => hoverOut(e, currentTool === t.id)}>
      <div style={{ width: '20px', height: '20px' }}><t.icon /></div>
    </button>
  );

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: '2px', padding: '10px',
      backgroundColor: '#2d2d2d', width: 156, maxHeight: 'calc(100vh - 90px)', overflowY: 'auto',
    }}>
      <Section title="Dibujo" open={open.dibujo} onToggle={() => toggle('dibujo')}>
        {draw.map(toolBtn)}
      </Section>

      <Section title="Selección" open={open.seleccion} onToggle={() => toggle('seleccion')}>
        {sel.map(toolBtn)}
        {currentTool === 'move' && ([
          { id: 'translate' as GizmoMode, icon: Icons.GizmoMove, label: 'Gizmo: mover' },
          { id: 'rotate' as GizmoMode, icon: Icons.GizmoRotate, label: 'Gizmo: rotar' },
          { id: 'scale' as GizmoMode, icon: Icons.GizmoScale, label: 'Gizmo: redimensionar' },
        ]).map((g) => (
          <button key={g.id} onClick={() => setGizmoMode(g.id)} title={g.label} style={{ ...iconBtn(gizmoMode === g.id), width: 32, height: 32 }}>
            <div style={{ width: '16px', height: '16px' }}><g.icon /></div>
          </button>
        ))}
      </Section>

      <Section title="Superficies" open={open.superficies} onToggle={() => toggle('superficies')}>
        {surfaces.map((s) => (
          <button key={s.id}
            onClick={() => setActiveSurface(s.id === activeSurface?.type ? null : { type: s.id, params: {} })}
            title={s.label} style={iconBtn(activeSurface?.type === s.id)}
            onMouseEnter={(e) => hoverIn(e, activeSurface?.type === s.id)} onMouseLeave={(e) => hoverOut(e, activeSurface?.type === s.id)}>
            <div style={{ width: '20px', height: '20px' }}><s.icon /></div>
          </button>
        ))}
        {(['x', 'y', 'z'] as const).map((axis) => (
          <button key={axis} onClick={() => setMirrorMode({ ...mirrorMode, [axis]: !mirrorMode[axis] })}
            title={`Simetría ${axis.toUpperCase()}`} style={iconBtn(mirrorMode[axis])}
            onMouseEnter={(e) => hoverIn(e, mirrorMode[axis])} onMouseLeave={(e) => hoverOut(e, mirrorMode[axis])}>
            <span style={{ fontWeight: 700 }}>{axis.toUpperCase()}</span>
          </button>
        ))}
      </Section>

      <Section title="Pincel" open={open.pincel} onToggle={() => toggle('pincel')}>
        {BRUSH_PRESETS.map((p) => (
          <button key={p.id} onClick={() => setBrushSettings({ ...brushSettings, ...p.values })} title={`Preset "${p.label}"`}
            style={{ height: 26, minWidth: 42, padding: '0 6px', border: 'none', borderRadius: 6, backgroundColor: 'transparent', color: '#ccc', cursor: 'pointer', fontSize: 10, fontFamily: 'system-ui, sans-serif' }}
            onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = '#3d3d3d'; e.currentTarget.style.color = '#fff'; }}
            onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; e.currentTarget.style.color = '#ccc'; }}>
            {p.label}
          </button>
        ))}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', marginTop: 4 }}>
          <button ref={swatchRef} onClick={toggleWheel} title="Color del pincel (círculo cromático)"
            style={{ width: 40, height: 40, border: showWheel ? '2px solid #0078d4' : '2px solid transparent', borderRadius: 6, cursor: 'pointer', backgroundColor: brushSettings.color }} />
          <input type="range" min="1" max="100" value={brushSettings.size}
            onChange={(e) => setBrushSettings({ ...brushSettings, size: Number(e.target.value) })}
            title="Tamaño del pincel" style={{ flex: 1, accentColor: '#0078d4' }} />
        </div>
      </Section>

      {showWheel && wheelPos && createPortal(
        <>
          {/* fondo invisible: clickear afuera cierra la rueda */}
          <div onClick={() => setShowWheel(false)} style={{ position: 'fixed', inset: 0, zIndex: 99998 }} />
          <div style={{
            position: 'fixed', top: wheelPos.top, left: wheelPos.left, zIndex: 99999,
            padding: 12, backgroundColor: '#2d2d2d', borderRadius: 8, boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
          }}>
            <ColorWheel value={brushSettings.color} onChange={(color) => setBrushSettings({ ...brushSettings, color })} />
          </div>
        </>,
        document.body,
      )}
    </div>
  );
};

export default Toolbar3D;
