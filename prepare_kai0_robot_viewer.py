"""Create an isolated Kai0 EE viewer static directory for a supplied robot URDF."""
from __future__ import annotations

import argparse
import re
import shutil
from pathlib import Path


DEFAULT_STATIC_DIR = Path(__file__).resolve().parent / "kai0_viewer_base"


def asset_reference(resource: str) -> tuple[Path, Path]:
    resource_path = Path(resource)
    if resource_path.is_absolute() or ".." in resource_path.parts:
        return resource_path, Path("meshes") / resource_path.name
    return resource_path, resource_path


def build_viewer(source_static_dir: Path, urdf_path: Path, output_static_dir: Path, force: bool) -> int:
    if not source_static_dir.is_dir():
        raise FileNotFoundError(f"Kai0 static directory not found: {source_static_dir}")
    if not urdf_path.is_file():
        raise FileNotFoundError(f"URDF not found: {urdf_path}")
    if output_static_dir.exists():
        if not force:
            raise FileExistsError(f"output directory already exists: {output_static_dir}; use --force to replace it")
        shutil.rmtree(output_static_dir)

    shutil.copytree(source_static_dir, output_static_dir, ignore=shutil.ignore_patterns("ee_assets"))
    assets_dir = output_static_dir / "ee_assets"
    assets_dir.mkdir(parents=True, exist_ok=True)
    original_urdf = urdf_path.read_text(encoding="utf-8")
    rewritten_urdf = original_urdf
    copied_assets = 0
    for resource in sorted(set(re.findall(r'filename="([^"]+)"', original_urdf))):
        if resource.startswith("package://"):
            raise ValueError(f"package:// resource is unsupported by this portable viewer builder: {resource}")
        source_relative, output_relative = asset_reference(resource)
        source_path = source_relative if source_relative.is_absolute() else urdf_path.parent / source_relative
        if not source_path.is_file():
            raise FileNotFoundError(f"URDF mesh not found: {source_path}")
        output_path = assets_dir / output_relative
        output_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source_path, output_path)
        rewritten_urdf = rewritten_urdf.replace(resource, output_relative.as_posix())
        copied_assets += 1
    (assets_dir / "robot.urdf").write_text(rewritten_urdf, encoding="utf-8")
    return copied_assets


def main() -> None:
    parser = argparse.ArgumentParser(description="Prepare this standalone Kai0 3D viewer with a matching URDF.")
    parser.add_argument("--urdf", required=True)
    parser.add_argument("--out", required=True, help="New static directory passed to infer_viewer_server.py --static-dir")
    parser.add_argument("--source-static-dir", default=str(DEFAULT_STATIC_DIR))
    parser.add_argument("--force", action="store_true", help="Replace exactly the supplied --out directory")
    args = parser.parse_args()

    copied_assets = build_viewer(
        Path(args.source_static_dir).resolve(),
        Path(args.urdf).resolve(),
        Path(args.out).resolve(),
        args.force,
    )
    print(f"prepared Kai0 viewer: {Path(args.out).resolve()} ({copied_assets} mesh references)")


if __name__ == "__main__":
    main()
