import base64
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
PLUGIN = ROOT / "plugins/bundled/oh-my-diff/plugins/omd-artifact-reading"
READER = PLUGIN / "scripts/read_artifact.py"
PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZQAAAABJRU5ErkJggg==")


class ArtifactReadingTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.directory = Path(self.temporary.name)

    def tearDown(self):
        self.temporary.cleanup()

    def read(self, *args):
        return subprocess.run([sys.executable, str(READER), *map(str, args)], capture_output=True, text=True, check=False)

    def test_notebook_cell_and_figure_are_versioned_without_execution(self):
        marker = self.directory / "must-not-exist"
        notebook = self.directory / "sample.ipynb"
        notebook.write_text(json.dumps({"cells": [{"cell_type": "code", "id": "figure-cell", "execution_count": 4, "source": [f"open({str(marker)!r}, 'w').write('bad')"], "outputs": [{"output_type": "display_data", "data": {"image/png": base64.b64encode(PNG).decode(), "text/plain": "a figure"}}]}]}))
        result = self.read("notebook-cell", notebook, 0)
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        self.assertEqual(payload["sha256"], hashlib.sha256(notebook.read_bytes()).hexdigest())
        self.assertEqual(payload["cell"]["id"], "figure-cell")
        self.assertTrue(payload["cell"]["outputs"][0]["image_png"])
        self.assertFalse(marker.exists())
        image = self.directory / "figure.png"
        self.assertEqual(self.read("notebook-image", notebook, 0, image).returncode, 0)
        self.assertEqual(image.read_bytes(), PNG)
        self.assertNotEqual(self.read("notebook-image", notebook, 0, image).returncode, 0)

    def test_notebook_image_accepts_wrapped_base64_and_malformed_notebooks_fail_cleanly(self):
        encoded = base64.encodebytes(PNG).decode()
        notebook = self.directory / "wrapped.ipynb"
        notebook.write_text(json.dumps({"cells": [{"cell_type": "code", "outputs": [{"output_type": "display_data", "data": {"image/png": encoded}}]}]}))
        image = self.directory / "wrapped.png"
        result = self.read("notebook-image", notebook, 0, image)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(image.read_bytes(), PNG)
        notebook.write_text(json.dumps({"cells": [{"cell_type": "code", "outputs": [{"output_type": "display_data", "data": {"image/png": [1, 2]}}]}]}))
        notebook.with_name("list.ipynb").write_text("[]")
        for name in ("wrapped.ipynb", "list.ipynb"):
            result = self.read("notebook-image", self.directory / name, 0, self.directory / f"{name}.png")
            self.assertEqual(result.returncode, 2)
            self.assertIn("error", json.loads(result.stderr))

    @unittest.skipUnless(shutil.which("gs"), "Ghostscript is not installed")
    def test_pdf_page_text_and_figure_keep_page_and_digest(self):
        postscript = self.directory / "sample.ps"
        postscript.write_text("%!PS\n/Helvetica findfont 16 scalefont setfont\n72 720 moveto (First page anchor) show\nshowpage\n72 720 moveto (Second page anchor) show\nshowpage\n")
        pdf = self.directory / "sample.pdf"
        generated = subprocess.run(["gs", "-q", "-dSAFER", "-dBATCH", "-dNOPAUSE", "-sDEVICE=pdfwrite", f"-sOutputFile={pdf}", str(postscript)], capture_output=True, check=False)
        self.assertEqual(generated.returncode, 0, generated.stderr)
        result = self.read("pdf-page", pdf, 2)
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        self.assertEqual(payload["page"], 2)
        self.assertEqual(payload["sha256"], hashlib.sha256(pdf.read_bytes()).hexdigest())
        self.assertIn("Second page anchor", payload["text"])
        self.assertNotIn("First page anchor", payload["text"])
        image = self.directory / "page.png"
        self.assertEqual(self.read("pdf-figure", pdf, 2, image).returncode, 0)
        self.assertTrue(image.read_bytes().startswith(b"\x89PNG\r\n\x1a\n"))


if __name__ == "__main__":
    unittest.main()
