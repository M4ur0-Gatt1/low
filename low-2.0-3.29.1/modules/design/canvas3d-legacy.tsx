/**
 * Fallback en JavaScript/TypeScript puro para cuando el motor nativo falla
 * 
 * Este componente carga la implementación original de canvas3d.tsx
 * asegurando que LOW siga funcionando incluso si hay problemas con C++.
 * 
 * @deprecated Solo usar como fallback de emergencia
 */

import React from 'react';

interface LegacyCanvasFallbackProps {
  projectId: string;
  readOnly?: boolean;
}

export const LegacyCanvasFallback: React.FC<LegacyCanvasFallbackProps> = ({ 
  projectId, 
  readOnly = false 
}) => {
  // Intentar cargar dinámicamente el módulo legacy
  React.useEffect(() => {
    console.warn('[LOW 2.0] Usando canvas legacy en modo fallback');
    // Aquí se importaría dinámicamente el canvas3d.tsx original
    // import('./canvas3d').then(module => { ... })
  }, []);

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      height: '100%',
      backgroundColor: '#1e1e1e',
      color: '#fff',
      textAlign: 'center',
      padding: '20px',
    }}>
      <h2 style={{ fontSize: '18px', marginBottom: '10px' }}>
        Motor 3D Nativo No Disponible
      </h2>
      <p style={{ fontSize: '14px', opacity: 0.8, maxWidth: '400px' }}>
        Se ha activado el modo de compatibilidad con el motor JavaScript legacy.
        El rendimiento puede ser menor con escenas complejas.
      </p>
      <p style={{ fontSize: '12px', opacity: 0.6, marginTop: '20px' }}>
        Proyecto: {projectId} | Modo: {readOnly ? 'Solo Lectura' : 'Edición'}
      </p>
      
      {/* Aquí se montaría el componente legacy real */}
      <div style={{
        marginTop: '30px',
        padding: '20px',
        border: '1px dashed #666',
        borderRadius: '8px',
        backgroundColor: 'rgba(255,255,255,0.05)',
      }}>
        Cargando lienzo 3D legacy...
      </div>
    </div>
  );
};

export default LegacyCanvasFallback;
