"""
TIPSv2 Image Search — Two-command workflow
==========================================

1. INDEX  — scan a folder, encode images, save to an index file
2. SEARCH — load the index, search with a text query

Install:
    pip install transformers torch torchvision sentencepiece Pillow tqdm huggingface_hub

── Indexing ────────────────────────────────────────────────────────────────────

    # First time — index your whole photo folder
    python tipsv2_search.py index --folder ~/photos --index my_index.pt

    # Later — add a new folder (or the same folder with new images added)
    python tipsv2_search.py index --folder ~/photos/new_batch --index my_index.pt

    # Recurse into sub-folders
    python tipsv2_search.py index --folder ~/photos --index my_index.pt --recursive

    # See what's in an existing index
    python tipsv2_search.py index --info --index my_index.pt

    # Remove entries for images that have been deleted from disk
    python tipsv2_search.py index --clean --index my_index.pt

── Searching ───────────────────────────────────────────────────────────────────

    python tipsv2_search.py search --query "a dog playing" --index my_index.pt
    python tipsv2_search.py search --query "sunset over water" --index my_index.pt --top-k 10

── Local model example ─────────────────────────────────────────────────────────

    python tipsv2_search.py index --manifest /tmp/stag-assets.json \
      --index my_index.pt --model /path/to/tipsv2-l14 --json-progress

── Notes ───────────────────────────────────────────────────────────────────────

  * The index stores: absolute path, asset id, content hash, and embedding.
  * Re-indexing is incremental: already-indexed images are skipped.
  * Moving/renaming a file does NOT cause re-encoding if the staged asset id and
    file content are unchanged.
  * Use --clean to prune entries whose files have been deleted from disk.
"""

import argparse
import hashlib
import json
import sys
import time
from pathlib import Path
from typing import Any

import torch
import torch.nn.functional as F
from PIL import Image, ImageOps
from torchvision import transforms
from transformers import AutoModel
from tqdm import tqdm


# ── Config ────────────────────────────────────────────────────────────────────

SUPPORTED_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tiff", ".tif"}
IMAGE_SIZE = 448
DEFAULT_MODEL = "google/tipsv2-l14"
DEFAULT_INDEX = "tipsv2_index.pt"

transform = transforms.Compose([
    transforms.Resize((IMAGE_SIZE, IMAGE_SIZE)),
    transforms.ToTensor(),   # [0,1] range — TIPSv2 requires NO ImageNet normalisation
])

def open_rgb_image(path: Path) -> Image.Image:
    with Image.open(path) as source:
        image = ImageOps.exif_transpose(source)
        if image.mode in ("RGBA", "LA") or (image.mode == "P" and "transparency" in image.info):
            rgba = image.convert("RGBA")
            background = Image.new("RGBA", rgba.size, "white")
            background.alpha_composite(rgba)
            return background.convert("RGB")
        return image.convert("RGB")


# ── Device ────────────────────────────────────────────────────────────────────

def get_device() -> torch.device:
    if torch.cuda.is_available():
        return torch.device("cuda")
    if torch.backends.mps.is_available():
        return torch.device("mps")
    return torch.device("cpu")


def empty_device_cache(device: torch.device) -> None:
    if device.type == "cuda":
        torch.cuda.empty_cache()
    elif device.type == "mps":
        try:
            torch.mps.empty_cache()
        except Exception:
            pass


# ── Index file schema ─────────────────────────────────────────────────────────
#
#  The index is a plain dict saved with torch.save:
#
#  {
#    "model":   "google/tipsv2-l14" or "/local/path/to/tipsv2-l14",
#    "dim":     1024,
#    "entries": {
#      "<asset_id>:<md5_of_file_contents>": {
#        "path": "/absolute/path/to/image.jpg",
#        "hash": "<asset_id>:<md5_of_file_contents>",
#        "asset_id": "<asset_id>",
#        "emb":  Tensor(D,),          # float32, L2-normalised
#      },
#      ...
#    }
#  }

def load_index(index_path: str) -> dict[str, Any]:
    p = Path(index_path)
    if p.exists():
        try:
            if p.stat().st_size <= 0:
                raise EOFError("index file is empty")

            idx = torch.load(p, map_location="cpu", weights_only=False)
            if not isinstance(idx, dict) or not isinstance(idx.get("entries"), dict):
                raise ValueError("index file has an invalid schema")

            print(f"[index] loaded  {len(idx['entries'])} image(s)  ({index_path})")
            return idx

        except Exception as exc:
            backup = p.with_suffix(p.suffix + f".corrupt-{int(time.time())}")
            try:
                p.replace(backup)
                print(f"[index] ignored corrupt index ({exc}); moved to {backup}", file=sys.stderr)
            except Exception:
                try:
                    p.unlink()
                    print(f"[index] deleted corrupt index ({exc})", file=sys.stderr)
                except Exception:
                    print(f"[index] ignored corrupt index ({exc}); rebuilding in memory", file=sys.stderr)

    return {"model": None, "dim": None, "entries": {}}


def save_index(idx: dict[str, Any], index_path: str) -> None:
    torch.save(idx, index_path)
    print(f"[index] saved   {len(idx['entries'])} image(s)  ({index_path})")


# ── File utilities ────────────────────────────────────────────────────────────

def content_hash(path: Path) -> str:
    """MD5 of file bytes — detects real content changes regardless of path."""
    h = hashlib.md5()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def collect_images(folder: Path, recursive: bool) -> list[Path]:
    glob = folder.rglob("*") if recursive else folder.glob("*")
    return sorted(
        p for p in glob
        if p.is_file() and p.suffix.lower() in SUPPORTED_EXTENSIONS
    )


def is_local_model_dir(model_id: str) -> bool:
    try:
        return Path(model_id).expanduser().is_dir()
    except Exception:
        return False


# ── Local Hugging Face model patch ────────────────────────────────────────────

def patch_hf_hub_download_for_local_model(local_model_dir: Path) -> None:
    """
    TIPSv2 custom code may call:

        hf_hub_download(repo_id, "image_encoder.py")
        hf_hub_download(repo_id, "text_encoder.py")

    even when repo_id is an absolute local path.

    huggingface_hub validates repo_id before downloading, so absolute paths like:

        /Users/jatin/.../ai-models/tipsv2-l14

    raise:

        HFValidationError: Repo id must be in the form 'repo_name' or 'namespace/repo_name'

    This patch intercepts those calls and returns files from the local model
    folder whenever the requested file exists locally.
    """
    import huggingface_hub
    import huggingface_hub.file_download

    local_model_dir = local_model_dir.expanduser().resolve()

    # Avoid stacking multiple wrappers if load_model is called more than once.
    current = huggingface_hub.hf_hub_download
    original = getattr(current, "_stag_original_hf_hub_download", current)

    def local_aware_hf_hub_download(repo_id, filename=None, *args, **kwargs):
        requested_filename = filename or kwargs.get("filename")

        if requested_filename:
            # Case 1: repo_id itself is a local folder.
            try:
                repo_path = Path(str(repo_id)).expanduser()
                if repo_path.is_dir():
                    candidate = repo_path / requested_filename
                    if candidate.exists():
                        return str(candidate.resolve())
            except Exception:
                pass

            # Case 2: repo_id is not usable, but the requested file exists in
            # the bundled TIPSv2 folder.
            candidate = local_model_dir / requested_filename
            if candidate.exists():
                return str(candidate.resolve())

        return original(repo_id, filename, *args, **kwargs)

    local_aware_hf_hub_download._stag_original_hf_hub_download = original  # type: ignore[attr-defined]

    # Patch common access paths.
    huggingface_hub.hf_hub_download = local_aware_hf_hub_download
    huggingface_hub.file_download.hf_hub_download = local_aware_hf_hub_download

    # Patch modules that already imported:
    #     from huggingface_hub import hf_hub_download
    #
    # Important: do NOT use hasattr(module, "hf_hub_download") here.
    # Transformers uses lazy modules, and hasattr() triggers noisy warnings like:
    #   [transformers] Accessing `hf_hub_download` from `.models...`
    #
    # Checking module.__dict__ only inspects real already-loaded attributes and
    # does not trigger Transformers lazy imports/warnings.
    for module in list(sys.modules.values()):
        if module is None:
            continue

        module_dict = getattr(module, "__dict__", None)
        if not module_dict or "hf_hub_download" not in module_dict:
            continue

        try:
            module_dict["hf_hub_download"] = local_aware_hf_hub_download
        except Exception:
            pass


def assert_local_model_has_required_files(local_model_dir: Path) -> None:
    """
    Fail early with a useful error if the bundled model directory is incomplete.
    """
    required_any_weight = [
        "model.safetensors",
        "pytorch_model.bin",
    ]
    required_files = [
        "config.json",
        "modeling_tips.py",
        "image_encoder.py",
        "text_encoder.py",
    ]

    missing = [name for name in required_files if not (local_model_dir / name).exists()]
    has_weight = any((local_model_dir / name).exists() for name in required_any_weight)

    if not has_weight:
        missing.append("model.safetensors or pytorch_model.bin")

    if missing:
        raise FileNotFoundError(
            "Local TIPSv2 model folder is incomplete:\n"
            f"  {local_model_dir}\n"
            "Missing:\n"
            + "\n".join(f"  - {name}" for name in missing)
        )


def load_model(model_id: str, device: torch.device, text_only: bool = False):
    """
    Load TIPSv2.

    text_only=True  → drop the vision encoder immediately after loading.
                      Search only needs encode_text, so there's no reason
                      to keep the vision params in memory.
    """
    print(f"[model] loading {'text encoder only' if text_only else 'full model'} …", flush=True)
    t0 = time.time()

    model_path = Path(model_id).expanduser()
    from_pretrained_kwargs: dict[str, Any] = {
        "trust_remote_code": True,
    }

    if model_path.is_dir():
        model_path = model_path.resolve()
        assert_local_model_has_required_files(model_path)
        patch_hf_hub_download_for_local_model(model_path)

        model_id = str(model_path)
        from_pretrained_kwargs["local_files_only"] = True

        print(f"[model] using local model directory: {model_id}", flush=True)

    model = AutoModel.from_pretrained(model_id, **from_pretrained_kwargs)

    if text_only:
        # Delete the vision encoder and free its memory.
        # TIPSv2 commonly stores it as model.vision_model plus projection.
        for attr in ("vision_model", "visual_projection"):
            if hasattr(model, attr):
                delattr(model, attr)

        import gc
        gc.collect()
        empty_device_cache(device)

    model.eval().to(device)
    print(f"[model] ready  ({time.time() - t0:.1f}s)")
    return model


# ── Encoding ──────────────────────────────────────────────────────────────────

@torch.no_grad()
def encode_batch(
    paths: list[Path],
    model,
    device: torch.device,
) -> list[torch.Tensor | None]:
    """Encode one batch of paths. Returns a list of (D,) tensors or None on error."""
    tensors: list[torch.Tensor] = []
    valid_flags: list[bool] = []

    for p in paths:
        try:
            img = open_rgb_image(p)
            tensors.append(transform(img).unsqueeze(0))
            valid_flags.append(True)
        except Exception as e:
            print(f"  [warn] skipping {p.name}: {e}", file=sys.stderr)
            valid_flags.append(False)

    if not any(valid_flags):
        return [None] * len(paths)

    pixel_values = torch.cat([t for t, v in zip(tensors, valid_flags) if v]).to(device)
    out = model.encode_image(pixel_values)
    cls = F.normalize(out.cls_token[:, 0, :].float(), dim=-1).cpu()  # (B, D)

    result: list[torch.Tensor | None] = []
    ei = 0

    for v in valid_flags:
        result.append(cls[ei] if v else None)
        if v:
            ei += 1

    return result


# ── INDEX command ─────────────────────────────────────────────────────────────

def load_manifest(manifest_path: str) -> list[dict[str, Any]]:
    raw_items = json.loads(Path(manifest_path).read_text(encoding="utf-8"))
    items: list[dict[str, Any]] = []
    for raw in raw_items:
        asset_id = str(raw.get("asset_id") or "").strip()
        source_path = Path(str(raw.get("source_path") or "")).expanduser().resolve()
        if asset_id and source_path.is_file():
            items.append({
                "asset_id": asset_id,
                "source_path": source_path,
                "source_version": str(raw.get("source_version") or ""),
            })
    return items


def cmd_index_manifest(args, idx: dict[str, Any]) -> None:
    items = load_manifest(args.manifest)
    model_id = args.model or idx.get("model") or DEFAULT_MODEL
    if idx.get("model") and idx.get("model") != model_id and idx["entries"]:
        idx = {"model": None, "dim": None, "entries": {}}

    existing_by_id = {
        str(entry.get("asset_id") or Path(entry.get("path", "")).stem): entry
        for entry in idx["entries"].values()
    }
    active_ids = {item["asset_id"] for item in items}
    entries = {
        asset_id: entry
        for asset_id, entry in existing_by_id.items()
        if asset_id in active_ids
    }
    to_encode = [
        item for item in items
        if item["asset_id"] not in entries
        or str(entries[item["asset_id"]].get("source_version") or "") != item["source_version"]
    ]
    for item in to_encode:
        entries.pop(item["asset_id"], None)

    if args.json_progress:
        print(json.dumps({
            "type": "scan",
            "total": len(items),
            "already": len(items) - len(to_encode),
            "toEncode": len(to_encode),
        }), flush=True)

    if to_encode:
        device = get_device()
        if args.json_progress:
            print(json.dumps({"type": "model_loading"}), flush=True)
        model = load_model(model_id, device)
        if args.json_progress:
            print(json.dumps({"type": "model_ready"}), flush=True)

        failed_files: list[str] = []
        processed = 0
        batch_size = max(1, int(args.batch_size))
        for start in range(0, len(to_encode), batch_size):
            batch = to_encode[start:start + batch_size]
            embeddings = encode_batch([item["source_path"] for item in batch], model, device)
            for item, embedding in zip(batch, embeddings):
                processed += 1
                file_name = f"{item['asset_id']}.jpg"
                if embedding is not None:
                    entries[item["asset_id"]] = {
                        "asset_id": item["asset_id"],
                        "source_version": item["source_version"],
                        "emb": embedding,
                    }
                    idx["entries"] = entries
                    idx["model"] = model_id
                    idx["dim"] = embedding.shape[0]
                    save_index(idx, args.index)
                    embedded = True
                else:
                    failed_files.append(file_name)
                    embedded = False
                if args.json_progress:
                    print(json.dumps({
                        "type": "progress",
                        "current": processed,
                        "total": len(to_encode),
                        "file": file_name,
                        "embedded": embedded,
                    }), flush=True)
    else:
        failed_files = []

    idx["entries"] = entries
    idx["model"] = model_id
    if entries and not idx.get("dim"):
        idx["dim"] = next(iter(entries.values()))["emb"].shape[0]
    save_index(idx, args.index)
    if args.json_progress:
        print(json.dumps({
            "type": "done",
            "indexed": len(to_encode) - len(failed_files),
            "skipped": len(failed_files),
            "totalInIndex": len(entries),
            "failedFiles": failed_files,
        }), flush=True)


def cmd_index(args) -> None:
    idx = load_index(args.index)

    # --info: describe the index and exit
    if args.info:
        print(f"\nIndex file : {args.index}")
        print(f"Model      : {idx.get('model', 'unknown')}")
        print(f"Dimension  : {idx.get('dim', 'unknown')}")
        print(f"Images     : {len(idx['entries'])}\n")

        if idx["entries"]:
            print(f"{'Status':<10} Path")
            print("─" * 80)
            for e in idx["entries"].values():
                stored_path = e.get("path")
                status = "OK" if not stored_path or Path(stored_path).exists() else "MISSING"
                print(f"{status:<10} {stored_path or e.get('asset_id', '')}")
        return

    # --clean: remove entries for files that no longer exist
    if args.clean:
        before = len(idx["entries"])
        idx["entries"] = {
            h: e for h, e in idx["entries"].items()
            if not e.get("path") or Path(e["path"]).exists()
        }
        removed = before - len(idx["entries"])
        print(f"[clean] removed {removed} missing entries")
        save_index(idx, args.index)
        return

    if args.manifest:
        cmd_index_manifest(args, idx)
        return

    # Normal indexing — need --folder
    if not args.folder:
        print("[error] --folder is required unless using --info or --clean", file=sys.stderr)
        sys.exit(1)

    folder = Path(args.folder).expanduser().resolve()
    if not folder.is_dir():
        print(f"[error] not a directory: {folder}", file=sys.stderr)
        sys.exit(1)

    all_paths = collect_images(folder, args.recursive)
    print(f"[scan]  found {len(all_paths)} image(s) in {folder}")

    if not all_paths:
        print("[index] nothing to do.")
        return

    # Prefer the CLI/app model over the stored index model.
    # This prevents an old index from forcing a stale/bad local path forever.
    model_id = args.model or idx.get("model") or DEFAULT_MODEL

    # If the stored model is different from the current model, do not reuse old
    # embeddings. Different models can have incompatible embedding spaces.
    stored_model = idx.get("model")
    if stored_model and stored_model != model_id and idx["entries"]:
        print(f"[index] model changed:")
        print(f"        old: {stored_model}")
        print(f"        new: {model_id}")
        print("[index] rebuilding entries for the selected model")
        idx = {"model": None, "dim": None, "entries": {}}

    # Stag stages every searchable item as <asset_id>.jpg. Keep one entry per
    # asset id so identical thumbnails or duplicate files still return the
    # correct original asset, rather than collapsing by image bytes alone.
    current_asset_ids = {p.stem for p in all_paths}
    idx["entries"] = {
        h: e for h, e in idx["entries"].items()
        if (e.get("asset_id") or Path(e.get("path", "")).stem) not in current_asset_ids
    }

    # Decide what needs encoding.
    to_encode: list[tuple[Path, str]] = []

    for p in all_paths:
        h = f"{p.stem}:{content_hash(p)}"

        if h in idx["entries"]:
            idx["entries"][h]["path"] = str(p)   # update path if file moved
            idx["entries"][h]["asset_id"] = p.stem
        else:
            to_encode.append((p, h))

    already = len(all_paths) - len(to_encode)
    print(f"[index] {already} already indexed, {len(to_encode)} new/changed")

    if args.json_progress:
        print(json.dumps({
            "type": "scan",
            "total": len(all_paths),
            "already": already,
            "toEncode": len(to_encode),
        }), flush=True)

    if not to_encode:
        idx["model"] = model_id

        if args.json_progress:
            print(json.dumps({
                "type": "done",
                "indexed": 0,
                "skipped": 0,
                "totalInIndex": len(idx["entries"]),
                "failedFiles": [],
            }), flush=True)

        save_index(idx, args.index)
        return

    device = get_device()
    print(f"[device] {device}")

    if args.json_progress:
        print(json.dumps({"type": "model_loading"}), flush=True)

    model = load_model(model_id, device)

    if args.json_progress:
        print(json.dumps({"type": "model_ready"}), flush=True)

    encoded = 0
    skipped = 0
    total = len(to_encode)
    batch_size = max(1, int(args.batch_size))
    failed_files: list[str] = []

    if args.json_progress:
        for start in range(0, total, batch_size):
            batch = to_encode[start: start + batch_size]
            paths_b, hashes_b = zip(*batch)

            embs = encode_batch(list(paths_b), model, device)

            for p, h, emb in zip(paths_b, hashes_b, embs):
                if emb is not None:
                    idx["entries"][h] = {
                        "path": str(p),
                        "hash": h,
                        "asset_id": p.stem,
                        "emb": emb,
                    }
                    encoded += 1

                    # Save after each successful image so Electron can recover
                    # progress if the process exits/crashes.
                    idx["model"] = model_id
                    if idx["entries"]:
                        idx["dim"] = next(iter(idx["entries"].values()))["emb"].shape[0]
                    save_index(idx, args.index)

                    embedded = True
                else:
                    skipped += 1
                    failed_files.append(p.name)
                    embedded = False

                print(json.dumps({
                    "type": "progress",
                    "current": encoded + skipped,
                    "total": total,
                    "file": p.name,
                    "embedded": embedded,
                }), flush=True)

    else:
        with tqdm(total=total, unit="img", desc="Indexing", dynamic_ncols=True) as pbar:
            for start in range(0, total, batch_size):
                batch = to_encode[start: start + batch_size]
                paths_b, hashes_b = zip(*batch)

                embs = encode_batch(list(paths_b), model, device)

                for p, h, emb in zip(paths_b, hashes_b, embs):
                    if emb is not None:
                        idx["entries"][h] = {
                            "path": str(p),
                            "hash": h,
                            "asset_id": p.stem,
                            "emb": emb,
                        }
                        encoded += 1
                    else:
                        skipped += 1
                        failed_files.append(p.name)

                    pbar.update(1)
                    pbar.set_postfix(file=p.name[:28], ok=encoded, skip=skipped)

    print(f"[index] {encoded} new image(s) encoded")

    idx["model"] = model_id

    if idx["entries"]:
        idx["dim"] = next(iter(idx["entries"].values()))["emb"].shape[0]

    if args.json_progress:
        print(json.dumps({
            "type": "done",
            "indexed": encoded,
            "skipped": skipped,
            "totalInIndex": len(idx["entries"]),
            "failedFiles": failed_files,
        }), flush=True)

    save_index(idx, args.index)


# ── SEARCH command ────────────────────────────────────────────────────────────

@torch.no_grad()
def search_entries(query, top_k, entries, emb_matrix, model, device):
    txt_emb = model.encode_text([query])
    txt_emb = F.normalize(txt_emb.float().to(device), dim=-1)  # (1, D)

    sims = (emb_matrix.to(device) @ txt_emb.T).squeeze(1).float().cpu()  # (N,)

    top_k = min(top_k, len(entries))
    top_idx = sims.argsort(descending=True)[:top_k].tolist()

    return [
        {
            "path": entries[i].get("path", ""),
            "assetId": entries[i].get("asset_id") or Path(entries[i].get("path", "")).stem,
            "score": float(sims[i]),
            "rank": rank,
        }
        for rank, i in enumerate(top_idx, 1)
    ]


@torch.no_grad()
def cmd_search(args) -> None:
    idx = load_index(args.index)

    if not idx["entries"]:
        print("[error] index is empty — run `index` first.", file=sys.stderr)
        sys.exit(1)

    entries = list(idx["entries"].values())
    emb_matrix = torch.stack([e["emb"] for e in entries], dim=0)  # (N, D)

    device = get_device()
    print(f"[device] {device}")

    # Allow Electron to pass --model during search too. This should normally
    # match the model used during indexing.
    model_id = args.model or idx.get("model") or DEFAULT_MODEL
    model = load_model(model_id, device, text_only=True)
    results = search_entries(args.query, args.top_k, entries, emb_matrix, model, device)

    if args.json:
        print(json.dumps(results), flush=True)
    else:
        print(f'\n[search] "{args.query}"  —  top {len(results)} of {len(entries)} images\n')
        print(f"{'Rank':<6} {'Score':<8} {'Filename':<35} Path")
        print("─" * 95)

        for result in results:
            p = Path(result["path"])
            print(f'#{result["rank"]:<5} {result["score"]:.4f}   {p.name:<35} {p}')


# ── SERVE command ─────────────────────────────────────────────────────────────

def cmd_serve(args) -> None:
    index_path = Path(args.index)
    idx = load_index(args.index)

    if not idx["entries"]:
        print(json.dumps({"type": "error", "error": "index-empty"}), flush=True)
        sys.exit(1)

    entries = list(idx["entries"].values())
    emb_matrix = torch.stack([e["emb"] for e in entries], dim=0)
    index_mtime = index_path.stat().st_mtime_ns

    device = get_device()
    print(f"[device] {device}")

    # Allow Electron to pass --model during serve too. This should normally
    # match the model used during indexing.
    model_id = args.model or idx.get("model") or DEFAULT_MODEL
    model = load_model(model_id, device, text_only=True)

    print(json.dumps({
        "type": "ready",
        "device": str(device),
        "entries": len(entries),
    }), flush=True)

    for line in sys.stdin:
        request: dict[str, Any] = {}

        try:
            request = json.loads(line)
            request_id = request.get("id")
            query = str(request.get("query") or "").strip()
            top_k = int(request.get("topK") or 20)

            if not query:
                raise ValueError("empty-query")

            # Reload index if indexing process updated it.
            try:
                current_mtime = index_path.stat().st_mtime_ns
                if current_mtime != index_mtime:
                    next_idx = torch.load(index_path, map_location="cpu", weights_only=False)
                    next_entries = list(next_idx["entries"].values())

                    if next_entries:
                        entries = next_entries
                        emb_matrix = torch.stack([e["emb"] for e in entries], dim=0)
                        index_mtime = current_mtime

            except Exception as exc:
                print(f"[serve] keeping previous index after reload failed: {exc}", file=sys.stderr, flush=True)

            results = search_entries(query, top_k, entries, emb_matrix, model, device)

            print(json.dumps({
                "type": "result",
                "id": request_id,
                "results": results,
            }), flush=True)

        except Exception as exc:
            print(json.dumps({
                "type": "result",
                "id": request.get("id") if isinstance(request, dict) else None,
                "error": str(exc),
                "results": [],
            }), flush=True)


# ── CLI ───────────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(
        prog="tipsv2_search",
        description="TIPSv2 text-to-image search — index your images, then search them.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )

    sub = parser.add_subparsers(dest="cmd", required=True)

    # ── index ──
    pi = sub.add_parser("index", help="Build or update the image index")
    source = pi.add_mutually_exclusive_group()
    source.add_argument("--folder", "-f", default=None, help="Folder to scan for images")
    source.add_argument("--manifest", default=None, help="JSON manifest supplied by Stag")
    pi.add_argument("--index", "-i", default=DEFAULT_INDEX, help=f"Index file (default: {DEFAULT_INDEX})")
    pi.add_argument("--recursive", "-r", action="store_true", help="Include sub-folders")
    pi.add_argument("--model", "-m", default=DEFAULT_MODEL, help=f"HF model ID or local model directory (default: {DEFAULT_MODEL})")
    pi.add_argument("--batch-size", "-b", type=int, default=1, help="Images per GPU batch (default: 1 for per-image progress; increase on GPU for speed)")
    pi.add_argument("--info", action="store_true", help="Print index contents and exit")
    pi.add_argument("--clean", action="store_true", help="Remove entries for deleted files and exit")
    pi.add_argument("--json-progress", action="store_true", help="Emit JSON progress lines to stdout instead of tqdm")

    # ── search ──
    ps = sub.add_parser("search", help="Search the index with a text query")
    ps.add_argument("--query", "-q", required=True, help="Text search query")
    ps.add_argument("--index", "-i", default=DEFAULT_INDEX, help=f"Index file (default: {DEFAULT_INDEX})")
    ps.add_argument("--top-k", "-k", type=int, default=5, help="Results to return (default: 5)")
    ps.add_argument("--model", "-m", default=None, help="HF model ID or local model directory. Optional for search; defaults to model stored in index.")
    ps.add_argument("--json", action="store_true", help="Output results as JSON array instead of table")

    # ── serve ──
    pv = sub.add_parser("serve", help="Keep the text model loaded and accept JSON search requests on stdin")
    pv.add_argument("--index", "-i", default=DEFAULT_INDEX, help=f"Index file (default: {DEFAULT_INDEX})")
    pv.add_argument("--model", "-m", default=None, help="HF model ID or local model directory. Optional for serve; defaults to model stored in index.")

    args = parser.parse_args()

    if args.cmd == "index":
        cmd_index(args)
    elif args.cmd == "serve":
        cmd_serve(args)
    else:
        cmd_search(args)


if __name__ == "__main__":
    main()
