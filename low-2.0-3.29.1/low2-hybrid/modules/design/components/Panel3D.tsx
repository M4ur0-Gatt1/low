/**
 * Contenedor de panel flotante MOVIBLE y MINIMIZABLE.
 *
 * Envuelve a Toolbar / Properties / Layers. Se arrastra desde la barra de
 * título y se colapsa con el botón "–". Al arrastrar por primera vez cambia de
 * anclaje (left/right/top/bottom) a coordenadas left/top absolutas.
 *
 * @module design/components/Panel3D
 */

import React, { useRef, useState } from 'react';

interface Anchor {
  left?: number;
  right?: number;
  top?: number;
  bottom?: number;
}

interface Props {
  title: string;
  initial: Anchor;
  width?: number;
  children: React.ReactNode;
}

export const Panel3D: React.FC<Props> = ({ title, initial, width, children }) => {
  const rootRef = useRef<HTMLDivElement>(null);
  const grab = useRef<{ ox: number; oy: number } | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [collapsed, setCollapsed] = useState(false);

  const onMove = (e: PointerEvent) => {
    const el = rootRef.current;
    const parent = el?.offsetParent as HTMLElement | null;
    if (!el || !parent || !grab.current) return;
    const pr = parent.getBoundingClientRect();
    setPos({
      left: e.clientX - pr.left - grab.current.ox,
      top: e.clientY - pr.top - grab.current.oy,
    });
  };
  const onUp = () => {
    grab.current = null;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
  };
  const onHeaderDown = (e: React.PointerEvent) => {
    const el = rootRef.current;
    const parent = el?.offsetParent as HTMLElement | null;
    if (!el || !parent) return;
    const r = el.getBoundingClientRect();
    const pr = parent.getBoundingClientRect();
    grab.current = { ox: e.clientX - r.left, oy: e.clientY - r.top };
    setPos({ left: r.left - pr.left, top: r.top - pr.top }); // fijar antes de mover
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const style: React.CSSProperties = {
    position: 'absolute',
    ...(width ? { width } : {}),
    zIndex: 100,
    borderRadius: 8,
    boxShadow: '0 6px 18px rgba(0,0,0,0.35)',
    // overflow visible: no clipar popovers (p. ej. el círculo cromático)
    ...(pos ? { left: pos.left, top: pos.top } : initial),
  };

  return (
    <div ref={rootRef} style={style}>
      <div
        onPointerDown={onHeaderDown}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '6px 10px',
          background: '#3a3f4b',
          color: '#dfe4ee',
          fontSize: 11,
          fontFamily: 'system-ui, sans-serif',
          textTransform: 'uppercase',
          letterSpacing: '0.5px',
          cursor: 'grab',
          userSelect: 'none',
          touchAction: 'none',
          borderTopLeftRadius: 8,
          borderTopRightRadius: 8,
        }}
      >
        <span>{title}</span>
        <button
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => setCollapsed((c) => !c)}
          title={collapsed ? 'Expandir' : 'Minimizar'}
          style={{
            border: 'none', background: 'transparent', color: '#dfe4ee',
            cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: '0 4px',
          }}
        >
          {collapsed ? '▢' : '–'}
        </button>
      </div>
      {!collapsed && <div>{children}</div>}
    </div>
  );
};

export default Panel3D;
