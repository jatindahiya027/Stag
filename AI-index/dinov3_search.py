import argparse
import json
import multiprocessing
import os
import sys
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image, ImageOps

MODEL_ID = "jatin027/dinov3-vitl16-pretrain-lvd1689m"
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff"}

def open_rgb_image(path):
    with Image.open(path) as source:
        image = ImageOps.exif_transpose(source)
        if image.mode in ("RGBA", "LA") or (image.mode == "P" and "transparency" in image.info):
            rgba = image.convert("RGBA")
            background = Image.new("RGBA", rgba.size, "white")
            background.alpha_composite(rgba)
            return background.convert("RGB")
        return image.convert("RGB")


def device_name(torch):
    if torch.cuda.is_available():
        return "cuda"
    if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        return "mps"
    return "cpu"


class DinoV3Embedder:
    def __init__(self, model_id=MODEL_ID):
        import torch
        from transformers import AutoImageProcessor, AutoModel

        self.torch = torch
        self.device = device_name(torch)
        local_only = os.path.isdir(model_id)
        self.processor = AutoImageProcessor.from_pretrained(
            model_id,
            backend="torchvision",
            local_files_only=local_only,
        )
        self.model = AutoModel.from_pretrained(model_id, local_files_only=local_only)
        self.model.eval().to(self.device)
        self.model_id = model_id

    def embed(self, paths, batch_size=1):
        vectors = []
        with self.torch.inference_mode():
            for start in range(0, len(paths), batch_size):
                group = paths[start:start + batch_size]
                images = []
                for image_path in group:
                    images.append(open_rgb_image(image_path))
                inputs = self.processor(images=images, return_tensors="pt")
                inputs = {name: value.to(self.device) for name, value in inputs.items()}
                hidden = self.model(**inputs).last_hidden_state.float()
                features = self.torch.nn.functional.normalize(hidden[:, 0, :], dim=1)
                vectors.append(features.cpu().numpy().astype(np.float32))
        return np.ascontiguousarray(np.concatenate(vectors))


def image_paths(folder):
    return sorted(
        path.resolve()
        for path in Path(folder).glob("*")
        if path.is_file() and path.suffix.lower() in IMAGE_EXTENSIONS
    )


def manifest_items(manifest_path):
    raw_items = json.loads(Path(manifest_path).read_text(encoding="utf-8"))
    items = []
    for item in raw_items:
        source_path = Path(str(item.get("source_path") or "")).expanduser().resolve()
        asset_id = str(item.get("asset_id") or "").strip()
        if asset_id and source_path.is_file():
            items.append({
                "asset_id": asset_id,
                "source_path": source_path,
                "source_version": str(item.get("source_version") or ""),
            })
    return items


def folder_items(folder):
    return [{
        "asset_id": path.stem,
        "source_path": path,
        "source_version": str(round(path.stat().st_mtime * 1000)),
    } for path in image_paths(folder)]


def load_existing_metadata(target, model_id=MODEL_ID):
    metadata_path = target / "metadata.json"
    index_path = target / "images.faiss"
    if not metadata_path.is_file() or not index_path.is_file():
        return None
    try:
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        if metadata.get("model_id") != model_id:
            return None
        if not isinstance(metadata.get("asset_ids") or metadata.get("paths"), list):
            return None
        return metadata
    except (OSError, ValueError, TypeError):
        return None


def incremental_plan(items, metadata):
    existing = {}
    if metadata:
        asset_ids = metadata.get("asset_ids") or [
            Path(raw_path).stem for raw_path in (metadata.get("paths") or [])
        ]
        source_versions = metadata.get("source_versions") or metadata.get("mtimes") or []
        for index, asset_id in enumerate(asset_ids):
            if index < len(source_versions):
                existing[str(asset_id)] = (index, str(source_versions[index]))

    pending = []
    rows = []
    for item in items:
        previous = existing.get(item["asset_id"])
        if previous and previous[1] == item["source_version"]:
            rows.append(("existing", previous[0]))
        else:
            rows.append(("new", len(pending)))
            pending.append(item)
    return pending, rows


def write_faiss_index_worker(connection, existing_index, output_index, rows, vectors_file, dimension):
    try:
        import faiss

        old_index = faiss.read_index(existing_index) if existing_index else None
        new_vectors = np.load(vectors_file)
        matrix = np.empty((len(rows), dimension), dtype=np.float32)
        for row_index, (source, source_index) in enumerate(rows):
            matrix[row_index] = (
                old_index.reconstruct(int(source_index))
                if source == "existing"
                else new_vectors[int(source_index)]
            )
        index = faiss.IndexFlatIP(int(dimension))
        index.add(np.ascontiguousarray(matrix))
        faiss.write_index(index, output_index)
        connection.send(("ok", len(rows)))
    except Exception as exc:
        connection.send(("error", str(exc)))
    finally:
        connection.close()


def write_faiss_index(existing_index, output_index, rows, new_vectors, dimension):
    with tempfile.TemporaryDirectory(prefix="stag-dino-") as temp_dir:
        vectors_file = str(Path(temp_dir) / "new-vectors.npy")
        np.save(vectors_file, new_vectors)
        context = multiprocessing.get_context("spawn")
        parent, child = context.Pipe(duplex=False)
        process = context.Process(
            target=write_faiss_index_worker,
            args=(child, existing_index, output_index, rows, vectors_file, dimension),
        )
        process.start()
        child.close()
        try:
            result = parent.recv()
        finally:
            parent.close()
            process.join()
        if process.exitcode != 0:
            raise RuntimeError(f"faiss-index-writer-exited-{process.exitcode}")
        if result[0] != "ok":
            raise RuntimeError(result[1])


def build_index(source, index_dir, batch_size, model_id=MODEL_ID, manifest=False):
    target = Path(index_dir)
    target.mkdir(parents=True, exist_ok=True)

    items = manifest_items(source) if manifest else folder_items(source)
    if not items:
        raise RuntimeError("no-images-to-index")
    metadata = load_existing_metadata(target, model_id)
    pending, rows = incremental_plan(items, metadata)
    vectors = []
    embedder = None
    if pending:
        print(json.dumps({"type": "model_loading"}), flush=True)
        embedder = DinoV3Embedder() if model_id == MODEL_ID else DinoV3Embedder(model_id)
        print(json.dumps({"type": "model_ready", "device": embedder.device}), flush=True)
        for current, item in enumerate(pending, 1):
            image_path = item["source_path"]
            vectors.append(embedder.embed([image_path], batch_size=batch_size))
            print(json.dumps({
                "type": "progress",
                "current": current,
                "total": len(pending),
                "file": f"{item['asset_id']}.jpg",
            }), flush=True)

    if vectors:
        new_vectors = np.ascontiguousarray(np.concatenate(vectors).astype(np.float32))
        dimension = int(new_vectors.shape[1])
    else:
        dimension = int((metadata or {}).get("dimension") or 0)
        if not dimension:
            raise RuntimeError("missing-index-dimension")
        new_vectors = np.empty((0, dimension), dtype=np.float32)

    final_index = target / "images.faiss"
    temporary_index = target / "images.faiss.tmp"
    existing_index = str(final_index) if metadata and final_index.is_file() else None
    write_faiss_index(
        existing_index,
        str(temporary_index),
        rows,
        new_vectors,
        dimension,
    )
    os.replace(temporary_index, final_index)
    (target / "metadata.json").write_text(json.dumps({
        "version": 3,
        "model_id": model_id,
        "dimension": dimension,
        "asset_ids": [item["asset_id"] for item in items],
        "source_versions": [item["source_version"] for item in items],
    }), encoding="utf-8")
    print(json.dumps({
        "type": "done",
        "indexed": len(items),
        "processed": len(pending),
    }), flush=True)


def faiss_search_worker(connection, index_path, vector, top_k):
    try:
        import faiss
        index = faiss.read_index(index_path)
        scores, indices = index.search(vector, top_k)
        connection.send(("ok", scores[0].tolist(), indices[0].tolist()))
    except Exception as exc:
        connection.send(("error", str(exc), []))
    finally:
        connection.close()


def search_faiss(index_path, vector, top_k):
    context = multiprocessing.get_context("spawn")
    parent, child = context.Pipe(duplex=False)
    process = context.Process(
        target=faiss_search_worker,
        args=(child, str(index_path), vector, top_k),
    )
    process.start()
    child.close()
    try:
        status, scores, indices = parent.recv()
    finally:
        parent.close()
        process.join()
    if process.exitcode != 0:
        raise RuntimeError(f"faiss-search-exited-{process.exitcode}")
    if status != "ok":
        raise RuntimeError(scores)
    return scores, indices


def serve(index_dir):
    target = Path(index_dir)
    metadata = json.loads((target / "metadata.json").read_text(encoding="utf-8"))
    embedder = DinoV3Embedder(metadata.get("model_id", MODEL_ID))
    asset_ids = metadata.get("asset_ids") or [
        Path(raw_path).stem for raw_path in (metadata.get("paths") or [])
    ]
    print(json.dumps({
        "type": "ready",
        "device": embedder.device,
        "entries": len(asset_ids),
    }), flush=True)
    for line in sys.stdin:
        request = {}
        try:
            request = json.loads(line)
            query_path = Path(str(request.get("imagePath") or "")).expanduser().resolve()
            if not query_path.is_file():
                raise ValueError("query-image-not-found")
            top_k = max(1, min(int(request.get("topK") or 50), len(asset_ids)))
            vector = embedder.embed([query_path])
            scores, indices = search_faiss(target / "images.faiss", vector, top_k)
            results = []
            for rank, (score, index_value) in enumerate(zip(scores, indices), 1):
                if index_value < 0:
                    continue
                asset_id = asset_ids[int(index_value)]
                results.append({
                    "path": "",
                    "assetId": asset_id,
                    "score": float(score),
                    "rank": rank,
                })
            print(json.dumps({
                "type": "result",
                "id": request.get("id"),
                "results": results,
            }), flush=True)
        except Exception as exc:
            print(json.dumps({
                "type": "result",
                "id": request.get("id") if isinstance(request, dict) else None,
                "error": str(exc),
                "results": [],
            }), flush=True)


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    index_parser = sub.add_parser("index")
    source = index_parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--folder")
    source.add_argument("--manifest")
    index_parser.add_argument("--index", required=True)
    index_parser.add_argument("--batch-size", type=int, default=1)
    index_parser.add_argument("--model", default=MODEL_ID)
    serve_parser = sub.add_parser("serve")
    serve_parser.add_argument("--index", required=True)
    args = parser.parse_args()
    if args.command == "index":
        build_index(args.manifest or args.folder, args.index, args.batch_size, args.model, manifest=bool(args.manifest))
    else:
        serve(args.index)


if __name__ == "__main__":
    main()
