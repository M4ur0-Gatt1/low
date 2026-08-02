/**
 * Panel de propiedades del módulo 3D.
 *
 * Controles finos que no entran en la Toolbar: opacidad y dureza del pincel, y
 * los parámetros geométricos de la superficie guía activa (radio, segmentos).
 * Todo se sincroniza con el store global.
 *
 * @module design/components/PropertiesPanel3D
 */

import React from 'react';
import { useLowStore } from '../../../store/low-store';

const panelStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '12px',
  padding: '14px',
  width: '220px',
  backgroundColor: '#2d2d2d',
  borderRadius: '8px',
  boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
  color: '#ccc',
  fontSize: '12px',
  fontFamily: 'system-ui, sans-serif',
};

const labelStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  gap: '8px',
};

const sliderStyle: React.CSSProperties = {
  width: '100%',
  accentColor: '#0078d4',
};

const sectionTitle: React.CSSProperties = {
  fontSize: '11px',
  textTransform: 'uppercase',
  letterSpacing: '0.5px',
  color: '#888',
  marginBottom: '2px',
};

export const PropertiesPanel3D: React.FC = () => {
  const { brushSettings, setBrushSettings, activeSurface, setActiveSurface, selectedObject } =
    useLowStore();

  const surfaceRadius = Number(activeSurface?.params.radius ?? 1);
  const surfaceSegments = Number(activeSurface?.params.segments ?? 32);

  const updateSurfaceParam = (key: string, value: number) => {
    if (!activeSurface) return;
    setActiveSurface({
      ...activeSurface,
      params: { ...activeSurface.params, [key]: value },
    });
  };

  const updateSurfaceVector = (key: 'position' | 'rotation' | 'scale', axis: number, value: number) => {
    if (!activeSurface) return;
    const fallback = key === 'scale' ? [1, 1, 1] : [0, 0, 0];
    const vector = [...((activeSurface.params[key] as number[] | undefined) ?? fallback)];
    vector[axis] = value;
    setActiveSurface({ ...activeSurface, params: { ...activeSurface.params, [key]: vector } });
  };

  return (
    <div style={panelStyle}>
      {/* Pincel */}
      <div style={sectionTitle}>Pincel</div>

      <label style={labelStyle}>
        <span>Opacidad</span>
        <span>{Math.round(brushSettings.opacity * 100)}%</span>
      </label>
      <input
        type="range"
        min={0}
        max={100}
        value={Math.round(brushSettings.opacity * 100)}
        onChange={(e) =>
          setBrushSettings({ ...brushSettings, opacity: Number(e.target.value) / 100 })
        }
        style={sliderStyle}
      />

      <label style={labelStyle}>
        <span>Dureza</span>
        <span>{Math.round(brushSettings.hardness * 100)}%</span>
      </label>
      <input
        type="range"
        min={0}
        max={100}
        value={Math.round(brushSettings.hardness * 100)}
        onChange={(e) =>
          setBrushSettings({ ...brushSettings, hardness: Number(e.target.value) / 100 })
        }
        style={sliderStyle}
      />

      <label style={labelStyle}>
        <span>Sensibilidad a la presión</span>
        <span>{Math.round(brushSettings.pressureSensitivity * 100)}%</span>
      </label>
      <input
        type="range"
        min={0}
        max={100}
        value={Math.round(brushSettings.pressureSensitivity * 100)}
        onChange={(e) =>
          setBrushSettings({ ...brushSettings, pressureSensitivity: Number(e.target.value) / 100 })
        }
        title="Cuánto adelgaza el trazo con poca presión del lápiz (0% = ancho constante). El mouse siempre dibuja a ancho completo."
        style={sliderStyle}
      />

      <label style={labelStyle}>
        <span>Estabilizador (pulso)</span>
        <span>{Math.round(brushSettings.stabilization * 100)}%</span>
      </label>
      <input
        type="range"
        min={0}
        max={100}
        value={Math.round(brushSettings.stabilization * 100)}
        onChange={(e) =>
          setBrushSettings({ ...brushSettings, stabilization: Number(e.target.value) / 100 })
        }
        title="Suaviza el temblor de la mano retrasando un poco el trazo respecto al puntero real (0% = crudo, como antes)."
        style={sliderStyle}
      />

      {/* Superficie activa */}
      <div style={{ height: '1px', backgroundColor: '#444', margin: '2px 0' }} />
      <div style={sectionTitle}>
        Superficie{activeSurface ? `: ${activeSurface.type}` : ''}
      </div>

      {activeSurface ? (
        <>
          <label style={labelStyle}>
            <span>Radio</span>
            <span>{surfaceRadius.toFixed(1)}</span>
          </label>
          <input
            type="range"
            min={1}
            max={100}
            value={surfaceRadius * 10}
            onChange={(e) => updateSurfaceParam('radius', Number(e.target.value) / 10)}
            style={sliderStyle}
          />

          <label style={labelStyle}>
            <span>Segmentos</span>
            <span>{surfaceSegments}</span>
          </label>
          <input
            type="range"
            min={3}
            max={128}
            value={surfaceSegments}
            onChange={(e) => updateSurfaceParam('segments', Number(e.target.value))}
            style={sliderStyle}
          />

          {(['position', 'rotation', 'scale'] as const).map((key) => {
            const fallback = key === 'scale' ? [1, 1, 1] : [0, 0, 0];
            const values = (activeSurface.params[key] as number[] | undefined) ?? fallback;
            const label = key === 'position' ? 'Posición' : key === 'rotation' ? 'Rotación' : 'Escala';
            return (
              <div key={key}>
                <div style={{ ...sectionTitle, marginTop: 8 }}>{label}</div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 4 }}>
                  {(['X', 'Y', 'Z'] as const).map((axis, i) => (
                    <label key={axis} style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                      <span style={{ color: axis === 'X' ? '#ff6868' : axis === 'Y' ? '#67d47b' : '#65a8ff' }}>{axis}</span>
                      <input type="number" step={key === 'rotation' ? 5 : 0.1} value={Number(values[i] ?? fallback[i])}
                        onChange={(e) => updateSurfaceVector(key, i, Number(e.target.value))}
                        style={{ width: '100%', minWidth: 0, background: '#1e1e1e', color: '#eee', border: '1px solid #555', borderRadius: 3 }} />
                    </label>
                  ))}
                </div>
              </div>
            );
          })}
        </>
      ) : (
        <div style={{ opacity: 0.6, fontStyle: 'italic' }}>
          Elegí una superficie en la barra para editar sus parámetros.
        </div>
      )}

      {/* Selección */}
      {selectedObject && (
        <>
          <div style={{ height: '1px', backgroundColor: '#444', margin: '2px 0' }} />
          <div style={sectionTitle}>Selección</div>
          <div>
            {selectedObject.name ?? selectedObject.id}{' '}
            <span style={{ opacity: 0.6 }}>({selectedObject.type})</span>
          </div>
        </>
      )}
    </div>
  );
};

export default PropertiesPanel3D;
