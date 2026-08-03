/**
 * LOW 2.0 - Módulo de Diseño y Animación 3D (Versión Híbrida)
 * 
 * Este módulo reemplaza al canvas3d.tsx original manteniendo la misma interfaz de usuario,
 * pero delegando el renderizado pesado y el cálculo geométrico al motor nativo C++.
 * 
 * Características migradas:
 * - Superficies guía (Plano, Cilindro, Esfera, Toro, Loft)
 * - Herramientas de dibujo (Lápiz, Borrador, Movimiento)
 * - Modo Espejo X
 * - Importación/Exportación de mallas
 * - Liquify y deformaciones
 * 
 * @module design/animation-3d-native
 */

import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useLowStore } from '../../store/low-store';
import { ToolType, SurfaceType } from '../../types/design-types';
import { nativeBridge } from '../../native/bridge/low-bridge';
import { useNativeStrokeEngine } from './hooks/useNativeStrokeEngine';
import { LegacyCanvasFallback } from './canvas3d-legacy';
import { Toolbar3D } from './components/Toolbar3D';
import { PropertiesPanel3D } from './components/PropertiesPanel3D';
import { LayerManager3D } from './components/LayerManager3D';

// Estilos integrados (mismos que la versión anterior para consistencia visual)
const styles = {
  container: {
    display: 'flex',
    flexDirection: 'column' as const,
    width: '100%',
    height: '100%',
    backgroundColor: '#1e1e1e',
    overflow: 'hidden',
  },
  viewportContainer: {
    flex: 1,
    position: 'relative' as const,
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    overflow: 'hidden',
  },
  canvasRef: {
    width: '100%',
    height: '100%',
    outline: 'none',
    cursor: 'crosshair',
  },
  overlay: {
    position: 'absolute' as const,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    pointerEvents: 'none' as const,
  },
  toolbarWrapper: {
    position: 'absolute' as const,
    top: 10,
    left: 10,
    zIndex: 100,
    pointerEvents: 'auto' as const,
  },
  propertiesWrapper: {
    position: 'absolute' as const,
    top: 10,
    right: 10,
    zIndex: 100,
    pointerEvents: 'auto' as const,
  },
  layerWrapper: {
    position: 'absolute' as const,
    bottom: 10,
    left: 10,
    zIndex: 100,
    pointerEvents: 'auto' as const,
  },
  loadingOverlay: {
    position: 'absolute' as const,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.7)',
    color: '#fff',
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    fontSize: '14px',
    zIndex: 200,
  },
};

interface Animation3DNativeProps {
  projectId: string;
  readOnly?: boolean;
}

export const Animation3DNative: React.FC<Animation3DNativeProps> = ({ 
  projectId, 
  readOnly = false 
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  
  // Estado local sincronizado con el store global
  const { 
    currentTool, 
    activeSurface, 
    mirrorMode, 
    brushSettings, 
    selectedObject 
  } = useLowStore();

  const [isNativeReady, setIsNativeReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Hook personalizado que maneja la lógica de input -> C++
  const { 
    handlePointerDown, 
    handlePointerMove, 
    handlePointerUp, 
    initializeEngine 
  } = useNativeStrokeEngine({
    canvasRef,
    projectId,
    readOnly,
    onNativeReady: () => setIsNativeReady(true),
    onError: (err) => setError(err.message),
  });

  // Inicialización del contexto nativo
  useEffect(() => {
    if (canvasRef.current && containerRef.current) {
      initializeEngine(canvasRef.current, containerRef.current);
    }

    return () => {
      // Limpieza al desmontar
      if (nativeBridge.design3D) {
        nativeBridge.design3D.dispose(projectId);
      }
    };
  }, [projectId, initializeEngine]);

  // Sincronización de herramientas en tiempo real
  useEffect(() => {
    if (!isNativeReady || !nativeBridge.design3D) return;

    nativeBridge.design3D.setActiveTool(currentTool);
    nativeBridge.design3D.setMirrorMode(mirrorMode);
    nativeBridge.design3D.updateBrushSettings(brushSettings);
  }, [currentTool, mirrorMode, brushSettings, isNativeReady]);

  // Sincronización de superficies
  useEffect(() => {
    if (!isNativeReady || !nativeBridge.design3D) return;

    if (activeSurface) {
      nativeBridge.design3D.createSurface(activeSurface.type, activeSurface.params);
    }
  }, [activeSurface, isNativeReady]);

  // Manejadores de eventos unificados
  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (readOnly) return;
    handlePointerDown(e);
  }, [readOnly, handlePointerDown]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (readOnly) return;
    handlePointerMove(e);
  }, [readOnly, handlePointerMove]);

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    if (readOnly) return;
    handlePointerUp(e);
  }, [readOnly, handlePointerUp]);

  // Fallback si el módulo nativo falla
  if (error) {
    console.warn('Fallo en motor nativo 3D, usando fallback JS:', error);
    return <LegacyCanvasFallback projectId={projectId} readOnly={readOnly} />;
  }

  return (
    <div style={styles.container} ref={containerRef}>
      {/* Overlay de carga mientras inicia C++ */}
      {!isNativeReady && (
        <div style={styles.loadingOverlay}>
          Iniciando motor de renderizado 3D...
        </div>
      )}

      {/* Lienzo Nativo */}
      <canvas
        ref={canvasRef}
        style={styles.canvasRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onContextMenu={(e) => e.preventDefault()}
        tabIndex={0}
      />

      {/* UI Flotante (Misma que la versión anterior) */}
      <div style={styles.toolbarWrapper}>
        <Toolbar3D />
      </div>

      <div style={styles.propertiesWrapper}>
        <PropertiesPanel3D />
      </div>

      <div style={styles.layerWrapper}>
        <LayerManager3D />
      </div>
      
      {/* Overlay para capturar eventos globales si es necesario */}
      <div style={styles.overlay} />
    </div>
  );
};

export default Animation3DNative;
