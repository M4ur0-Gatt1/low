/**
 * Hook personalizado para conectar el Input de React con el Motor Nativo C++
 * 
 * Este hook actúa como puente entre los eventos de puntero de React (mouse, touch, lápiz)
 * y el Stroke Engine nativo escrito en C++.
 * 
 * Características:
 * - Normalización de eventos de puntero (Wacom, Huion, Mouse, Touch)
 * - Gestión de presión, inclinación y rotación del lápiz
 * - Sincronización con el estado global de LOW
 * - Manejo de errores y fallback automático
 */

import { useRef, useCallback, useEffect } from 'react';
import { nativeBridge } from '../../../native/bridge/low-bridge';
import { ToolType } from '../../../types/design-types';

interface UseNativeStrokeEngineOptions {
  canvasRef: React.RefObject<HTMLCanvasElement>;
  projectId: string;
  readOnly: boolean;
  onNativeReady: () => void;
  onError: (error: Error) => void;
}

interface UseNativeStrokeEngineReturn {
  handlePointerDown: (e: React.PointerEvent) => void;
  handlePointerMove: (e: React.PointerEvent) => void;
  handlePointerUp: (e: React.PointerEvent) => void;
  initializeEngine: (canvas: HTMLCanvasElement, container: HTMLDivElement) => Promise<void>;
}

export const useNativeStrokeEngine = ({
  canvasRef,
  projectId,
  readOnly,
  onNativeReady,
  onError,
}: UseNativeStrokeEngineOptions): UseNativeStrokeEngineReturn => {
  const isDrawingRef = useRef(false);
  const lastPointRef = useRef<{ x: number; y: number } | null>(null);
  const engineInitializedRef = useRef(false);

  // Inicialización del motor nativo
  const initializeEngine = useCallback(async (
    canvas: HTMLCanvasElement,
    container: HTMLDivElement
  ) => {
    try {
      if (!nativeBridge.design3D) {
        throw new Error('El puente nativo no está disponible');
      }

      const rect = canvas.getBoundingClientRect();
      const width = Math.floor(rect.width);
      const height = Math.floor(rect.height);

      // Configurar DPI para pantallas retina
      const dpr = window.devicePixelRatio || 1;
      canvas.width = width * dpr;
      canvas.height = height * dpr;

      // Inicializar contexto nativo
      await nativeBridge.design3D.initialize({
        canvas,
        projectId,
        width: canvas.width,
        height: canvas.height,
        dpr,
      });

      engineInitializedRef.current = true;
      onNativeReady();
      
      console.log('[LOW 2.0] Motor 3D nativo inicializado correctamente');
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      onError(error);
      console.error('[LOW 2.0] Error al inicializar motor nativo:', error);
    }
  }, [projectId, onNativeReady, onError]);

  // Conversión de coordenadas de pantalla a espacio 3D
  const getNormalizedCoordinates = useCallback((
    e: React.PointerEvent,
    canvas: HTMLCanvasElement
  ) => {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    
    // Normalizar a [-1, 1] para OpenGL
    const normalizedX = (x / rect.width) * 2 - 1;
    const normalizedY = -(y / rect.height) * 2 + 1; // Y invertido para OpenGL
    
    return { x: normalizedX, y: normalizedY };
  }, []);

  // Manejo de inicio de trazo
  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if (readOnly || !engineInitializedRef.current || !nativeBridge.design3D) {
      return;
    }

    e.preventDefault();
    canvasRef.current?.setPointerCapture(e.pointerId);
    
    isDrawingRef.current = true;
    
    const canvas = canvasRef.current;
    if (!canvas) return;

    const { x, y } = getNormalizedCoordinates(e, canvas);
    
    // Datos completos del input incluyendo presión y tilt
    const inputData = {
      x,
      y,
      pressure: e.pressure || 0.5, // Default 0.5 si no hay presión
      tiltX: e.tiltX || 0,
      tiltY: e.tiltY || 0,
      twist: 0, // No soportado en PointerEvents estándar
      timestamp: Date.now(),
      pointerType: e.pointerType as 'mouse' | 'pen' | 'touch',
    };

    nativeBridge.design3D.onPointerDown(inputData);
    lastPointRef.current = { x: e.clientX, y: e.clientY };
  }, [readOnly, canvasRef, getNormalizedCoordinates]);

  // Manejo de movimiento durante el trazo
  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!engineInitializedRef.current || !nativeBridge.design3D) {
      return;
    }

    e.preventDefault();
    
    const canvas = canvasRef.current;
    if (!canvas) return;

    const { x, y } = getNormalizedCoordinates(e, canvas);
    
    const inputData = {
      x,
      y,
      pressure: e.pressure || (isDrawingRef.current ? 0.5 : 0),
      tiltX: e.tiltX || 0,
      tiltY: e.tiltY || 0,
      twist: 0,
      timestamp: Date.now(),
      pointerType: e.pointerType as 'mouse' | 'pen' | 'touch',
      isDrawing: isDrawingRef.current,
    };

    if (isDrawingRef.current) {
      nativeBridge.design3D.onPointerMove(inputData);
    } else {
      // Solo hover para preview
      nativeBridge.design3D.onPointerHover(inputData);
    }
    
    lastPointRef.current = { x: e.clientX, y: e.clientY };
  }, [canvasRef, getNormalizedCoordinates]);

  // Manejo de fin de trazo
  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    if (readOnly || !engineInitializedRef.current || !nativeBridge.design3D) {
      return;
    }

    e.preventDefault();
    isDrawingRef.current = false;
    lastPointRef.current = null;
    
    canvasRef.current?.releasePointerCapture(e.pointerId);
    
    const canvas = canvasRef.current;
    if (!canvas) return;

    const { x, y } = getNormalizedCoordinates(e, canvas);
    
    nativeBridge.design3D.onPointerUp({
      x,
      y,
      pressure: 0,
      tiltX: 0,
      tiltY: 0,
      twist: 0,
      timestamp: Date.now(),
      pointerType: e.pointerType as 'mouse' | 'pen' | 'touch',
    });
  }, [readOnly, canvasRef, getNormalizedCoordinates]);

  return {
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
    initializeEngine,
  };
};

export default useNativeStrokeEngine;
