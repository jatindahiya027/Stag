import json
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
import dinov3_search


class FakeEmbedder:
    calls = []
    device = "cpu"
    model_id = dinov3_search.MODEL_ID

    def embed(self, paths, batch_size=1):
        self.calls.extend(Path(path).name for path in paths)
        rows = []
        for path in paths:
            seed = sum(Path(path).name.encode("utf-8"))
            vector = np.array([seed + 1, seed + 2, seed + 3, seed + 4], dtype=np.float32)
            rows.append(vector / np.linalg.norm(vector))
        return np.ascontiguousarray(np.stack(rows))


class DinoIncrementalIndexTests(unittest.TestCase):
    def setUp(self):
        FakeEmbedder.calls = []
        self.original_embedder = dinov3_search.DinoV3Embedder
        dinov3_search.DinoV3Embedder = FakeEmbedder

    def tearDown(self):
        dinov3_search.DinoV3Embedder = self.original_embedder

    def test_second_build_embeds_only_new_image(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            images = root / "images"
            index = root / "index"
            images.mkdir()
            Image.new("RGB", (8, 8), "red").save(images / "one.jpg")
            Image.new("RGB", (8, 8), "blue").save(images / "two.jpg")

            with redirect_stdout(StringIO()):
                dinov3_search.build_index(images, index, 1)
            self.assertEqual(FakeEmbedder.calls, ["one.jpg", "two.jpg"])

            FakeEmbedder.calls = []
            Image.new("RGB", (8, 8), "green").save(images / "three.jpg")
            output = StringIO()
            with redirect_stdout(output):
                dinov3_search.build_index(images, index, 1)

            self.assertEqual(FakeEmbedder.calls, ["three.jpg"])
            events = [json.loads(line) for line in output.getvalue().splitlines()]
            progress = [event for event in events if event["type"] == "progress"]
            self.assertEqual([(event["current"], event["total"]) for event in progress], [(1, 1)])
            self.assertEqual(events[-1]["processed"], 1)
            self.assertEqual(events[-1]["indexed"], 3)

    def test_manifest_metadata_keeps_ids_and_versions_not_source_paths(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            image_path = root / "source.jpg"
            manifest = root / "assets.json"
            index = root / "index"
            Image.new("RGB", (8, 8), "purple").save(image_path)
            manifest.write_text(json.dumps([{
                "asset_id": "asset-123",
                "source_path": str(image_path),
                "source_version": "42:100",
            }]), encoding="utf-8")

            with redirect_stdout(StringIO()):
                dinov3_search.build_index(manifest, index, 1, manifest=True)

            metadata = json.loads((index / "metadata.json").read_text(encoding="utf-8"))
            self.assertEqual(metadata["asset_ids"], ["asset-123"])
            self.assertEqual(metadata["source_versions"], ["42:100"])
            self.assertNotIn("paths", metadata)


if __name__ == "__main__":
    unittest.main()
