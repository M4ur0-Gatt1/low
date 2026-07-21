#!/usr/bin/env python3
"""LOW Animation Studio — CLI y API del pipeline de animación unificado.

Uso:
  python low_anim.py new proyecto_nuevo          # Crear proyecto nuevo
  python low_anim.py scene proyecto/lola.json    # Abrir escena
  python low_anim.py render escena.json -o out.mp4   # Renderizar
  python low_anim.py rig personaje.json          # Crear rig
  python low_anim.py export escena.json --format lottie  # Exportar Lottie
  python low_anim.py storyboard guion.txt        # Generar storyboard con IA
"""
import argparse
import json
import sys
from pathlib import Path
from typing import Optional

# Asegurar que tools/animation está en el path
sys.path.insert(0, str(Path(__file__).parent))

from tools.animation.core import (
    AnimationEngine, Scene, Layer, Actor, Transform, Keyframe, Bone
)
from tools.animation.timeline import Timeline, Track, EasingCurve, TrackPoint
from tools.animation.exporter import Exporter, RenderSettings
from tools.animation.rigging import Rig, BoneSystem, IK_solver
from tools.animation.nodes import (
    NodeGraph, NodeContext,
    SourceNode, TransformNode, BlurNode, BlendNode,
    ColorCorrectNode, MatteNode, PreCompNode, OutputNode,
)
from tools.animation.ai_pipeline import (
    AIPipeline, CharacterGenerator, CharacterCard,
    PoseMaker, SceneComposer, KeyframeAI, StoryboardAI,
)


# ═══════════════════════════════════════════════════════════════════════
# CLI commands
# ═══════════════════════════════════════════════════════════════════════

def cmd_new(args):
    """Crear un nuevo proyecto de animación."""
    path = Path(args.name)
    path.mkdir(parents=True, exist_ok=True)

    scene = Scene(
        name=args.name,
        width=args.width,
        height=args.height,
        fps=args.fps,
        duration_frames=args.duration,
    )

    # Capa por defecto
    layer = Layer("main", z=0)
    scene.add_layer(layer)

    scene_path = path / "scene.json"
    scene.save(scene_path)

    # Timeline
    timeline = Timeline(duration=args.duration, fps=args.fps)
    timeline_path = path / "timeline.json"
    Path(timeline_path).write_text(
        json.dumps(timeline.to_dict(), indent=2), encoding="utf-8"
    )

    # Node graph
    graph = NodeGraph("comp")
    graph_path = path / "comp.json"
    Path(graph_path).write_text(
        json.dumps(graph.to_dict(), indent=2), encoding="utf-8"
    )

    # Project metadata
    meta = {
        "name": args.name,
        "version": "1.0",
        "width": args.width,
        "height": args.height,
        "fps": args.fps,
        "duration": args.duration,
        "assets": [],
        "characters": [],
    }
    (path / "project.json").write_text(
        json.dumps(meta, indent=2), encoding="utf-8"
    )

    print(f" Proyecto creado: {path}/")
    print(f"   scene.json      — escena principal")
    print(f"   timeline.json   — línea de tiempo")
    print(f"   comp.json       — compositor de nodos")
    print(f"   project.json    — metadatos del proyecto")
    return scene


def cmd_render(args):
    """Renderizar una escena a video/imagen."""
    scene_path = Path(args.scene)
    if not scene_path.exists():
        print(f" Escena no encontrada: {scene_path}")
        sys.exit(1)

    scene = Scene.load(scene_path)
    engine = AnimationEngine(scene)

    # Determinar settings desde argumentos o preset
    if args.preset:
        presets = {
            "hd": RenderSettings.preset_hd,
            "4k": RenderSettings.preset_4k,
            "web": RenderSettings.preset_web,
            "gif": RenderSettings.preset_gif,
            "instagram_post": lambda: RenderSettings.preset_social("instagram_post"),
            "instagram_story": lambda: RenderSettings.preset_social("instagram_story"),
            "tiktok": lambda: RenderSettings.preset_social("tiktok"),
        }
        factory = presets.get(args.preset)
        if factory:
            settings = factory()
        else:
            settings = RenderSettings()
    else:
        settings = RenderSettings(
            width=args.width or scene.width,
            height=args.height or scene.height,
            fps=args.fps or scene.fps,
            format=args.format or "mp4",
            quality=args.quality or "high",
            motion_blur=args.motion_blur,
            bitrate=args.bitrate or "8M",
        )

    if args.output:
        out_path = Path(args.output)
    else:
        out_path = scene_path.parent / f"{scene.name}.{settings.format}"

    print(f" Renderizando {scene.name}...")
    print(f"   {scene.width}x{scene.height} @ {scene.fps}fps  {out_path}")

    exporter = Exporter(engine, settings)
    result = exporter.export(out_path, progress_callback=lambda p: print(f"   {p*100:.0f}%", end="\r"))

    print(f"\n Renderizado: {result}")
    return result


def cmd_rig(args):
    """Crear un rig de huesos para un personaje."""
    rig = Rig(name=args.name)
    print(f"[Rig] Rig creado: {args.name}")

    # Si se pasó un archivo de joints
    if args.joints:
        joints_path = Path(args.joints)
        if joints_path.exists():
            joints_data = json.loads(joints_path.read_text(encoding="utf-8"))
            for bone_data in joints_data.get("bones", []):
                b = Bone.from_dict(bone_data)
                rig.bone_system.add_bone(b)
            print(f"   {len(rig.bone_system.bones)} huesos cargados")

    if args.output:
        out = Path(args.output)
    else:
        out = Path(f"{args.name}_rig.json")
    out.write_text(json.dumps(rig.to_dict(), indent=2), encoding="utf-8")
    print(f"   Guardado: {out}")
    return rig


def cmd_storyboard(args):
    """Generar storyboard desde un guion con IA."""
    script_path = Path(args.script)
    if not script_path.exists():
        print(f" Guion no encontrado: {script_path}")
        sys.exit(1)

    script = script_path.read_text(encoding="utf-8")
    ai = StoryboardAI()
    scenes = ai.parse_script(script)

    print(f"[Storyboard] Storyboard: {len(scenes)} escenas detectadas")
    for i, s in enumerate(scenes):
        print(f"   {i+1}. {s.get('scene', 'Sin nombre')}")
        for a in s.get("actions", []):
            print(f"       {a}")
        for d in s.get("dialogs", []):
            print(f"      [Dialogo] {d}")

    # Guardar
    out_path = Path(args.output or "storyboard.json")
    out_path.write_text(json.dumps(scenes, indent=2), encoding="utf-8")
    print(f"\n Storyboard guardado: {out_path}")
    return scenes


def cmd_pose(args):
    """Generar librería de poses para un personaje."""
    card_path = Path(args.character)
    if not card_path.exists():
        print(f" Character card no encontrada: {card_path}")
        sys.exit(1)

    card_data = json.loads(card_path.read_text(encoding="utf-8"))
    card = CharacterCard.from_dict(card_data)
    maker = PoseMaker(card)

    if args.all:
        poses = maker.generate_all("poses")
        print(f" {len(poses)} poses generadas")
    else:
        print(f"[Storyboard] Poses disponibles: {', '.join(maker.STANDARD_POSES)}")

    return maker


def cmd_export(args):
    """Exportar escena a múltiples formatos."""
    scene_path = Path(args.scene)
    scene = Scene.load(scene_path)
    engine = AnimationEngine(scene)

    fmt = args.format or "mp4"
    settings = RenderSettings(
        width=scene.width, height=scene.height,
        fps=scene.fps, format=fmt,
    )

    out_path = args.output or f"{scene.name}.{fmt}"
    exporter = Exporter(engine, settings)
    result = exporter.export(out_path)
    print(f" Exportado: {result}")
    return result


def cmd_compose(args):
    """Crear composición de nodos."""
    graph = NodeGraph(name=args.name or "comp")

    if args.template == "basic":
        # Template: source  blur  output
        src = SourceNode("src1")
        blur = BlurNode("blur1")
        out = OutputNode("output")

        graph.add_node(src)
        graph.add_node(blur)
        graph.add_node(out)
        graph.connect("src1", "out", "blur1", "in")
        graph.connect("blur1", "out", "output", "in")

        print(" Template 'basic' creado: source  blur  output")

    elif args.template == "composite":
        # Template: source A + source B  blend  color  output
        src_a = SourceNode("src_a")
        src_b = SourceNode("src_b")
        blend = BlendNode("blend1")
        cc = ColorCorrectNode("cc1")
        out = OutputNode("output")

        graph.add_node(src_a)
        graph.add_node(src_b)
        graph.add_node(blend)
        graph.add_node(cc)
        graph.add_node(out)
        graph.connect("src_a", "out", "blend1", "base")
        graph.connect("src_b", "out", "blend1", "blend")
        graph.connect("blend1", "out", "cc1", "in")
        graph.connect("cc1", "out", "output", "in")

        print(" Template 'composite' creado: A+B  blend  color  output")

    out_path = args.output or f"{graph.name}.json"
    Path(out_path).write_text(json.dumps(graph.to_dict(), indent=2), encoding="utf-8")
    print(f"   Guardado: {out_path}")
    return graph


# ═══════════════════════════════════════════════════════════════════════
# API para integración con el agente de LOW
# ═══════════════════════════════════════════════════════════════════════

class AnimationAPI:
    """API simplificada para que el agente IA de LOW use el pipeline."""

    def __init__(self):
        self.current_scene: Optional[Scene] = None
        self.current_engine: Optional[AnimationEngine] = None
        self.current_timeline: Optional[Timeline] = None
        self.current_graph: Optional[NodeGraph] = None
        self.pipeline: Optional[AIPipeline] = None

    def create_project(self, name: str, width=1920, height=1080, fps=24,
                       duration=240) -> Scene:
        """Crea un proyecto nuevo listo para animar."""
        self.current_scene = Scene(name, width, height, fps, duration)
        self.current_engine = AnimationEngine(self.current_scene)
        self.current_timeline = Timeline(duration, fps)
        self.current_graph = NodeGraph("comp")
        return self.current_scene

    def load_project(self, folder: str) -> Scene:
        """Carga un proyecto desde carpeta."""
        p = Path(folder)
        scene = Scene.load(p / "scene.json")
        self.current_scene = scene
        self.current_engine = AnimationEngine(scene)

        tl_path = p / "timeline.json"
        if tl_path.exists():
            self.current_timeline = Timeline.from_dict(
                json.loads(tl_path.read_text(encoding="utf-8"))
            )

        comp_path = p / "comp.json"
        if comp_path.exists():
            self.current_graph = NodeGraph.from_dict(
                json.loads(comp_path.read_text(encoding="utf-8"))
            )

        return scene

    def save_project(self, folder: str):
        """Guarda el proyecto completo."""
        p = Path(folder)
        p.mkdir(parents=True, exist_ok=True)
        if self.current_scene:
            self.current_scene.save(p / "scene.json")
        if self.current_timeline:
            (p / "timeline.json").write_text(
                json.dumps(self.current_timeline.to_dict(), indent=2),
                encoding="utf-8"
            )
        if self.current_graph:
            (p / "comp.json").write_text(
                json.dumps(self.current_graph.to_dict(), indent=2),
                encoding="utf-8"
            )

    def add_actor(self, layer_name: str, actor_name: str,
                  svg_content: str = "",
                  x: float = 0, y: float = 0) -> Actor:
        """Añade un actor a una capa."""
        layer = None
        for l in self.current_scene.layers:
            if l.name == layer_name:
                layer = l
                break
        if not layer:
            layer = Layer(layer_name, z=len(self.current_scene.layers))
            self.current_scene.add_layer(layer)

        actor = Actor(actor_name, svg_id=f"{actor_name}_id")
        actor.svg_source = svg_content
        actor.initial_transform = Transform(x=x, y=y)
        layer.add_actor(actor)
        return actor

    def add_keyframe(self, actor_name: str, frame: int,
                     x=None, y=None, rotation=None,
                     scale_x=None, scale_y=None,
                     opacity=None):
        """Añade keyframe a un actor."""
        actor = self._find_actor(actor_name)
        if not actor:
            print(f" Actor '{actor_name}' no encontrado")
            return

        tr = actor.get_state_at(frame)[0]
        kf = Keyframe(
            frame=frame,
            transform=Transform(
                x=x if x is not None else tr.x,
                y=y if y is not None else tr.y,
                rotation=rotation if rotation is not None else tr.rotation,
                scale_x=scale_x if scale_x is not None else tr.scale_x,
                scale_y=scale_y if scale_y is not None else tr.scale_y,
                opacity=opacity if opacity is not None else tr.opacity,
            )
        )
        actor.add_keyframe(kf)

        # Sincronizar con timeline
        if self.current_timeline and x is not None:
            self.current_timeline.add_keyframe(actor_name, Track.PROP_POSITION_X, frame, x)
        if self.current_timeline and y is not None:
            self.current_timeline.add_keyframe(actor_name, Track.PROP_POSITION_Y, frame, y)

    def render_frame(self, frame: int) -> str:
        """Renderiza un frame a string SVG."""
        if not self.current_engine:
            raise RuntimeError("No hay proyecto cargado")
        return self.current_engine.render_frame_string(frame)

    def export(self, output_path: str, format: str = "mp4",
               preset: str = "hd"):
        """Exporta el proyecto a video/imagen."""
        presets = {
            "hd": RenderSettings.preset_hd,
            "4k": RenderSettings.preset_4k,
            "web": RenderSettings.preset_web,
            "gif": RenderSettings.preset_gif,
        }
        settings = presets.get(preset, RenderSettings.preset_hd)()
        settings.format = format

        exporter = Exporter(self.current_engine, settings)
        result = exporter.export(output_path)
        return result

    def _find_actor(self, name: str) -> Optional[Actor]:
        if not self.current_scene:
            return None
        for layer in self.current_scene.layers:
            for actor in layer.actors:
                if actor.name == name:
                    return actor
        return None

    # ── IA Pipeline ──
    def load_ai_pipeline(self, agent=None):
        """Inicializa el pipeline IA."""
        self.pipeline = AIPipeline(agent)

    def generate_walk_cycle(self, actor_name: str, start_frame: int = 0,
                            duration: int = 24):
        """Genera un ciclo de caminata automático."""
        actor = self._find_actor(actor_name)
        if not actor:
            return
        cycle = 12
        for i in range(0, duration, cycle):
            # Pose A: step
            self.add_keyframe(actor_name, start_frame + i,
                              y=-5, rotation=-5)
            # Pose B: contact
            self.add_keyframe(actor_name, start_frame + i + cycle // 2,
                              y=0, rotation=2)
            # Pose C: step (otra pierna)
            self.add_keyframe(actor_name, start_frame + i + cycle // 4,
                              y=-8, rotation=5)

    def generate_scene_assets(self, description: str):
        """Genera assets visuales con IA (para usar con el agente)."""
        if not self.pipeline:
            self.load_ai_pipeline()
        # Devuelve el prompt para que el agente lo ejecute
        return {
            "background_prompt": f"2D cartoon animation background, vector style, {description}",
            "character_prompt": f"2D cartoon character, vector style, {description}",
        }


# ═══════════════════════════════════════════════════════════════════════
# Main CLI
# ═══════════════════════════════════════════════════════════════════════

def main():
    parser = argparse.ArgumentParser(
        description="LOW Animation Studio — Pipeline de animación 2D profesional",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Ejemplos:
  python low_anim.py new mi_proyecto --width 1920 --height 1080
  python low_anim.py render scene.json --preset hd -o video.mp4
  python low_anim.py rig personaje --joints joints.json -o rig.json
  python low_anim.py storyboard guion.txt -o storyboard.json
  python low_anim.py export scene.json --format lottie -o anim.json
  python low_anim.py compose --template composite -o comp.json
        """
    )

    sub = parser.add_subparsers(dest="command", help="Comando")

    # new
    p_new = sub.add_parser("new", help="Crear nuevo proyecto")
    p_new.add_argument("name", help="Nombre del proyecto")
    p_new.add_argument("--width", type=int, default=1920)
    p_new.add_argument("--height", type=int, default=1080)
    p_new.add_argument("--fps", type=int, default=24)
    p_new.add_argument("--duration", type=int, default=240)

    # render
    p_render = sub.add_parser("render", help="Renderizar escena")
    p_render.add_argument("scene", help="Archivo scene.json")
    p_render.add_argument("-o", "--output")
    p_render.add_argument("--preset", choices=["hd", "4k", "web", "gif",
                                               "instagram_post", "instagram_story", "tiktok"])
    p_render.add_argument("--width", type=int)
    p_render.add_argument("--height", type=int)
    p_render.add_argument("--fps", type=int)
    p_render.add_argument("--format", choices=["mp4", "gif", "png", "webm", "lottie", "smil"])
    p_render.add_argument("--quality", choices=["draft", "medium", "high", "film"])
    p_render.add_argument("--motion-blur", action="store_true", default=True)
    p_render.add_argument("--bitrate")

    # rig
    p_rig = sub.add_parser("rig", help="Crear rig de huesos")
    p_rig.add_argument("name", help="Nombre del personaje")
    p_rig.add_argument("--joints")
    p_rig.add_argument("-o", "--output")

    # storyboard
    p_sb = sub.add_parser("storyboard", help="Generar storyboard desde guion")
    p_sb.add_argument("script", help="Archivo de guion (.txt)")
    p_sb.add_argument("-o", "--output")

    # pose
    p_pose = sub.add_parser("pose", help="Librería de poses")
    p_pose.add_argument("character", help="Character card JSON")
    p_pose.add_argument("--all", action="store_true")

    # export
    p_export = sub.add_parser("export", help="Exportar escena")
    p_export.add_argument("scene", help="Archivo scene.json")
    p_export.add_argument("--format", choices=["mp4", "gif", "png", "webm", "lottie", "smil"], default="mp4")
    p_export.add_argument("-o", "--output")

    # compose
    p_comp = sub.add_parser("compose", help="Crear composición de nodos")
    p_comp.add_argument("--name", default="comp")
    p_comp.add_argument("--template", choices=["basic", "composite"])
    p_comp.add_argument("-o", "--output")

    args = parser.parse_args()

    if args.command == "new":
        cmd_new(args)
    elif args.command == "render":
        cmd_render(args)
    elif args.command == "rig":
        cmd_rig(args)
    elif args.command == "storyboard":
        cmd_storyboard(args)
    elif args.command == "pose":
        cmd_pose(args)
    elif args.command == "export":
        cmd_export(args)
    elif args.command == "compose":
        cmd_compose(args)
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
