import json
import sys
import tempfile
import unittest
from argparse import Namespace
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path
from unittest.mock import patch

import torch
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
import tipsv2_search


class TipsManifestIndexTests(unittest.TestCase):
    def test_manifest_index_persists_identity_without_source_path(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            image_path = root / "source.jpg"
            manifest_path = root / "assets.json"
            index_path = root / "tips.pt"
            Image.new("RGB", (8, 8), "orange").save(image_path)
            manifest_path.write_text(json.dumps([{
                "asset_id": "asset-456",
                "source_path": str(image_path),
                "source_version": "84:200",
            }]), encoding="utf-8")
            args = Namespace(
                index=str(index_path),
                info=False,
                clean=False,
                manifest=str(manifest_path),
                folder=None,
                recursive=False,
                model="test-model",
                json_progress=True,
                batch_size=1,
            )

            with patch.object(tipsv2_search, "load_model", return_value=object()), \
                    patch.object(tipsv2_search, "encode_batch", return_value=[torch.ones(4)]), \
                    redirect_stdout(StringIO()):
                tipsv2_search.cmd_index(args)

            index = torch.load(index_path, map_location="cpu", weights_only=False)
            entry = index["entries"]["asset-456"]
            self.assertEqual(entry["asset_id"], "asset-456")
            self.assertEqual(entry["source_version"], "84:200")
            self.assertNotIn("path", entry)

            manifest_path.write_text("[]", encoding="utf-8")
            with redirect_stdout(StringIO()):
                tipsv2_search.cmd_index(args)
            empty_index = torch.load(index_path, map_location="cpu", weights_only=False)
            self.assertEqual(empty_index["entries"], {})


if __name__ == "__main__":
    unittest.main()
