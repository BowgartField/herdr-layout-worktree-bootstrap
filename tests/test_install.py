import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("install_mod", ROOT / "tools/install.py")
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class InstallTests(unittest.TestCase):
    def test_preserves_terminal_geometry_and_other_layout_panels(self):
        source = {"id": "root", "type": "row", "children": [
            {"id": "sidebar", "type": "block", "content": {"mod": "spaces"}},
            {"id": "work", "type": "column", "children": [
                {"id": "tabs", "type": "block", "content": {"mod": "tabs"}},
                {"id": "main", "type": "block", "content": {"tab": "active", "pane": {"gap": 13}}},
                {"id": "files", "type": "block", "content": {"mod": "files"}},
            ]},
        ]}
        tree = installer.make_layout(source)
        self.assertEqual(source["children"][0]["content"]["mod"], "spaces")
        self.assertEqual(tree["children"][0]["content"]["mod"], "bootstrap-spaces")
        stack = tree["children"][1]["children"][1]
        self.assertEqual(stack["id"], "bootstrap-content")
        self.assertEqual(stack["children"][0]["content"]["pane"]["gap"], 13)
        self.assertEqual(tree["children"][1]["children"][2], source["children"][1]["children"][2])

    def test_install_keeps_shipped_files_and_refuses_independent_edits(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp)
            (home/"layouts").mkdir()
            main = home/"layouts/main.json"
            main.write_text(json.dumps({"type": "row", "children": [{"id": "main", "content": {"tab": "active"}}]}))
            original = main.read_bytes()
            installer.install(home, check=False)
            self.assertEqual(main.read_bytes(), original)
            installer.install(home, check=False)
            personal = home/"mods/worktree-bootstrap/main.js"
            personal.write_text(personal.read_text()+"\n// personal edit\n")
            with self.assertRaisesRegex(ValueError, "independently edited"):
                installer.install(home, check=False)
            self.assertTrue(personal.read_text().endswith("// personal edit\n"))

    def test_unrelated_personal_name_collision_is_never_overwritten(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp)
            (home/"mods/worktree-bootstrap").mkdir(parents=True)
            personal=home/"mods/worktree-bootstrap/main.js"
            personal.write_text("personal")
            with self.assertRaisesRegex(ValueError, "existing"):
                installer.install(home, check=False)
            self.assertEqual(personal.read_text(), "personal")
