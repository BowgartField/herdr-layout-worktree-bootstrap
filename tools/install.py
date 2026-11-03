#!/usr/bin/env python3
"""Install personal copies without overwriting shipped or independently edited files."""
import argparse
import hashlib
import json
import os
import tempfile
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
NAMES = {"worktree": "worktree-bootstrap", "spaces": "bootstrap-spaces",
         "menu": "bootstrap-menu", "new-menu": "bootstrap-new-menu", "tabs": "bootstrap-tabs",
         "workspace-chrome": "bootstrap-chrome", "pane": "bootstrap-pane"}


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_atomic(path, contents, mode=0o644):
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, name = tempfile.mkstemp(prefix=".bootstrap-install-", dir=path.parent)
    temporary = Path(name)
    try:
        with os.fdopen(descriptor, "wb") as file:
            file.write(contents)
            file.flush()
            os.fsync(file.fileno())
        temporary.chmod(mode)
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()


def make_layout(source):
    tree = json.loads(json.dumps(source))
    changed = False
    def visit(node):
        nonlocal changed
        content = node.get("content", {})
        if content.get("mod") in NAMES:
            content["mod"] = NAMES[content["mod"]]
        header = content.get("pane", {}).get("header", {}).get("content", {})
        if header.get("mod") in NAMES:
            header["mod"] = NAMES[header["mod"]]
        for i, child in enumerate(node.get("children", [])):
            visit(child)
            if child.get("content", {}).get("tab") == "active" and not changed:
                # Preserve the original terminal's ID and pane look inside a scoped stack.
                terminal = child
                terminal["id"] = "main"
                node["children"][i] = {"id": "bootstrap-content", "type": "stack", "active": "main", "children": [
                    terminal,
                    {"id": "bootstrap-setup", "type": "block", "content": {"mod": "worktree-bootstrap-setup"}},
                ]}
                changed = True
    visit(tree)
    if not changed:
        raise ValueError("The source layout needs a block showing the active tab")
    tree["terminal_menu"] = "bootstrap-menu"
    tree["cloned_from"] = {"name": "main", "version": "0.1.12"}
    return tree


def install(app_home, *, layout_name="worktree-bootstrap", source_layout="main", check=True):
    app_home = Path(app_home).expanduser().resolve()
    manifest = app_home / "data/worktree-bootstrap/install.json"
    old = json.loads(manifest.read_text()) if manifest.exists() else {}
    owned = old.get("files", {})
    files = []
    for folder in (ROOT / "mods").iterdir():
        if not folder.is_dir():
            continue
        for source in folder.iterdir():
            if source.suffix in {".js", ".svg"} or source.name == "mod.json":
                files.append((source, app_home / "mods" / folder.name / source.name))
    for source in (ROOT / "runtime").rglob("*"):
        if source.is_file() and "__pycache__" not in source.parts:
            files.append((source, app_home / "data/worktree-bootstrap/runtime" / source.relative_to(ROOT / "runtime")))
    layout_file = app_home / "layouts" / (layout_name + ".json")
    for _, target in files:
        key = str(target.relative_to(app_home))
        if target.exists() and (key not in owned or digest(target) != owned[key]):
            raise ValueError(f"Refusing to overwrite an existing or independently edited file: {target}")
    layout_key = str(layout_file.relative_to(app_home))
    if layout_file.exists() and (layout_key not in owned or digest(layout_file) != owned[layout_key]):
        raise ValueError(f"Refusing to replace a personal layout: {layout_file}")
    tree = make_layout(json.loads((app_home / "layouts" / (source_layout + ".json")).read_text()))
    for source, target in files:
        target.parent.mkdir(parents=True, exist_ok=True)
        write_atomic(target, source.read_bytes(), source.stat().st_mode & 0o777)
    layout_file.parent.mkdir(parents=True, exist_ok=True)
    write_atomic(layout_file, (json.dumps(tree, indent=2) + "\n").encode())
    owned = {str(target.relative_to(app_home)): digest(target) for _, target in files}
    owned[layout_key] = digest(layout_file)
    manifest.parent.mkdir(parents=True, exist_ok=True)
    write_atomic(manifest, (json.dumps({"source": str(ROOT), "layout": layout_name, "files": owned}, indent=2) + "\n").encode())
    if check:
        for folder in sorted(path for path in (ROOT / "mods").iterdir() if path.is_dir()):
            subprocess.run(["herdr-app", "check", str(app_home / "mods" / folder.name)], check=True)
    return layout_name


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app-home", default=str(Path.home()/".config/herdr-app"))
    parser.add_argument("--source-layout", default="main")
    parser.add_argument("--layout-name", default="worktree-bootstrap")
    parser.add_argument("--activate", action="store_true")
    parser.add_argument("--runtime-only", type=Path)
    args = parser.parse_args()
    if args.runtime_only:
        # For SSH hosts: install to ~/.local/share/herdr-mod-worktree-bootstrap/runtime.
        if args.runtime_only.exists():
            parser.error("The runtime destination exists; choose a fresh versioned destination")
        shutil.copytree(ROOT / "runtime", args.runtime_only, ignore=shutil.ignore_patterns("__pycache__"))
        print(args.runtime_only)
        return
    try:
        name = install(args.app_home, layout_name=args.layout_name, source_layout=args.source_layout)
        if args.activate:
            subprocess.run(["herdr-app", "do", "layout.switch", json.dumps({"name": name})], check=True)
        print(f"Installed {name}. Switch with: herdr-app do layout.switch '{{\"name\":\"{name}\"}}'")
    except (ValueError, subprocess.CalledProcessError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
