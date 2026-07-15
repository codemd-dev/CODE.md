#!/usr/bin/env python3
"""
SCIM: Structural Code Intelligence Model dataset builder.

This is an MVP pipeline for turning folders shaped like:

    C:\\DATA\\Code\\output\\00-Eva_shatte_572b9f78\\
        src/
        search_graph.json

into source-code embeddings plus separate architecture artifacts. The SCIM
vector database is reserved for code units only: functions, methods, classes,
and the docstrings or inline comments contained inside those units. Whole files,
README/docs/config files, generated evidence, graphs, feature summaries, and
training pairs are written beside it under architecture/.

"""

from __future__ import annotations

import argparse
import ast
import csv
import gc
import hashlib
import json
import math
import os
import re
import random
import sqlite3
import warnings
import statistics
from collections import Counter, defaultdict, deque
from dataclasses import dataclass, field
from html.parser import HTMLParser
from html import unescape as html_unescape
from pathlib import Path
from typing import Iterable

import numpy as np

try:
    import faiss
except ImportError:  # pragma: no cover - optional dependency
    faiss = None

try:
    from sentence_transformers import SentenceTransformer
except ImportError:  # pragma: no cover - optional dependency
    SentenceTransformer = None

try:
    import torch
    from torch import nn
except ImportError:  # pragma: no cover - optional dependency
    torch = None
    nn = None

try:
    from sklearn.cluster import KMeans
except ImportError:  # pragma: no cover - optional dependency
    KMeans = None


DEFAULT_INPUT = Path(r"C:\DATA\Code\output")
DEFAULT_OUTPUT = Path("scim_dataset")
CODE_DIM = 384
GRAPH_DIM = 128
MAX_FEATURES = 8192
DEFAULT_MAX_CHUNKS_PER_REPO = int(os.getenv("SCIM_MAX_CHUNKS_PER_REPO", "20000"))
DEFAULT_MAX_FILE_BYTES = int(os.getenv("SCIM_MAX_FILE_BYTES", "5000000"))
DEFAULT_MAX_RECORD_CODE_CHARS = int(os.getenv("SCIM_MAX_RECORD_CODE_CHARS", "2000"))
DEFAULT_SBERT_MODEL = "sentence-transformers/all-MiniLM-L6-v2"
SCRIPT_DIR = Path(__file__).resolve().parent
CODE_SOURCE_EXTENSIONS = {
    ".java",
    ".kt",
    ".kts",
    ".py",
    ".js",
    ".jsx",
    ".ts",
    ".tsx",
    ".c",
    ".cc",
    ".cpp",
    ".h",
    ".hpp",
    ".cs",
    ".go",
    ".rs",
    ".rb",
    ".php",
}

HTML_SOURCE_EXTENSIONS = {".html", ".htm", ".xhtml"}
DOCUMENT_TEXT_EXTENSIONS = {".md", ".txt", ".rst", ".adoc", ".xml"}
TEXT_EXTENSIONS = set(CODE_SOURCE_EXTENSIONS)

SCIM_EXTRACTOR_VERSION = 27

SKIP_PATH_PARTS = {
    ".git",
    ".github",
    ".idea",
    ".vscode",
    "__pycache__",
    ".pytest_cache",
    ".venv",
    "venv",
    "env",
    ".tox",
    ".nox",
    "node_modules",
    "dist",
    "build",
    "target",
    "vendor",
    "vendors",
    "third-party",
    "third_party",
    "thirdparty",
    "extern",
    "external",
    "deps",
    "dependencies",
    "output",
}


def is_generated_output_dir_name(name: str) -> bool:
    lower = str(name or "").lower()
    return lower == "output" or lower.startswith(("output_", "output-", "output%"))


def should_skip_source_path(path: Path, src_root: Path | None = None) -> bool:
    path_for_match = path
    if src_root is not None:
        try:
            path_for_match = path.relative_to(src_root)
        except ValueError:
            path_for_match = path
    parts = {part.lower() for part in path_for_match.parts}
    if parts & SKIP_PATH_PARTS:
        return True
    if parts & {"sample", "samples"}:
        return True
    if any(is_generated_output_dir_name(part) for part in parts):
        return True
    name = path.name.lower()
    return name.endswith(".min.js") or name.endswith(".bundle.js")


def looks_like_browser_metadata_file(path: Path) -> bool:
    if path.suffix.lower() not in {".js", ".jsx", ".ts", ".tsx"}:
        return False
    try:
        sample = path.read_text(encoding="utf-8", errors="ignore")[:12000].lower()
    except OSError:
        return False
    browser_keys = ("pagetitle", "pageurl", "faviconurl", "lastaccesstime")
    if "edge_all_open_tabs" in sample:
        return True
    return sum(1 for key in browser_keys if key in sample) >= 2 and ("pageurl" in sample or "url" in sample)


@dataclass(frozen=True)
class CodeChunk:
    repo_id: str
    chunk_id: str
    symbol: str
    class_name: str
    method_name: str
    path: str
    start_line: int
    end_line: int
    code: str


@dataclass
class GraphStats:
    nodes: list[str]
    out_edges: dict[str, set[str]]
    in_edges: dict[str, set[str]]
    pagerank: dict[str, float]
    component_id: dict[str, int]
    cfg_tokens: dict[str, list[str]] = field(default_factory=dict)


@dataclass(frozen=True)
class GraphEdge:
    source: str
    target: str
    raw_source: str
    raw_target: str
    graph_file: str


def stable_hash(value: str) -> int:
    digest = hashlib.blake2b(value.encode("utf-8", errors="ignore"), digest_size=8).digest()
    return int.from_bytes(digest, "little", signed=False)


def normalize(vector: list[float]) -> list[float]:
    length = math.sqrt(sum(x * x for x in vector))
    if length == 0:
        return vector
    return [x / length for x in vector]


def hashed_embedding(tokens: Iterable[str], dim: int, prefix: str = "") -> list[float]:
    vector = [0.0] * dim
    counts = Counter(tokens)
    for token, count in counts.items():
        key = f"{prefix}:{token}"
        bucket = stable_hash(key) % dim
        sign = -1.0 if stable_hash(key + ":sign") % 2 else 1.0
        vector[bucket] += sign * (1.0 + math.log(count))
    return normalize(vector)


class TfidfProjector:
    """Corpus-fitted TF-IDF embeddings projected to a compact dense vector."""

    def __init__(self, dim: int, max_features: int = MAX_FEATURES, prefix: str = "") -> None:
        self.dim = dim
        self.max_features = max_features
        self.prefix = prefix
        self.vocab: dict[str, int] = {}
        self.idf: list[float] = []

    def fit(self, documents: list[list[str]]) -> None:
        document_frequency: Counter[str] = Counter()
        for tokens in documents:
            document_frequency.update(set(tokens))

        most_common = document_frequency.most_common(self.max_features)
        self.vocab = {token: index for index, (token, _) in enumerate(most_common)}
        doc_count = max(1, len(documents))
        self.idf = [
            math.log((1 + doc_count) / (1 + document_frequency[token])) + 1.0
            for token, _ in most_common
        ]

    def transform(self, tokens: Iterable[str]) -> list[float]:
        sparse: Counter[int] = Counter()
        for token in tokens:
            index = self.vocab.get(token)
            if index is not None:
                sparse[index] += 1

        vector = np.zeros(self.dim, dtype=np.float32)
        for index, count in sparse.items():
            value = (1.0 + math.log(count)) * self.idf[index]
            key = f"{self.prefix}:{index}"
            bucket = stable_hash(key) % self.dim
            sign = -1.0 if stable_hash(key + ":sign") % 2 else 1.0
            vector[bucket] += sign * value

        norm = float(np.linalg.norm(vector))
        if norm:
            vector /= norm
        return vector.astype(float).tolist()

    def to_json(self) -> dict:
        return {
            "dim": self.dim,
            "max_features": self.max_features,
            "prefix": self.prefix,
            "vocab": self.vocab,
            "idf": self.idf,
        }

    @classmethod
    def from_json(cls, data: dict) -> "TfidfProjector":
        model = cls(int(data["dim"]), int(data.get("max_features", MAX_FEATURES)), str(data.get("prefix", "")))
        model.vocab = {str(key): int(value) for key, value in data["vocab"].items()}
        model.idf = [float(value) for value in data["idf"]]
        return model


class EmbeddingModel:
    def __init__(
        self,
        backend: str,
        code_projector: TfidfProjector | None,
        graph_projector: TfidfProjector,
        sbert_model_name: str | None = None,
    ) -> None:
        self.backend = backend
        self.code_projector = code_projector
        self.graph_projector = graph_projector
        self.sbert_model_name = sbert_model_name
        self._sbert_model = None

    @property
    def code_dim(self) -> int:
        if self.backend == "sbert":
            return self._get_sbert().get_sentence_embedding_dimension()
        if self.code_projector is None:
            raise ValueError("TF-IDF code projector is missing.")
        return self.code_projector.dim

    @property
    def graph_dim(self) -> int:
        return self.graph_projector.dim

    @property
    def fused_dim(self) -> int:
        return self.code_dim + self.graph_dim

    def _get_sbert(self):
        if SentenceTransformer is None:
            raise RuntimeError("sentence-transformers is not installed. Install it or use --backend tfidf.")
        if self._sbert_model is None:
            model_name = self.sbert_model_name or DEFAULT_SBERT_MODEL
            try:
                self._sbert_model = SentenceTransformer(model_name, local_files_only=True)
            except Exception:
                self._sbert_model = SentenceTransformer(model_name)
        return self._sbert_model

    def embed_code_batch(self, codes: list[str], batch_size: int = 32) -> list[list[float]]:
        if self.backend == "sbert":
            embeddings = self._get_sbert().encode(
                codes,
                batch_size=batch_size,
                show_progress_bar=True,
                normalize_embeddings=True,
            )
            return embeddings.astype(float).tolist()
        return [self.embed_code(code) for code in codes]

    def embed_code(self, code: str) -> list[float]:
        if self.backend == "sbert":
            return self.embed_code_batch([code], batch_size=1)[0]
        if self.code_projector is None:
            raise ValueError("TF-IDF code projector is missing.")
        return self.code_projector.transform(tokenize_code(code))

    def embed_graph(self, tokens: list[str]) -> list[float]:
        return self.graph_projector.transform(tokens)

    def embed_query(self, query: str) -> list[float]:
        query_tokens = tokenize_code(query)
        if self.backend == "sbert":
            code_vector = self._get_sbert().encode(
                [query],
                batch_size=1,
                show_progress_bar=False,
                normalize_embeddings=True,
            )[0].astype(float).tolist()
        else:
            if self.code_projector is None:
                raise ValueError("TF-IDF code projector is missing.")
            code_vector = self.code_projector.transform(query_tokens)
        return code_vector + [0.0] * self.graph_dim

    def save(self, path: Path) -> None:
        payload = {
            "backend": self.backend,
            "sbert_model_name": self.sbert_model_name,
            "code_projector": self.code_projector.to_json() if self.code_projector else None,
            "graph_projector": self.graph_projector.to_json(),
        }
        path.write_text(json.dumps(payload), encoding="utf-8")

    @classmethod
    def load(cls, path: Path) -> "EmbeddingModel":
        payload = json.loads(path.read_text(encoding="utf-8"))
        return cls(
            str(payload["backend"]),
            TfidfProjector.from_json(payload["code_projector"]) if payload.get("code_projector") else None,
            TfidfProjector.from_json(payload["graph_projector"]),
            payload.get("sbert_model_name"),
        )


def train_embedding_model(
    code_documents: list[list[str]],
    graph_documents: list[list[str]],
    backend: str,
    sbert_model: str | None,
) -> EmbeddingModel:
    graph_projector = TfidfProjector(GRAPH_DIM, MAX_FEATURES, "graph")
    graph_projector.fit(graph_documents)

    if backend == "tfidf":
        code_projector = TfidfProjector(CODE_DIM, MAX_FEATURES, "code")
        code_projector.fit(code_documents)
        return EmbeddingModel(backend, code_projector, graph_projector)

    if backend == "sbert":
        if SentenceTransformer is None:
            raise RuntimeError("sentence-transformers is not installed. Use --backend tfidf or install it.")
        return EmbeddingModel(backend, None, graph_projector, sbert_model or DEFAULT_SBERT_MODEL)

    raise ValueError(f"Unsupported backend '{backend}'.")


def tokenize_code(code: str) -> list[str]:
    rough_tokens = re.findall(r"[A-Za-z_][A-Za-z0-9_]*|\d+|==|!=|<=|>=|&&|\|\||[{}()[\].,;:+\-*/%<>]", code)
    tokens: list[str] = []
    for token in rough_tokens:
        tokens.append(token.lower())
        parts = re.sub("([a-z0-9])([A-Z])", r"\1 \2", token).replace("_", " ").split()
        tokens.extend(part.lower() for part in parts if part)
    return tokens


def chunk_search_document(chunk: CodeChunk) -> str:
    """Build the searchable document for one code unit."""
    signature = ""
    for line in chunk.code.splitlines():
        stripped = line.strip()
        if stripped:
            signature = stripped[:500]
            break
    return "\n".join(
        part
        for part in (
            f"symbol: {chunk.symbol}",
            f"name: {chunk.method_name}",
            f"class: {chunk.class_name}",
            f"path: {chunk.path}",
            f"lines: {chunk.start_line}-{chunk.end_line}",
            f"signature: {signature}",
            "code:",
            chunk.code[:12000],
        )
        if part
    )


FEATURE_STOPWORDS = {
    "java",
    "main",
    "src",
    "core",
    "android",
    "desktop",
    "ios",
    "com",
    "org",
    "net",
    "class",
    "public",
    "private",
    "protected",
    "static",
    "void",
    "int",
    "float",
    "boolean",
    "string",
    "evan",
    "b8b845",
    "shattered",
    "pixel",
    "shatteredpixel",
    "shatteredpixeldungeon",
    "watabou",
    "classes",
    "github",
    "output",
    "code",
    "repo",
    "repos",
    "get",
    "set",
    "is",
    "has",
    "do",
    "on",
    "to",
    "from",
    "in",
    "of",
    "and",
    "or",
}


def tokenize_feature_text(text: str) -> list[str]:
    words = re.findall(r"[A-Za-z][A-Za-z0-9]*", text.replace("_", " ").replace("-", " "))
    tokens: list[str] = []
    for word in words:
        parts = re.sub("([a-z0-9])([A-Z])", r"\1 \2", word).split()
        for part in parts:
            token = part.lower()
            if len(token) >= 3 and token not in FEATURE_STOPWORDS:
                tokens.append(token)
    return tokens


def feature_terms(record: dict) -> list[str]:
    symbol = str(record["symbol"])
    path = str(record["path"])
    code = str(record.get("code", ""))
    normalized_path = path.replace("\\", "/")
    parts = [part for part in normalized_path.split("/") if part]

    useful_parts: list[str] = []
    for marker in ("java", "kotlin", "python", "src"):
        if marker in parts:
            useful_parts = parts[parts.index(marker) + 1 :]
    if not useful_parts:
        useful_parts = parts[-6:]

    if useful_parts and "." in useful_parts[-1]:
        useful_parts = useful_parts[:-1]

    terms = tokenize_feature_text(symbol)
    terms.extend(tokenize_feature_text(" ".join(useful_parts)))
    terms.extend(tokenize_feature_text(code[:8000]))
    return terms


def humanize_feature_token(token: str) -> str:
    token = re.sub(r"([a-z])([A-Z])", r"\1 \2", str(token))
    token = token.replace("_", " ").replace("-", " ")
    words = tokenize_feature_text(token)
    if not words:
        words = [part.lower() for part in token.split() if part]
    known = {
        "ai": "AI",
        "ui": "UI",
        "api": "API",
        "rpg": "RPG",
        "gobang": "Gobang",
        "pikachu": "Pikachu",
        "minesweeper": "Minesweeper",
        "bomberman": "Bomberman",
        "tankwar": "Tankwar",
    }
    return " ".join(known.get(word, word.capitalize()) for word in words)


def humanize_repo_name(name: str) -> str:
    cleaned = re.sub(r"-?[0-9a-f]{7,}$", "", str(name or ""), flags=re.IGNORECASE)
    cleaned = re.sub(r"^[0-9]+[-_]", "", cleaned)
    cleaned = cleaned.replace("_", " ").replace("-", " ")
    words = [word for word in cleaned.split() if word.lower() not in {"repo", "src"}]
    return " ".join(word[:1].upper() + word[1:] for word in words) or "Unknown product"


def repo_context_text(repo_context: dict | None) -> str:
    if not isinstance(repo_context, dict):
        return ""
    parts: list[str] = []
    for key in ("github_full_name", "github_owner", "github_repo", "readme_text", "document_text"):
        value = repo_context.get(key)
        if value:
            parts.append(str(value))
    for item in repo_context.get("readme_items", []) or []:
        if isinstance(item, dict) and item.get("text"):
            parts.append(str(item["text"]))
    for item in repo_context.get("document_items", []) or []:
        if isinstance(item, dict) and item.get("text"):
            parts.append(str(item["text"]))
    return " ".join(parts)


def product_name_from_context(repo_context: dict | None) -> tuple[str, str]:
    if not isinstance(repo_context, dict):
        return "", ""
    repo_name = str(repo_context.get("github_repo") or "").strip()
    owner_name = str(repo_context.get("github_owner") or "").strip()
    full_name = str(repo_context.get("github_full_name") or "").strip()
    if not repo_name and "/" in full_name:
        repo_name = full_name.rsplit("/", 1)[-1]
    if repo_name:
        generic_repo_names = {
            "app", "api", "server", "client", "frontend", "backend", "service",
            "services", "web", "site", "demo", "example", "examples", "project",
            "repo", "main", "test", "tests",
        }
        if repo_name.lower().replace("-", "").replace("_", "") in generic_repo_names and owner_name:
            return humanize_repo_name(f"{owner_name} {repo_name}"), "github_repository_path"
        return humanize_repo_name(repo_name), "github_repository_name"
    return "", ""


GAME_FEATURE_NAME_ALIASES = {
    "bloodfootball": "Blood Football",
    "bomberman": "Bomberman",
    "breakoutclone": "Breakout",
    "catchcoins": "Catch Coins",
    "flappybird": "Flappy Bird",
    "flipcardbymemory": "Flip Card By Memory",
    "gemgem": "Gem Gem",
    "gobang": "Gobang",
    "magictower": "Magic Tower",
    "minesweeper": "Minesweeper",
    "pacman": "Pac-Man",
    "pikachu": "Pikachu",
    "puzzlepieces": "Puzzle Pieces",
    "ski": "Ski",
    "tankwar": "Tank War",
    "towerdefense": "Tower Defense",
    "twozerofoureight": "2048",
    "voicecontrolpikachu": "Voice Control Pikachu",
    "whacamole": "Whac-A-Mole",
}


def humanize_repo_feature_key(key: str, product_type: str) -> str:
    normalized = re.sub(r"[^a-z0-9]+", "", str(key).lower())
    if product_type == "game project" and normalized in GAME_FEATURE_NAME_ALIASES:
        return GAME_FEATURE_NAME_ALIASES[normalized]
    return humanize_feature_token(key)


def record_path_terms(record: dict) -> list[str]:
    path = str(record.get("path", ""))
    symbol = str(record.get("symbol", ""))
    return tokenize_feature_text(f"{path} {symbol}")


def record_path_only_terms(record: dict) -> list[str]:
    return tokenize_feature_text(str(record.get("path", "")))


FEATURE_CATALOG = [
    (
        "Save/load and persistence",
        {
            "save",
            "load",
            "restore",
            "store",
            "bundle",
            "backup",
            "slot",
            "state",
            "serialize",
            "persist",
        },
    ),
    (
        "Level transitions and dungeon flow",
        {
            "level",
            "dungeon",
            "interlevel",
            "transition",
            "switch",
            "descend",
            "ascend",
            "return",
            "resurrect",
            "reset",
            "depth",
        },
    ),
    (
        "Dungeon generation and rooms",
        {
            "rooms",
            "room",
            "painter",
            "paint",
            "terrain",
            "tile",
            "tiles",
            "map",
            "maze",
            "builder",
            "entrance",
            "exit",
            "secret",
        },
    ),
    (
        "Combat, damage, and targeting",
        {
            "attack",
            "damage",
            "defense",
            "weapon",
            "armor",
            "hit",
            "target",
            "zap",
            "shoot",
            "throw",
            "kill",
            "death",
            "roll",
            "proc",
        },
    ),
    (
        "Hero, classes, talents, and abilities",
        {
            "hero",
            "talent",
            "ability",
            "warrior",
            "mage",
            "rogue",
            "huntress",
            "duelist",
            "cleric",
            "spell",
            "subclass",
        },
    ),
    (
        "Enemies, mobs, NPCs, and AI",
        {
            "mob",
            "mobs",
            "npc",
            "enemy",
            "boss",
            "ally",
            "ai",
            "act",
            "aggro",
            "flee",
            "wander",
            "notice",
            "beckon",
        },
    ),
    (
        "Items, inventory, equipment, and loot",
        {
            "item",
            "items",
            "inventory",
            "bag",
            "belongings",
            "equip",
            "collect",
            "loot",
            "heap",
            "gold",
            "potion",
            "scroll",
            "wand",
            "ring",
            "artifact",
            "food",
            "key",
        },
    ),
    (
        "Buffs, status effects, and conditions",
        {
            "buff",
            "buffs",
            "status",
            "effect",
            "effects",
            "blindness",
            "invisibility",
            "haste",
            "terror",
            "bleeding",
            "poison",
            "burning",
            "paralysis",
            "cooldown",
        },
    ),
    (
        "UI, windows, menus, and scenes",
        {
            "ui",
            "window",
            "windows",
            "wnd",
            "scene",
            "scenes",
            "button",
            "toolbar",
            "layout",
            "menu",
            "pane",
            "tab",
            "select",
            "click",
            "text",
        },
    ),
    (
        "Rendering, sprites, effects, and audio",
        {
            "sprite",
            "sprites",
            "render",
            "visual",
            "image",
            "texture",
            "camera",
            "particle",
            "emitter",
            "animation",
            "fx",
            "sound",
            "music",
        },
    ),
    (
        "Quests, badges, journal, and progression",
        {
            "quest",
            "quests",
            "badge",
            "badges",
            "journal",
            "record",
            "ranking",
            "rankings",
            "statistics",
            "unlock",
            "progress",
            "catalog",
            "document",
        },
    ),
    (
        "Traps, blobs, plants, and environment",
        {
            "trap",
            "traps",
            "blob",
            "blobs",
            "plant",
            "plants",
            "water",
            "fire",
            "gas",
            "grass",
            "chasm",
            "door",
            "wall",
        },
    ),
    (
        "Settings, input, platform, and system",
        {
            "settings",
            "input",
            "key",
            "keyboard",
            "controller",
            "pointer",
            "android",
            "desktop",
            "ios",
            "platform",
            "display",
            "update",
            "support",
        },
    ),
]

UI_COMPONENT_FEATURE_CATALOG = [
    ("Progress display and value updates", {"progress", "bar", "value", "percent", "max", "min", "update", "increment"}),
    ("Widget rendering and drawing", {"draw", "paint", "render", "canvas", "view", "drawable", "bitmap", "graphics"}),
    ("Styling, colors, and appearance", {"color", "style", "theme", "paint", "background", "foreground", "tint"}),
    ("Sizing, layout, and measurement", {"layout", "measure", "width", "height", "size", "bounds", "padding"}),
    ("Animation and transitions", {"animate", "animation", "animator", "duration", "interpolator", "transition"}),
    ("Configuration and attributes", {"config", "attribute", "attrs", "setting", "option", "init", "constructor"}),
    ("Demo/sample application", {"demo", "sample", "example", "main", "activity", "show"}),
    ("Platform integration", {"android", "context", "resource", "xml", "view", "activity"}),
]

CARD_GAME_FEATURE_CATALOG = [
    ("Cards, deck, and shuffling", {"card", "cards", "deck", "shuffle", "suit", "rank"}),
    ("Hands and scoring", {"hand", "score", "value", "rank", "pair", "flush", "straight"}),
    ("Players and dealer flow", {"player", "dealer", "turn", "bet", "winner"}),
    ("Game state and rounds", {"game", "round", "state", "start", "reset", "deal"}),
    ("UI and input", {"button", "click", "view", "screen", "input", "select"}),
]

GENERIC_GAME_FEATURE_CATALOG = [
    ("Game loop and scene flow", {"game", "level", "scene", "start", "run", "restart", "pause", "over"}),
    ("Player, enemy, and object behavior", {"player", "enemy", "hero", "sprite", "tank", "bird", "ball", "snake", "block"}),
    ("Input and controls", {"key", "keyboard", "mouse", "click", "event", "control", "button", "input"}),
    ("Rendering, animation, and visual effects", {"draw", "render", "display", "screen", "image", "sprite", "animation", "surface"}),
    ("Collision, physics, and movement", {"collide", "collision", "move", "speed", "position", "rect", "hit", "bounce"}),
    ("Scoring, state, and rules", {"score", "state", "win", "lose", "rule", "match", "timer", "life"}),
    ("Maps, levels, and boards", {"map", "level", "board", "grid", "maze", "mine", "tower", "tile"}),
    ("AI and automated opponents", {"ai", "search", "strategy", "bot", "enemy", "path", "choose"}),
    ("Audio, assets, and resources", {"sound", "music", "audio", "asset", "resource", "font", "image"}),
]

CODE_ANALYSIS_FEATURE_CATALOG = [
    ("Repository ingestion and metadata", {"repo", "github", "metadata", "branch", "zip", "download", "cache", "extract"}),
    ("Parser and AST extraction", {"parse", "parser", "ast", "tree", "sitter", "javalang", "joern", "python", "java", "syntax"}),
    ("Graph construction and visualization", {"graph", "node", "edge", "callee", "caller", "cytoscape", "dependency", "callgraph"}),
    ("Search and embedding model", {"search", "query", "embedding", "vector", "sqlite", "dataset", "scim", "token", "model"}),
    ("Feature catalog and static evidence", {"feature", "catalog", "evidence", "match", "keyword", "subfeature", "metric", "summary"}),
    ("Dashboard and generated reports", {"dashboard", "render", "html", "asset", "panel", "table", "status", "display"}),
    ("API service and configuration", {"api", "route", "request", "response", "fastapi", "token", "config", "environment"}),
]

LIBRARY_FEATURE_CATALOG = [
    ("Core APIs and public surface", {"api", "public", "builder", "factory", "create", "open", "close"}),
    ("Data structures and models", {"model", "node", "value", "entry", "map", "list", "set"}),
    ("I/O, buffers, and streams", {"buffer", "stream", "source", "sink", "read", "write", "byte"}),
    ("Concurrency and async flow", {"async", "flow", "future", "thread", "executor", "dispatch", "emit"}),
    ("Parsing, encoding, and serialization", {"parse", "encode", "decode", "json", "serialize", "format"}),
    ("Validation and error handling", {"check", "validate", "error", "exception", "fail", "assert"}),
    ("Tests, samples, and compatibility", {"test", "sample", "example", "compat", "mock"}),
]

JAVA_UTILITY_FEATURE_CATALOG = [
    ("String utilities and text handling", {"string", "charsequence", "blank", "empty", "split", "join", "substring", "replace", "case"}),
    ("Array, object, and validation helpers", {"array", "object", "validate", "default", "null", "clone", "contains", "index"}),
    ("Reflection utilities", {"reflect", "reflection", "method", "field", "constructor", "invoke", "accessible"}),
    ("Date, time, and formatting utilities", {"date", "time", "duration", "calendar", "format", "parse", "truncate", "round"}),
    ("Random, numeric, and boolean utilities", {"random", "number", "numeric", "boolean", "range", "compare"}),
    ("Builder and system helper utilities", {"builder", "system", "class", "enum", "exception", "arch", "event"}),
]

DEFAULT_FEATURE_CATALOG = [
    ("Core application logic", {"app", "main", "core", "manager", "service", "controller"}),
    ("Data model and state", {"model", "state", "data", "record", "entity", "value"}),
    ("UI and interaction", {"ui", "view", "screen", "button", "click", "input", "layout"}),
    ("Persistence and configuration", {"save", "load", "store", "restore", "config", "settings"}),
    ("Rendering and presentation", {"render", "draw", "paint", "display", "image", "text"}),
    ("System integration", {"platform", "system", "file", "network", "update", "support"}),
]


SUBFEATURE_CATALOG = {
    "Items, inventory, equipment, and loot": [
        ("Scrolls", {"scroll", "scrolls"}),
        ("Potions", {"potion", "potions"}),
        ("Wands", {"wand", "wands"}),
        ("Weapons", {"weapon", "weapons", "melee", "missile"}),
        ("Armor", {"armor", "glyph", "glyphs"}),
        ("Artifacts and rings", {"artifact", "artifacts", "ring", "rings"}),
        ("Bags and inventory selection", {"bag", "bags", "inventory", "belongings", "quickslot"}),
        ("Food and consumables", {"food", "meat", "pasty", "ration", "eat"}),
        ("Loot, gold, heaps, and keys", {"loot", "gold", "heap", "heaps", "key", "keys", "drop", "collect"}),
    ],
    "UI, windows, menus, and scenes": [
        ("Windows and dialogs", {"window", "windows", "wnd"}),
        ("Scenes and screen flow", {"scene", "scenes", "startscene", "gamescene", "interlevelscene"}),
        ("Buttons, toolbar, and menus", {"button", "buttons", "toolbar", "menu", "pane"}),
        ("Tabs, lists, and layout", {"tab", "tabs", "list", "layout", "scrollpane"}),
        ("Text input and labels", {"text", "label", "input", "title"}),
        ("Selection and click handling", {"select", "selected", "click", "onclick", "hover"}),
    ],
    "Enemies, mobs, NPCs, and AI": [
        ("Mob base behavior", {"mob", "mobs", "act", "notice", "enemy"}),
        ("Bosses and special enemies", {"boss", "dm300", "tengu", "yog", "king", "goo"}),
        ("NPCs and quests", {"npc", "npcs", "ghost", "shopkeeper", "blacksmith", "imp"}),
        ("Allies, summons, and companions", {"ally", "allies", "summon", "summoning", "bee", "ghost"}),
        ("AI states and movement", {"wander", "flee", "hunt", "beckon", "target", "enemy"}),
        ("Mob loot and spawning", {"spawn", "spawner", "loot", "create", "rotation"}),
    ],
    "Combat, damage, and targeting": [
        ("Damage rolls and defense", {"damage", "roll", "drroll", "defense", "armor"}),
        ("Melee and ranged attacks", {"attack", "melee", "missile", "shoot", "throw"}),
        ("Weapon abilities and procs", {"weapon", "proc", "ability", "duelist", "kill"}),
        ("Targeting and ballistics", {"target", "targeting", "ballistica", "cell", "zap"}),
        ("Death, kill, and fail states", {"death", "die", "kill", "fail", "gameover"}),
    ],
    "Hero, classes, talents, and abilities": [
        ("Hero core stats and actions", {"hero", "str", "exp", "live", "busy", "act"}),
        ("Talents and subclasses", {"talent", "talents", "subclass", "points"}),
        ("Class abilities", {"ability", "abilities", "warrior", "rogue", "mage", "huntress", "duelist"}),
        ("Cleric spells", {"cleric", "spell", "spells", "holy", "tome"}),
        ("Hero selection and badges", {"heroselectscene", "select", "badge", "unlock"}),
    ],
    "Buffs, status effects, and conditions": [
        ("Buff lifecycle", {"buff", "buffs", "affect", "detach", "attach"}),
        ("Cooldowns and trackers", {"cooldown", "tracker", "iconfadepercent", "visualcooldown"}),
        ("Negative status effects", {"poison", "bleeding", "burning", "blindness", "terror", "daze", "paralysis"}),
        ("Positive status effects", {"haste", "bless", "invisibility", "shield", "healing", "adrenaline"}),
        ("Persistence of buffs", {"store", "restore", "bundle"}),
    ],
    "Rendering, sprites, effects, and audio": [
        ("Character and item sprites", {"sprite", "sprites", "charsprite", "itemsprite"}),
        ("Particles and emitters", {"particle", "particles", "emitter", "emit"}),
        ("Textures, images, and tilemaps", {"texture", "image", "tilemap", "bitmap", "visual"}),
        ("Camera and coordinates", {"camera", "world", "center", "point"}),
        ("Animation and visual effects", {"animation", "animate", "fx", "effect", "effects"}),
        ("Music and sound", {"music", "sound", "audio"}),
    ],
    "Dungeon generation and rooms": [
        ("Room painting", {"room", "rooms", "paint", "painter"}),
        ("Secret rooms", {"secret", "hoard", "laboratory", "library", "runestone"}),
        ("Standard, entrance, and exit rooms", {"standard", "entrance", "exit"}),
        ("Terrain and tile visuals", {"terrain", "tile", "tiles", "tilemap", "wall", "door"}),
        ("Level builders and maze generation", {"builder", "build", "maze", "generate"}),
        ("Special rooms and traps placement", {"special", "quest", "trap", "traps"}),
    ],
    "Settings, input, platform, and system": [
        ("Keyboard and key bindings", {"keyboard", "key", "keys", "binding", "bindings"}),
        ("Controller and pointer input", {"controller", "pointer", "touch", "mouse"}),
        ("Platform support", {"android", "desktop", "ios", "platform", "launcher"}),
        ("Display and UI settings", {"display", "fullscreen", "scale", "brightness", "systemui"}),
        ("Updates, errors, and compatibility", {"update", "updates", "exception", "compat", "support"}),
    ],
    "Save/load and persistence": [
        ("Game save/load", {"save", "load", "savegame", "loadgame"}),
        ("Level save/load", {"savelevel", "loadlevel", "level"}),
        ("Bundle serialization", {"bundle", "store", "restore"}),
        ("Backup and save slots", {"backup", "slot", "saveslot"}),
        ("Settings persistence", {"settings", "gamesettings", "put", "get"}),
    ],
    "Level transitions and dungeon flow": [
        ("Switching levels", {"switch", "switchlevel", "transition", "leveltransition"}),
        ("Descending, ascending, and return flow", {"descend", "ascend", "return", "returnto"}),
        ("Interlevel scene", {"interlevel", "interlevelscene"}),
        ("Reset, resurrection, and restore flow", {"reset", "resurrect", "restore"}),
        ("Depth and level creation", {"depth", "newlevel", "create", "loadlevel"}),
    ],
    "Traps, blobs, plants, and environment": [
        ("Traps", {"trap", "traps", "activate", "trigger"}),
        ("Blobs and gases", {"blob", "blobs", "gas", "toxic", "fire"}),
        ("Plants and grass", {"plant", "plants", "grass", "seed"}),
        ("Terrain hazards", {"chasm", "water", "wall", "door", "pit"}),
        ("Environmental effects", {"burning", "freezing", "electricity", "storm"}),
    ],
    "Quests, badges, journal, and progression": [
        ("Quests", {"quest", "quests", "blacksmith", "ghost", "wandmaker", "imp"}),
        ("Badges and unlocks", {"badge", "badges", "unlock", "validate"}),
        ("Journal and notes", {"journal", "notes", "record", "landmark"}),
        ("Rankings and statistics", {"ranking", "rankings", "statistics", "score"}),
        ("Catalog and documents", {"catalog", "document", "documents", "guide"}),
    ],
}

UI_COMPONENT_SUBFEATURE_CATALOG = {
    "Progress display and value updates": [
        ("Current progress value", {"progress", "value", "percent"}),
        ("Minimum and maximum bounds", {"min", "max", "range"}),
        ("Progress updates", {"update", "set", "increment", "change"}),
    ],
    "Widget rendering and drawing": [
        ("Canvas drawing", {"canvas", "draw", "paint"}),
        ("Drawable/bitmap rendering", {"drawable", "bitmap", "image"}),
        ("View invalidation", {"invalidate", "refresh", "redraw"}),
    ],
    "Styling, colors, and appearance": [
        ("Colors", {"color", "colors", "tint"}),
        ("Background and foreground", {"background", "foreground"}),
        ("Styles and themes", {"style", "theme", "appearance"}),
    ],
    "Sizing, layout, and measurement": [
        ("Measurement", {"measure", "measured", "width", "height"}),
        ("Layout bounds", {"layout", "bounds", "rect"}),
        ("Padding and spacing", {"padding", "margin", "spacing"}),
    ],
    "Animation and transitions": [
        ("Progress animation", {"animate", "animation", "animator"}),
        ("Timing", {"duration", "delay", "interpolator"}),
    ],
    "Configuration and attributes": [
        ("XML/custom attributes", {"attrs", "attribute", "xml", "typedarray"}),
        ("Initialization", {"init", "constructor", "create"}),
        ("Runtime options", {"option", "setting", "config"}),
    ],
    "Demo/sample application": [
        ("Sample screens", {"sample", "demo", "example"}),
        ("Activity setup", {"activity", "oncreate", "main"}),
    ],
    "Platform integration": [
        ("Android view integration", {"android", "view", "context"}),
        ("Resources", {"resource", "resources", "xml"}),
    ],
}

CARD_GAME_SUBFEATURE_CATALOG = {
    "Cards, deck, and shuffling": [
        ("Deck creation", {"deck", "create"}),
        ("Shuffle/deal", {"shuffle", "deal"}),
        ("Card model", {"card", "suit", "rank"}),
    ],
    "Hands and scoring": [
        ("Hand evaluation", {"hand", "evaluate", "score"}),
        ("Winning combinations", {"pair", "flush", "straight"}),
    ],
    "Players and dealer flow": [
        ("Player actions", {"player", "hit", "stand", "bet"}),
        ("Dealer actions", {"dealer", "turn"}),
    ],
}

GENERIC_GAME_SUBFEATURE_CATALOG = {
    "Game loop and scene flow": [
        ("Game startup and main loop", {"start", "run", "main", "loop"}),
        ("Level or scene transitions", {"level", "scene", "switch", "restart"}),
        ("Pause/end states", {"pause", "over", "end", "quit"}),
    ],
    "Player, enemy, and object behavior": [
        ("Player behavior", {"player", "hero"}),
        ("Enemy behavior", {"enemy", "monster", "tank"}),
        ("Sprite/object behavior", {"sprite", "object", "ball", "bird", "block"}),
    ],
    "Input and controls": [
        ("Keyboard controls", {"key", "keyboard"}),
        ("Mouse/click controls", {"mouse", "click", "button"}),
        ("Input event handling", {"event", "control", "input"}),
    ],
    "Rendering, animation, and visual effects": [
        ("Drawing and display", {"draw", "display", "screen", "surface"}),
        ("Sprites and images", {"sprite", "image"}),
        ("Animation/effects", {"animation", "effect", "render"}),
    ],
    "Collision, physics, and movement": [
        ("Movement", {"move", "speed", "position"}),
        ("Collision detection", {"collide", "collision", "hit"}),
        ("Bounds/rect physics", {"rect", "bounce", "bound"}),
    ],
    "Scoring, state, and rules": [
        ("Scoring", {"score", "points"}),
        ("Game state", {"state", "timer", "life"}),
        ("Win/lose rules", {"win", "lose", "rule", "match"}),
    ],
    "Maps, levels, and boards": [
        ("Maps and boards", {"map", "board", "grid"}),
        ("Levels and stages", {"level", "stage", "tower"}),
        ("Tiles/mines/maze", {"tile", "mine", "maze"}),
    ],
    "AI and automated opponents": [
        ("AI decision logic", {"ai", "strategy", "choose"}),
        ("Search/path logic", {"search", "path"}),
        ("Automated opponents", {"bot", "enemy"}),
    ],
    "Audio, assets, and resources": [
        ("Sound and music", {"sound", "music", "audio"}),
        ("Images and fonts", {"image", "font"}),
        ("Asset/resource loading", {"asset", "resource"}),
    ],
}

LIBRARY_SUBFEATURE_CATALOG = {
    "Core APIs and public surface": [
        ("Builders and factories", {"builder", "factory", "create"}),
        ("Open/close lifecycle", {"open", "close", "start", "stop"}),
    ],
    "I/O, buffers, and streams": [
        ("Reading", {"read", "source", "input"}),
        ("Writing", {"write", "sink", "output"}),
        ("Buffers", {"buffer", "byte"}),
    ],
    "Validation and error handling": [
        ("Validation", {"check", "validate"}),
        ("Exceptions", {"error", "exception", "fail"}),
    ],
}

JAVA_UTILITY_SUBFEATURE_CATALOG = {
    "String utilities and text handling": [
        ("Blank and empty checks", {"blank", "empty", "notblank", "notempty"}),
        ("Split, join, and substring helpers", {"split", "join", "substring", "left", "right", "mid"}),
        ("Replacement and case helpers", {"replace", "case", "capitalize", "upper", "lower"}),
    ],
    "Array, object, and validation helpers": [
        ("Array manipulation", {"array", "add", "remove", "clone", "contains"}),
        ("Object defaults and null handling", {"object", "default", "null", "nonnull"}),
        ("Argument validation", {"validate", "valid", "inclusive", "exclusive"}),
    ],
    "Reflection utilities": [
        ("Method invocation helpers", {"method", "invoke", "invocation"}),
        ("Field access helpers", {"field", "read", "write"}),
        ("Constructor helpers", {"constructor", "instantiate", "newinstance"}),
    ],
    "Date, time, and formatting utilities": [
        ("Date arithmetic", {"date", "add", "set"}),
        ("Duration formatting", {"duration", "format", "period"}),
        ("Calendar truncation and rounding", {"calendar", "truncate", "round", "ceiling"}),
    ],
    "Random, numeric, and boolean utilities": [
        ("Random strings and values", {"random", "randomstring"}),
        ("Number checks and conversion", {"number", "numeric", "digit"}),
        ("Boolean helpers", {"boolean", "true", "false"}),
    ],
    "Builder and system helper utilities": [
        ("Builder helpers", {"builder", "tostring", "equals", "hashcode"}),
        ("System and platform helpers", {"system", "arch", "os", "java"}),
        ("Class and enum helpers", {"class", "enum", "package"}),
    ],
}

CODE_ANALYSIS_SUBFEATURE_CATALOG = {
    "Repository ingestion and metadata": [
        ("GitHub metadata", {"github", "metadata", "branch"}),
        ("Archive download/cache", {"zip", "download", "cache", "extract"}),
        ("Repository statistics", {"stats", "language", "extension", "comments"}),
    ],
    "Parser and AST extraction": [
        ("Parser dispatcher", {"dispatch", "parser", "parsers", "language", "lang"}),
        ("Python AST parser", {"python", "ast"}),
        ("Java tree-sitter parser", {"java", "tree", "sitter"}),
        ("javalang fallback parser", {"javalang", "fallback"}),
        ("Optional Joern parser", {"joern", "optional"}),
        ("Syntax recovery and parse errors", {"syntax", "parse", "error"}),
    ],
    "Graph construction and visualization": [
        ("Function graph", {"callee", "caller", "callgraph"}),
        ("File graph", {"file", "dependency", "edge", "node"}),
        ("Cytoscape output", {"cytoscape", "html", "visualization"}),
    ],
    "Search and embedding model": [
        ("Vector database", {"vector", "sqlite", "embedding"}),
        ("SCIM dataset", {"scim", "dataset", "model"}),
        ("Query handling", {"search", "query", "result"}),
    ],
    "Feature catalog and static evidence": [
        ("Feature matching", {"feature", "catalog", "keyword", "match"}),
        ("Evidence rows", {"evidence", "symbol", "line"}),
        ("Summary metrics", {"summary", "metric", "count"}),
    ],
    "Dashboard and generated reports": [
        ("Dashboard rendering", {"dashboard", "render", "panel"}),
        ("Generated assets", {"asset", "html", "json"}),
        ("Tables and status", {"table", "status", "display"}),
    ],
    "API service and configuration": [
        ("FastAPI routes", {"fastapi", "route", "request", "response"}),
        ("Tokens and environment", {"token", "environment", "config"}),
    ],
}

DEFAULT_SUBFEATURE_CATALOG: dict[str, list[tuple[str, set[str]]]] = {}


def line_number_at(text: str, offset: int) -> int:
    return text.count("\n", 0, offset) + 1


def strip_comments_preserve_offsets(text: str) -> str:
    def replacer(match: re.Match[str]) -> str:
        value = match.group(0)
        return "".join("\n" if char == "\n" else " " for char in value)

    return re.sub(r"//.*?$|/\*.*?\*/", replacer, text, flags=re.MULTILINE | re.DOTALL)


def find_matching_brace(text: str, open_brace: int) -> int:
    depth = 0
    in_string: str | None = None
    escaped = False
    for index in range(open_brace, len(text)):
        char = text[index]
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == in_string:
                in_string = None
            continue
        if char in ("'", '"'):
            in_string = char
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return index
    return len(text) - 1


def class_spans(clean_text: str) -> list[tuple[str, int, int]]:
    spans: list[tuple[str, int, int]] = []
    for match in re.finditer(r"\b(?:class|interface|enum|record)\s+([A-Za-z_][A-Za-z0-9_]*)\b", clean_text):
        brace = clean_text.find("{", match.end())
        if brace == -1:
            continue
        end = find_matching_brace(clean_text, brace)
        spans.append((match.group(1), brace + 1, end))
    return spans


JAVA_METHOD_RE = re.compile(
    r"""
    (?P<prefix>
        (?:public|protected|private|static|final|native|synchronized|abstract|transient|strictfp|\s)+
        (?:<[^>{};]+>\s*)?
        (?:[A-Za-z_$][\w$<>\[\].?,\s]*\s+)?
    )
    (?P<name>[A-Za-z_$][\w$]*)\s*
    \([^;{}]*\)\s*
    (?:throws\s+[A-Za-z0-9_.,\s]+)?\s*
    \{
    """,
    re.VERBOSE | re.MULTILINE,
)

CONTROL_WORDS = {"if", "for", "while", "switch", "catch", "try", "do", "else", "new", "return"}


def extract_java_chunks(repo_id: str, src_dir: Path, file_path: Path) -> list[CodeChunk]:
    text = file_path.read_text(encoding="utf-8", errors="ignore")
    clean = strip_comments_preserve_offsets(text)
    chunks: list[CodeChunk] = []
    relative_path = str(file_path.relative_to(src_dir)).replace("\\", "/")

    for class_name, class_start, class_end in class_spans(clean):
        body = clean[class_start:class_end]
        for match in JAVA_METHOD_RE.finditer(body):
            method_name = match.group("name")
            if method_name in CONTROL_WORDS:
                continue
            if method_name[:1].isupper() and method_name != class_name:
                continue
            prefix_words = set(re.findall(r"[A-Za-z_][A-Za-z0-9_]*", match.group("prefix")))
            if "new" in prefix_words:
                continue

            absolute_start = class_start + match.start()
            open_brace = class_start + match.end() - 1
            absolute_end = find_matching_brace(clean, open_brace)
            code = text[absolute_start : absolute_end + 1].strip()
            if not code:
                continue

            symbol = f"{class_name}.{method_name}"
            start_line = line_number_at(text, absolute_start)
            end_line = line_number_at(text, absolute_end)
            chunk_id = f"{repo_id}:{symbol}:{relative_path}:{start_line}"
            chunks.append(
                CodeChunk(
                    repo_id=repo_id,
                    chunk_id=chunk_id,
                    symbol=symbol,
                    class_name=class_name,
                    method_name=method_name,
                    path=relative_path,
                    start_line=start_line,
                    end_line=end_line,
                    code=code,
                )
            )
    return chunks


def python_module_name(src_dir: Path, file_path: Path) -> str:
    relative_path = file_path.relative_to(src_dir).with_suffix("")
    parts = list(relative_path.parts)
    if parts and parts[-1] == "__init__":
        parts = parts[:-1]
    return ".".join(parts) if parts else "__init__"


def extract_python_chunks(repo_id: str, src_dir: Path, file_path: Path) -> list[CodeChunk]:
    text = file_path.read_text(encoding="utf-8", errors="ignore")
    relative_path = str(file_path.relative_to(src_dir)).replace("\\", "/")
    module_name = python_module_name(src_dir, file_path)
    lines = text.splitlines()
    chunks: list[CodeChunk] = []

    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", SyntaxWarning)
            tree = ast.parse(text, filename=str(file_path))
    except SyntaxError:
        return chunks

    class PythonChunkVisitor(ast.NodeVisitor):
        def __init__(self) -> None:
            self.class_stack: list[str] = []
            self.function_stack: list[str] = []

        def visit_ClassDef(self, node: ast.ClassDef) -> None:
            self.class_stack.append(node.name)
            self.generic_visit(node)
            self.class_stack.pop()

        def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
            self._visit_function(node)

        def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:
            self._visit_function(node)

        def _visit_function(self, node: ast.FunctionDef | ast.AsyncFunctionDef) -> None:
            start_line = int(getattr(node, "lineno", 1) or 1)
            end_line = int(getattr(node, "end_lineno", start_line) or start_line)
            code = "\n".join(lines[start_line - 1 : end_line]).strip()
            if code:
                symbol_parts = [module_name] + self.class_stack + self.function_stack + [node.name]
                symbol = ".".join(part for part in symbol_parts if part)
                class_name = ".".join(self.class_stack) if self.class_stack else module_name
                chunks.append(
                    CodeChunk(
                        repo_id=repo_id,
                        chunk_id=f"{repo_id}:{symbol}:{relative_path}:{start_line}",
                        symbol=symbol,
                        class_name=class_name,
                        method_name=node.name,
                        path=relative_path,
                        start_line=start_line,
                        end_line=end_line,
                        code=code,
                    )
                )

            self.function_stack.append(node.name)
            self.generic_visit(node)
            self.function_stack.pop()

    PythonChunkVisitor().visit(tree)
    return chunks


GENERIC_DECLARATION_RE = re.compile(
    r"""
    ^[ \t]*
    (?:
        (?:export\s+)?(?:default\s+)?
        (?P<class_kind>class|interface|enum|struct|trait|impl)\s+
        (?P<class_name>[A-Za-z_$][A-Za-z0-9_$]*)
        [^{;\n]*\{
      |
        (?:export\s+)?(?:default\s+)?
        (?:(?:public|private|protected|internal|static|final|async|virtual|override|extern|unsafe)\s+)*
        (?:
            (?:async\s+)?function\s+
          | fn\s+
          | (?:(?:[A-Za-z_$][A-Za-z0-9_$:<>\[\],.?*&]+\s+)+)
        )
        (?P<func_name>[A-Za-z_$][A-Za-z0-9_$]*)\s*
        \([^;{}]*\)\s*
        (?:[-=]>\s*[A-Za-z_$][A-Za-z0-9_$:<>\[\],.?*&\s]*)?
        \{
      |
        (?:export\s+)?
        (?:const|let|var)\s+
        (?P<arrow_name>[A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*
        (?:async\s*)?
        (?:\([^)]*\)|[A-Za-z_$][A-Za-z0-9_$]*)\s*=>\s*
        \{
    )
    """,
    re.MULTILINE | re.VERBOSE,
)


def generic_declaration_chunks(repo_id: str, src_dir: Path, file_path: Path) -> list[CodeChunk]:
    text = file_path.read_text(encoding="utf-8", errors="ignore")
    relative_path = str(file_path.relative_to(src_dir)).replace("\\", "/")
    stem = file_path.stem
    chunks: list[CodeChunk] = []
    seen: set[tuple[str, int]] = set()
    for match in GENERIC_DECLARATION_RE.finditer(text):
        open_brace = text.find("{", match.start(), match.end())
        if open_brace < 0:
            continue
        close_brace = find_matching_brace(text, open_brace)
        if close_brace <= open_brace:
            continue
        name = str(match.group("class_name") or match.group("func_name") or match.group("arrow_name") or "").strip()
        if not name or name in CONTROL_WORDS:
            continue
        start_line = line_number_at(text, match.start())
        end_line = line_number_at(text, close_brace)
        key = (name, start_line)
        if key in seen:
            continue
        seen.add(key)
        code = text[match.start() : close_brace + 1].strip()
        if not code:
            continue
        symbol = f"{stem}.{name}"
        chunks.append(
            CodeChunk(
                repo_id=repo_id,
                chunk_id=f"{repo_id}:{symbol}:{relative_path}:{start_line}",
                symbol=symbol,
                class_name=stem,
                method_name=name,
                path=relative_path,
                start_line=start_line,
                end_line=end_line,
                code=code[:20000],
            )
        )
    return chunks


HTML_UI_INTERACTIVE_TAGS = {"a", "button", "form", "input", "select", "textarea", "option", "label"}
HTML_UI_TEXT_ATTRS = ("aria-label", "title", "alt", "placeholder", "value", "name")


def html_ui_path_key(rel_path: str) -> str:
    clean_path = re.sub(r"[^A-Za-z0-9]+", "_", str(rel_path or "").replace("\\", "/")).strip("_")
    return clean_path or "html"


def html_ui_slug(value: str, fallback: str = "item", max_len: int = 48) -> str:
    clean_value = html_unescape(str(value or "")).strip()
    clean_value = re.sub(r"\s+", "_", clean_value)
    clean_value = re.sub(r"[^A-Za-z0-9_.$:-]+", "_", clean_value).strip("_")
    if not clean_value:
        clean_value = fallback
    if clean_value and clean_value[0].isdigit():
        clean_value = f"{fallback}_{clean_value}"
    return clean_value[:max_len] or fallback


def html_ui_symbol(rel_path: str, element_key: str) -> str:
    return f"{html_ui_path_key(rel_path)}.{html_ui_slug(element_key)}"


class HtmlUiChunkParser(HTMLParser):
    def __init__(self, repo_id: str, rel_path: str) -> None:
        super().__init__(convert_charrefs=True)
        self.repo_id = repo_id
        self.rel_path = rel_path
        self.elements: list[dict] = []
        self.current: dict | None = None

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        tag = tag.lower()
        attr = {str(key).lower(): str(value or "") for key, value in attrs}
        line_no, _ = self.getpos()
        is_interactive = (
            tag in HTML_UI_INTERACTIVE_TAGS
            or attr.get("onclick")
            or (tag in {"a", "area"} and attr.get("href"))
            or attr.get("role") == "button"
            or attr.get("type") in {"button", "submit", "reset"}
        )
        if not is_interactive:
            self.current = None
            return
        element_key = (
            attr.get("id")
            or attr.get("name")
            or attr.get("data-testid")
            or attr.get("aria-label")
            or attr.get("href")
            or f"{tag}_{line_no}"
        )
        element = {
            "tag": tag,
            "attrs": attr,
            "line": line_no,
            "text": "",
            "symbol": html_ui_symbol(self.rel_path, element_key),
            "element_key": element_key,
        }
        self.elements.append(element)
        self.current = element

    def handle_endtag(self, tag: str) -> None:
        if self.current and tag.lower() == self.current.get("tag"):
            self.current = None

    def handle_data(self, data: str) -> None:
        if self.current and data.strip():
            existing = self.current.get("text", "")
            self.current["text"] = f"{existing} {data.strip()}".strip()


def extract_html_ui_chunks(repo_id: str, src_dir: Path, file_path: Path) -> list[CodeChunk]:
    text = file_path.read_text(encoding="utf-8", errors="ignore")
    relative_path = str(file_path.relative_to(src_dir)).replace("\\", "/")
    parser = HtmlUiChunkParser(repo_id, relative_path)
    try:
        parser.feed(text)
    except Exception:
        return []
    chunks: list[CodeChunk] = []
    lines = text.splitlines()
    section_pattern = re.compile(
        r"(?is)<(?P<tag>section|main|article|aside|nav|header|footer|form|fieldset|dialog|div)\b(?P<attrs>[^>]*)>",
    )
    attr_pattern = re.compile(r"([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*(['\"])(.*?)\2", re.DOTALL)
    layout_role_pattern = re.compile(
        r"\b(section|panel|card|module|widget|feature|tool|block|tile|view|page|screen|"
        r"summary|settings|nav|tab|modal|dialog|hero|banner|content)\b",
        re.IGNORECASE,
    )
    seen_section_keys: set[str] = set()
    for match in section_pattern.finditer(text):
        attrs = {key.lower(): value.strip() for key, _, value in attr_pattern.findall(match.group("attrs") or "")}
        class_text = attrs.get("class", "")
        section_id = (
            attrs.get("id")
            or attrs.get("data-section")
            or attrs.get("data-feature")
            or attrs.get("data-title")
            or attrs.get("aria-label")
            or attrs.get("aria-labelledby")
            or attrs.get("role")
        )
        line_no = text.count("\n", 0, match.start()) + 1
        snippet = text[match.end(): match.end() + 6000]
        heading_match = re.search(r"(?is)<h[1-7]\b[^>]*>(.*?)</h[1-7]>", snippet)
        heading = ""
        if heading_match:
            heading = re.sub(r"<[^>]+>", " ", heading_match.group(1))
            heading = re.sub(r"\s+", " ", html_unescape(heading)).strip()
        if match.group("tag").lower() == "div":
            div_has_layout_role = bool(layout_role_pattern.search(class_text))
            if not heading and not attrs.get("aria-label") and not div_has_layout_role:
                continue
        if not section_id:
            section_id = heading or class_text or f"{match.group('tag').lower()}_{line_no}"
        visible = re.sub(r"(?is)<script\b.*?</script>|<style\b.*?</style>", " ", snippet)
        visible = re.sub(r"<[^>]+>", " ", visible)
        visible = re.sub(r"\s+", " ", html_unescape(visible)).strip()
        section_name = heading or attrs.get("aria-label") or section_id
        section_key = re.sub(r"\s+", " ", section_name).strip().lower()
        if section_key in seen_section_keys:
            continue
        seen_section_keys.add(section_key)
        symbol = html_ui_symbol(relative_path, section_id)
        code = "\n".join([
            f"HTML UI section: {section_name}",
            f"symbol: {symbol}",
            f"section id: {section_id}",
            f"tag: <{match.group('tag').lower()}>",
            f"class: {attrs.get('class', '')}",
            "visible text:",
            visible[:1800],
        ])
        chunks.append(
            CodeChunk(
                repo_id=repo_id,
                chunk_id=f"{repo_id}:{symbol}:{relative_path}:{line_no}:section",
                symbol=symbol,
                class_name=html_ui_path_key(relative_path),
                method_name=section_name,
                path=relative_path,
                start_line=line_no,
                end_line=line_no,
                code=code[:12000],
            )
        )
    for element in parser.elements:
        attrs = element.get("attrs", {})
        line_no = int(element.get("line") or 1)
        context_lines = "\n".join(lines[max(0, line_no - 2): min(len(lines), line_no + 3)])
        text_value = element.get("text") or next((attrs.get(key, "") for key in HTML_UI_TEXT_ATTRS if attrs.get(key)), "")
        code = "\n".join(
            part
            for part in (
                f"HTML UI element: <{element.get('tag')}>",
                f"symbol: {element.get('symbol')}",
                f"text: {text_value}",
                f"id: {attrs.get('id', '')}",
                f"name: {attrs.get('name', '')}",
                f"role: {attrs.get('role', '')}",
                f"type: {attrs.get('type', '')}",
                f"href: {attrs.get('href', '')}",
                f"action: {attrs.get('action', '')}",
                f"onclick: {attrs.get('onclick', '')}",
                "source context:",
                context_lines,
            )
            if part is not None
        )
        chunks.append(
            CodeChunk(
                repo_id=repo_id,
                chunk_id=f"{repo_id}:{element.get('symbol')}:{relative_path}:{line_no}",
                symbol=str(element.get("symbol")),
                class_name=html_ui_path_key(relative_path),
                method_name=str(element.get("element_key") or element.get("tag") or "element"),
                path=relative_path,
                start_line=line_no,
                end_line=line_no,
                code=code[:12000],
            )
        )
    return chunks


def extract_chunks(
    repo_id: str,
    src_dir: Path,
    max_chunks: int = DEFAULT_MAX_CHUNKS_PER_REPO,
    max_file_bytes: int = DEFAULT_MAX_FILE_BYTES,
    progress_callback=None,
) -> list[CodeChunk]:
    chunks: list[CodeChunk] = []
    processed_files = 0
    for path in src_dir.rglob("*"):
        if not path.is_file() or should_skip_source_path(path, src_dir) or looks_like_browser_metadata_file(path) or path.suffix.lower() not in TEXT_EXTENSIONS:
            continue
        try:
            processed_files += 1
            if progress_callback and (processed_files == 1 or processed_files % 25 == 0):
                rel_path = str(path.relative_to(src_dir)).replace("\\", "/")
                progress_callback(
                    f"Building search index from source file {processed_files}.",
                    current_file=rel_path,
                )
            if max_file_bytes > 0 and path.stat().st_size > max_file_bytes:
                continue
            if path.suffix.lower() == ".java":
                found = extract_java_chunks(repo_id, src_dir, path)
                chunks.extend(found)
            elif path.suffix.lower() == ".py":
                found = extract_python_chunks(repo_id, src_dir, path)
                chunks.extend(found)
            elif path.suffix.lower() in HTML_SOURCE_EXTENSIONS and path.suffix.lower() in TEXT_EXTENSIONS:
                found = extract_html_ui_chunks(repo_id, src_dir, path)
                chunks.extend(found)
            elif path.suffix.lower() in CODE_SOURCE_EXTENSIONS:
                chunks.extend(generic_declaration_chunks(repo_id, src_dir, path))
            else:
                continue
        except OSError:
            continue
        if max_chunks > 0 and len(chunks) >= max_chunks:
            return chunks[:max_chunks]
    return chunks


def simplify_symbol(symbol: str, preserve_qualified: bool = False) -> str:
    """Normalize extractor-specific symbols to the Class.method shape."""
    symbol = symbol.strip()
    if not symbol:
        return symbol
    symbol = symbol.split(":", 1)[0]
    symbol = symbol.replace("$", ".")
    if preserve_qualified:
        return symbol
    parts = [part for part in symbol.split(".") if part]
    if len(parts) >= 2:
        return f"{parts[-2]}.{parts[-1]}"
    return symbol


GENERATED_GRAPH_FILENAMES = {
    "search_graph.json",
    "file_graph.json",
    "html_ui_graph.json",
    "ga_analysis_graph.json",
    "ga_ordered_interaction_graph.json",
    "ga_navigatable_ordered_graph.json",
    "daily_commit_graph.json",
    "daily_change_graph.json",
}


def discover_graph_files(repo: Path) -> list[Path]:
    candidates = [repo / name for name in GENERATED_GRAPH_FILENAMES]
    for graph_dir_name in ("python", "javascript", "java_merged", "tree_sitter_java", "file_graph", "html_ui", "javalang", "joern", "search"):
        graph_dir = repo / graph_dir_name
        if graph_dir.exists():
            candidates.extend(sorted(graph_dir.rglob("*.json")))

    selected: list[Path] = []
    seen: set[Path] = set()
    for path in candidates:
        if not path.exists() or path in seen:
            continue
        lower_name = path.name.lower()
        if "comments" in lower_name or "functions" in lower_name or "roots" in lower_name:
            continue
        if "callgraph" in lower_name or lower_name in GENERATED_GRAPH_FILENAMES or lower_name.endswith("_cfg.json"):
            selected.append(path)
            seen.add(path)
    return selected


def discover_generic_graph_files(repo: Path) -> list[Path]:
    candidates = discover_graph_files(repo)
    candidates.extend(sorted(repo.glob("*graph*.json")))
    for graph_dir_name in ("python", "javascript", "java_merged", "tree_sitter_java", "file_graph", "html_ui", "javalang", "joern", "search"):
        graph_dir = repo / graph_dir_name
        if graph_dir.exists():
            candidates.extend(sorted(graph_dir.rglob("*.json")))

    selected: list[Path] = []
    seen: set[Path] = set()
    for path in candidates:
        if not path.exists() or path in seen:
            continue
        lower_name = path.name.lower()
        if "comments" in lower_name or "functions" in lower_name or "roots" in lower_name:
            continue
        if (
            "callgraph" in lower_name
            or lower_name in GENERATED_GRAPH_FILENAMES
            or lower_name.endswith("_cfg.json")
            or lower_name == "cfg.json"
        ):
            selected.append(path)
            seen.add(path)
    return selected


def load_edges(graph_file: Path, repo: Path) -> list[GraphEdge]:
    if not graph_file.exists():
        return []
    data = json.loads(graph_file.read_text(encoding="utf-8", errors="ignore"))
    edges: list[GraphEdge] = []
    graph_file_name = str(graph_file.relative_to(repo)).replace("\\", "/")
    preserve_qualified = "python_callgraph" in graph_file.name.lower()

    def add_edge(raw_source: object, raw_target: object) -> None:
        source = simplify_symbol(str(raw_source), preserve_qualified=preserve_qualified)
        target = simplify_symbol(str(raw_target), preserve_qualified=preserve_qualified)
        if source and target and source != target:
            edges.append(
                GraphEdge(
                    source=source,
                    target=target,
                    raw_source=str(raw_source),
                    raw_target=str(raw_target),
                    graph_file=graph_file_name,
                )
            )

    if isinstance(data, list):
        for item in data:
            if isinstance(item, list) and len(item) >= 2:
                add_edge(item[0], item[1])
            elif isinstance(item, dict) and isinstance(item.get("data"), dict) and item["data"].get("source") and item["data"].get("target"):
                add_edge(item["data"]["source"], item["data"]["target"])
            elif isinstance(item, dict) and "source" in item and "target" in item:
                add_edge(item["source"], item["target"])
            elif isinstance(item, dict) and "caller" in item and "callee" in item:
                add_edge(item["caller"], item["callee"])
            elif isinstance(item, dict) and "from" in item and "to" in item:
                add_edge(item["from"], item["to"])
    elif isinstance(data, dict):
        for item in data.get("edges", []) or []:
            if isinstance(item, dict):
                item_data = item.get("data") if isinstance(item.get("data"), dict) else item
                source = item_data.get("source") or item_data.get("from") or item_data.get("caller")
                target = item_data.get("target") or item_data.get("to") or item_data.get("callee")
                if source and target:
                    add_edge(source, target)
            elif isinstance(item, list) and len(item) >= 2:
                add_edge(item[0], item[1])
    return edges


def load_generic_edges(graph_file: Path, repo: Path) -> list[GraphEdge]:
    if not graph_file.exists():
        return []
    data = json.loads(graph_file.read_text(encoding="utf-8", errors="ignore"))
    edges = load_edges(graph_file, repo)
    graph_file_name = str(graph_file.relative_to(repo)).replace("\\", "/")
    preserve_qualified = "python_callgraph" in graph_file.name.lower()

    def add_edge(raw_source: object, raw_target: object) -> None:
        source = simplify_symbol(str(raw_source), preserve_qualified=preserve_qualified)
        target = simplify_symbol(str(raw_target), preserve_qualified=preserve_qualified)
        if source and target and source != target:
            edges.append(
                GraphEdge(
                    source=source,
                    target=target,
                    raw_source=str(raw_source),
                    raw_target=str(raw_target),
                    graph_file=graph_file_name,
                )
            )

    if isinstance(data, list):
        for item in data:
            if not isinstance(item, dict):
                continue
            item_data = item.get("data")
            if isinstance(item_data, dict):
                source = item_data.get("source") or item_data.get("from") or item_data.get("caller")
                target = item_data.get("target") or item_data.get("to") or item_data.get("callee")
                if source and target:
                    add_edge(source, target)
            method = item.get("method")
            calls = item.get("calls")
            if method and isinstance(calls, list):
                for call in calls:
                    if not isinstance(call, dict):
                        continue
                    callee = call.get("callee_fullName") or call.get("callee") or call.get("call_name")
                    call_name = str(call.get("call_name") or "")
                    if callee and not call_name.startswith("<operator>") and not str(callee).startswith("<operator>"):
                        add_edge(method, callee)
    elif isinstance(data, dict):
        graph_items = (data.get("elements", []) or data.get("nodes", []) or []) + (data.get("edges", []) or [])
        for item in graph_items:
            if not isinstance(item, dict):
                continue
            item_data = item.get("data")
            if isinstance(item_data, dict) and item_data.get("source") and item_data.get("target"):
                add_edge(item_data["source"], item_data["target"])
    return edges


def load_repo_edges(repo: Path) -> tuple[list[GraphEdge], list[str]]:
    all_edges: list[GraphEdge] = []
    graph_files = discover_graph_files(repo)
    for graph_file in graph_files:
        all_edges.extend(load_edges(graph_file, repo))

    deduped: dict[tuple[str, str, str], GraphEdge] = {}
    for edge in all_edges:
        deduped[(edge.source, edge.target, edge.graph_file)] = edge
    return list(deduped.values()), [str(path.relative_to(repo)).replace("\\", "/") for path in graph_files]


def load_generic_repo_edges(repo: Path) -> tuple[list[GraphEdge], list[str]]:
    all_edges: list[GraphEdge] = []
    graph_files = discover_generic_graph_files(repo)
    for graph_file in graph_files:
        if graph_file.name.lower().endswith("_cfg.json") or graph_file.name.lower() == "cfg.json":
            continue
        all_edges.extend(load_generic_edges(graph_file, repo))

    deduped: dict[tuple[str, str, str], GraphEdge] = {}
    for edge in all_edges:
        deduped[(edge.source, edge.target, edge.graph_file)] = edge
    return list(deduped.values()), [str(path.relative_to(repo)).replace("\\", "/") for path in graph_files]


def weak_components(nodes: list[str], out_edges: dict[str, set[str]], in_edges: dict[str, set[str]]) -> dict[str, int]:
    component_id: dict[str, int] = {}
    component = 0
    for node in nodes:
        if node in component_id:
            continue
        queue = deque([node])
        component_id[node] = component
        while queue:
            current = queue.popleft()
            for neighbor in out_edges[current] | in_edges[current]:
                if neighbor not in component_id:
                    component_id[neighbor] = component
                    queue.append(neighbor)
        component += 1
    return component_id


def pagerank(nodes: list[str], out_edges: dict[str, set[str]], iterations: int = 30, damping: float = 0.85) -> dict[str, float]:
    if not nodes:
        return {}
    score = {node: 1.0 / len(nodes) for node in nodes}
    base = (1.0 - damping) / len(nodes)
    for _ in range(iterations):
        next_score = {node: base for node in nodes}
        dangling = sum(score[node] for node in nodes if not out_edges[node])
        dangling_share = damping * dangling / len(nodes)
        for node in nodes:
            next_score[node] += dangling_share
            if out_edges[node]:
                share = damping * score[node] / len(out_edges[node])
                for target in out_edges[node]:
                    next_score[target] += share
        score = next_score
    return score


def build_graph_stats(
    edges: list[GraphEdge],
    extra_nodes: Iterable[str],
    cfg_tokens: dict[str, list[str]] | None = None,
) -> GraphStats:
    node_set = set(extra_nodes)
    for edge in edges:
        node_set.add(edge.source)
        node_set.add(edge.target)
    nodes = sorted(node_set)
    out_edges = {node: set() for node in nodes}
    in_edges = {node: set() for node in nodes}
    for edge in edges:
        out_edges.setdefault(edge.source, set()).add(edge.target)
        in_edges.setdefault(edge.target, set()).add(edge.source)
        out_edges.setdefault(edge.target, set())
        in_edges.setdefault(edge.source, set())
    return GraphStats(
        nodes=nodes,
        out_edges=out_edges,
        in_edges=in_edges,
        pagerank=pagerank(nodes, out_edges),
        component_id=weak_components(nodes, out_edges, in_edges),
        cfg_tokens=cfg_tokens or {},
    )


def bucket_count(value: int) -> str:
    if value <= 0:
        return "0"
    if value == 1:
        return "1"
    if value <= 3:
        return "2_3"
    if value <= 7:
        return "4_7"
    if value <= 15:
        return "8_15"
    if value <= 31:
        return "16_31"
    return "32_plus"


def cfg_code_kind(code: str) -> str:
    stripped = code.strip()
    lower = stripped.lower()
    if not stripped or stripped == "<empty>":
        return "empty"
    if stripped == "RET" or lower.startswith("return"):
        return "return"
    if lower.startswith("if") or " ? " in stripped:
        return "branch"
    if lower.startswith(("for", "while", "do ")):
        return "loop"
    if lower.startswith("switch"):
        return "switch"
    if lower.startswith("try"):
        return "try"
    if lower.startswith("catch"):
        return "catch"
    if lower.startswith("throw"):
        return "throw"
    if "new " in stripped:
        return "alloc"
    if "=" in stripped:
        return "assign"
    if "(" in stripped and ")" in stripped:
        return "callish"
    return "other"


def line_number(raw_line: object) -> int | None:
    match = re.search(r"\d+", str(raw_line))
    return int(match.group(0)) if match else None


def load_cfg_tokens(repo: Path, chunks: list[CodeChunk]) -> dict[str, list[str]]:
    cfg_files = [
        path
        for path in discover_generic_graph_files(repo)
        if path.name.lower().endswith("_cfg.json") or path.name.lower() == "cfg.json"
    ]
    if not cfg_files or not chunks:
        return {}

    line_index: dict[int, list[CodeChunk]] = defaultdict(list)
    for chunk in chunks:
        for line in range(chunk.start_line, chunk.end_line + 1):
            line_index[line].append(chunk)

    per_symbol_counts: dict[str, Counter[str]] = defaultdict(Counter)
    for cfg_file in cfg_files:
        try:
            data = json.loads(cfg_file.read_text(encoding="utf-8", errors="ignore"))
        except (OSError, json.JSONDecodeError):
            continue
        if not isinstance(data, list):
            continue
        graph_file_name = str(cfg_file.relative_to(repo)).replace("\\", "/")
        for item in data:
            if not isinstance(item, dict):
                continue
            line = line_number(item.get("line"))
            if line is None:
                continue
            code = str(item.get("code") or "")
            kind = cfg_code_kind(code)
            candidates = line_index.get(line, [])
            if not candidates:
                continue
            meaningful_code = code.strip() and code.strip() not in {"<empty>", "RET"}
            for chunk in candidates:
                if meaningful_code and len(code.strip()) > 2 and code.strip() not in chunk.code:
                    continue
                per_symbol_counts[chunk.symbol][f"cfg_kind:{kind}"] += 1
                per_symbol_counts[chunk.symbol][f"cfg_file:{graph_file_name}"] += 1

    tokens: dict[str, list[str]] = {}
    for symbol, counts in per_symbol_counts.items():
        symbol_tokens: list[str] = []
        for key, count in sorted(counts.items()):
            if key.startswith("cfg_file:"):
                symbol_tokens.append(key)
            else:
                symbol_tokens.append(f"{key}_bucket:{bucket_count(count)}")
        tokens[symbol] = symbol_tokens
    return tokens


def graph_tokens(symbol: str, stats: GraphStats) -> list[str]:
    callers = stats.in_edges.get(symbol, set())
    callees = stats.out_edges.get(symbol, set())
    tokens = [
        f"node:{symbol}",
        f"class:{symbol.split('.')[0] if '.' in symbol else symbol}",
        f"out_degree:{len(callees)}",
        f"in_degree:{len(callers)}",
        f"component:{stats.component_id.get(symbol, -1)}",
        f"pagerank_bucket:{int(stats.pagerank.get(symbol, 0.0) * 10000)}",
    ]
    tokens.extend(f"calls:{target}" for target in sorted(callees))
    tokens.extend(f"called_by:{source}" for source in sorted(callers))
    for neighbor in sorted(callees):
        tokens.extend(f"calls2:{target}" for target in sorted(stats.out_edges.get(neighbor, set())))
    for neighbor in sorted(callers):
        tokens.extend(f"called_by2:{source}" for source in sorted(stats.in_edges.get(neighbor, set())))
    tokens.extend(stats.cfg_tokens.get(symbol, []))
    return tokens


def repo_dirs(input_root: Path) -> list[Path]:
    if (input_root / "search_graph.json").exists() and (input_root / "src").exists():
        return [input_root]
    return sorted(
        path
        for path in input_root.iterdir()
        if path.is_dir() and (path / "search_graph.json").exists() and (path / "src").exists()
    )


def generic_repo_dirs(input_root: Path) -> list[Path]:
    if (input_root / "src").exists():
        return [input_root]
    if looks_like_source_root(input_root):
        return [input_root]
    return sorted(path for path in input_root.iterdir() if path.is_dir() and (path / "src").exists())


def looks_like_source_root(path: Path) -> bool:
    if not path.exists() or not path.is_dir():
        return False
    for candidate in path.rglob("*"):
        if candidate.is_file() and candidate.suffix.lower() in TEXT_EXTENSIONS and not should_skip_source_path(candidate, path) and not looks_like_browser_metadata_file(candidate):
            return True
    return False


def repo_source_dir(repo: Path) -> Path:
    src_dir = repo / "src"
    return src_dir if src_dir.exists() else repo


def resolve_dataset_dir(dataset_dir: Path) -> Path:
    if dataset_dir.exists():
        return dataset_dir
    script_relative = SCRIPT_DIR / dataset_dir
    if script_relative.exists():
        return script_relative
    raise FileNotFoundError(
        f"Dataset folder not found: {dataset_dir}. "
        f"Try an absolute path or run from {SCRIPT_DIR}."
    )


def vector_to_blob(values: list[float]) -> bytes:
    return np.asarray(values, dtype=np.float32).tobytes()


def blob_to_vector(blob: bytes) -> np.ndarray:
    return np.frombuffer(blob, dtype=np.float32)


def init_vector_db(db_path: Path) -> sqlite3.Connection:
    if db_path.exists():
        db_path.unlink()
    connection = sqlite3.connect(db_path)
    connection.execute(
        """
        CREATE TABLE vectors (
            chunk_id TEXT PRIMARY KEY,
            repo_id TEXT NOT NULL,
            symbol TEXT NOT NULL,
            path TEXT NOT NULL,
            start_line INTEGER NOT NULL,
            end_line INTEGER NOT NULL,
            embedding BLOB NOT NULL,
            metadata TEXT NOT NULL
        )
        """
    )
    connection.execute("CREATE INDEX idx_vectors_symbol ON vectors(symbol)")
    return connection


def insert_vector(connection: sqlite3.Connection, record: dict) -> None:
    metadata = {
        key: value
        for key, value in record.items()
        if key not in {"code_embedding", "graph_embedding", "source_embedding", "fused_embedding", "code"}
    }
    connection.execute(
        """
        INSERT OR REPLACE INTO vectors
        (chunk_id, repo_id, symbol, path, start_line, end_line, embedding, metadata)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            record["chunk_id"],
            record["repo_id"],
            record["symbol"],
            record["path"],
            record["start_line"],
            record["end_line"],
            vector_to_blob(record["source_embedding"]),
            json.dumps(metadata),
        ),
    )


def write_faiss_index(output_dir: Path, vector_rows: list[dict]) -> Path | None:
    if faiss is None or not vector_rows:
        return None
    matrix = np.asarray([row["embedding"] for row in vector_rows], dtype=np.float32)
    faiss.normalize_L2(matrix)
    index = faiss.IndexFlatIP(matrix.shape[1])
    index.add(matrix)
    index_path = output_dir / "vectors.faiss"
    metadata_path = output_dir / "vectors.faiss.jsonl"
    faiss.write_index(index, str(index_path))
    with metadata_path.open("w", encoding="utf-8") as handle:
        for row in vector_rows:
            metadata = {key: value for key, value in row.items() if key != "embedding"}
            handle.write(json.dumps(metadata, ensure_ascii=False) + "\n")
    return index_path


def write_dataset(
    input_root: Path,
    output_dir: Path,
    include_code: bool,
    backend: str,
    make_vector_db: bool,
    make_faiss: bool,
    sbert_model: str | None,
    batch_size: int,
    generic_graphs: bool = False,
    max_chunks_per_repo: int = DEFAULT_MAX_CHUNKS_PER_REPO,
    max_file_bytes: int = DEFAULT_MAX_FILE_BYTES,
    max_record_code_chars: int = DEFAULT_MAX_RECORD_CODE_CHARS,
    progress_callback=None,
    owner=None,
    repo=None,
) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    architecture_dir = output_dir.parent / "architecture" if output_dir.name == "scim" else output_dir / "architecture"
    architecture_dir.mkdir(parents=True, exist_ok=True)
    functions_path = output_dir / "functions.jsonl"
    nodes_path = architecture_dir / "nodes.csv"
    edges_path = architecture_dir / "edges.csv"
    train_path = architecture_dir / "train_pairs.jsonl"
    model_path = output_dir / "embedding_model.json"
    vector_db_path = output_dir / "vectors.sqlite"

    repo_payloads = []
    code_documents: list[list[str]] = []
    graph_documents: list[list[str]] = []

    repos = generic_repo_dirs(input_root) if generic_graphs else repo_dirs(input_root)
    for repo in repos:
        repo_id = repo.name
        src_dir = repo_source_dir(repo)
        if progress_callback:
            progress_callback("Building search index from source files.", current_file="")
        chunks = extract_chunks(repo_id, src_dir, max_chunks_per_repo, max_file_bytes, progress_callback=progress_callback)
        if progress_callback:
            progress_callback(f"Search index collected {len(chunks)} code items. Building graph-aware embeddings.", current_file="")
        if generic_graphs:
            edges, graph_files = load_generic_repo_edges(repo)
            stats = build_graph_stats(edges, (chunk.symbol for chunk in chunks), load_cfg_tokens(repo, chunks))
        else:
            edges, graph_files = load_repo_edges(repo)
            stats = build_graph_stats(edges, (chunk.symbol for chunk in chunks))
        repo_payloads.append((repo, repo_id, chunks, edges, graph_files, stats))
        code_documents.extend(tokenize_code(chunk_search_document(chunk)) for chunk in chunks)
        graph_documents.extend(graph_tokens(chunk.symbol, stats) for chunk in chunks)

    embedding_model = train_embedding_model(code_documents, graph_documents, backend, sbert_model)
    embedding_model.save(model_path)
    code_documents.clear()
    graph_documents.clear()
    gc.collect()
    if progress_callback:
        progress_callback("Writing searchable code and callgraph model.", current_file="")

    vector_connection = init_vector_db(vector_db_path) if make_vector_db else None
    faiss_rows: list[dict] = []

    summaries = []
    total_chunks = 0
    total_edges = 0
    chunks_with_callgraph_edges = 0
    
    with (
        functions_path.open("w", encoding="utf-8") as functions_file,
        nodes_path.open("w", newline="", encoding="utf-8") as nodes_file,
        edges_path.open("w", newline="", encoding="utf-8") as edges_file,
        train_path.open("w", encoding="utf-8") as train_file,
    ):
        node_writer = csv.DictWriter(
            nodes_file,
            fieldnames=[
                "repo_id",
                "symbol",
                "path",
                "start_line",
                "end_line",
                "in_degree",
                "out_degree",
                "pagerank",
                "component_id",
            ],
        )
        edge_writer = csv.DictWriter(
            edges_file,
            fieldnames=["repo_id", "source", "target", "graph_file", "raw_source", "raw_target"],
        )
        node_writer.writeheader()
        edge_writer.writeheader()

        for repo, repo_id, chunks, edges, graph_files, stats in repo_payloads:
            symbol_to_chunks = defaultdict(list)
            for chunk in chunks:
                symbol_to_chunks[chunk.symbol].append(chunk)

            total_chunks += len(chunks)
            total_edges += len(edges)
            chunks_with_callgraph_edges += sum(
                1
                for chunk in chunks
                if stats.out_edges.get(chunk.symbol, set()) or stats.in_edges.get(chunk.symbol, set())
            )

            for edge in edges:
                edge_writer.writerow(
                    {
                        "repo_id": repo_id,
                        "source": edge.source,
                        "target": edge.target,
                        "graph_file": edge.graph_file,
                        "raw_source": edge.raw_source,
                        "raw_target": edge.raw_target,
                    }
                )

            if backend == "tfidf":
                code_embeddings = (
                    embedding_model.embed_code(chunk_search_document(chunk))
                    for chunk in chunks
                )
            else:
                code_embeddings = embedding_model.embed_code_batch(
                    [chunk_search_document(chunk) for chunk in chunks],
                    batch_size=batch_size,
                )
            for chunk, code_embedding in zip(chunks, code_embeddings):
                graph_embedding = embedding_model.embed_graph(graph_tokens(chunk.symbol, stats))
                fused_embedding = code_embedding + graph_embedding

                record = {
                    "repo_id": repo_id,
                    "chunk_id": chunk.chunk_id,
                    "symbol": chunk.symbol,
                    "class_name": chunk.class_name,
                    "method_name": chunk.method_name,
                    "path": chunk.path,
                    "start_line": chunk.start_line,
                    "end_line": chunk.end_line,
                    "line_count": chunk.end_line - chunk.start_line + 1,
                    "in_degree": len(stats.in_edges.get(chunk.symbol, set())),
                    "out_degree": len(stats.out_edges.get(chunk.symbol, set())),
                    "callers": sorted(stats.in_edges.get(chunk.symbol, set()))[:40],
                    "callees": sorted(stats.out_edges.get(chunk.symbol, set()))[:40],
                    "pagerank": stats.pagerank.get(chunk.symbol, 0.0),
                    "component_id": stats.component_id.get(chunk.symbol, -1),
                    "code_embedding": code_embedding,
                    "graph_embedding": graph_embedding,
                    "source_embedding": code_embedding + [0.0] * embedding_model.graph_dim,
                    "fused_embedding": fused_embedding,
                }
                if include_code:
                    record["code"] = chunk.code[:max_record_code_chars] if max_record_code_chars > 0 else chunk.code
                functions_file.write(json.dumps(record, ensure_ascii=False) + "\n")
                if vector_connection is not None:
                    insert_vector(vector_connection, record)
                if make_faiss:
                    faiss_rows.append(
                        {
                            "chunk_id": chunk.chunk_id,
                            "repo_id": repo_id,
                            "symbol": chunk.symbol,
                            "path": chunk.path,
                            "start_line": chunk.start_line,
                            "end_line": chunk.end_line,
                            "embedding": record["source_embedding"],
                        }
                    )

                node_writer.writerow(
                    {
                        "repo_id": repo_id,
                        "symbol": chunk.symbol,
                        "path": chunk.path,
                        "start_line": chunk.start_line,
                        "end_line": chunk.end_line,
                        "in_degree": len(stats.in_edges.get(chunk.symbol, set())),
                        "out_degree": len(stats.out_edges.get(chunk.symbol, set())),
                        "pagerank": f"{stats.pagerank.get(chunk.symbol, 0.0):.12f}",
                        "component_id": stats.component_id.get(chunk.symbol, -1),
                    }
                )

                train_record = {
                    "prompt": f"Summarize the role of {chunk.symbol} in this codebase.",
                    "symbol": chunk.symbol,
                    "repo_id": repo_id,
                    "context": {
                        "path": chunk.path,
                        "callers": sorted(stats.in_edges.get(chunk.symbol, set()))[:20],
                        "callees": sorted(stats.out_edges.get(chunk.symbol, set()))[:20],
                    },
                    "embedding": fused_embedding,
                }
                if include_code:
                    train_record["code"] = chunk.code[:max_record_code_chars] if max_record_code_chars > 0 else chunk.code
                train_file.write(json.dumps(train_record, ensure_ascii=False) + "\n")

            summaries.append(
                {
                    "repo_id": repo_id,
                    "repo_path": str(repo),
                    "chunks": len(chunks),
                    "graph_nodes": len(stats.nodes),
                    "graph_edges": len(edges),
                    "graph_files": graph_files,
                    "avg_in_degree": statistics.fmean(len(stats.in_edges[node]) for node in stats.nodes) if stats.nodes else 0,
                    "avg_out_degree": statistics.fmean(len(stats.out_edges[node]) for node in stats.nodes) if stats.nodes else 0,
                }
            )

    faiss_index_path = write_faiss_index(output_dir, faiss_rows) if make_faiss else None

    manifest = {
        "extractor_version": SCIM_EXTRACTOR_VERSION,
        "input_root": str(input_root),
        "output_dir": str(output_dir),
        "model_scope": "generic_multi_repo" if generic_graphs else "dataset_specific",
        "generic_graphs": generic_graphs,
        "embedding_backend": backend,
        "sbert_model": sbert_model if backend == "sbert" else None,
        "code_embedding_dim": embedding_model.code_dim,
        "graph_embedding_dim": embedding_model.graph_dim,
        "fused_embedding_dim": embedding_model.fused_dim,
        "vector_embedding_policy": "code_unit_embedding_with_zero_graph_padding",
        "vector_embedding_note": "vectors.sqlite stores code-unit embeddings only: functions, methods, classes, and docstrings/inline comments contained inside those units. Whole-file text, README/docs/config files, generated artifacts, and graph outputs are not embedded.",
        "repos": summaries,
        "totals": {
            "repos": len(summaries),
            "chunks": total_chunks,
            "edges": total_edges,
            "chunks_with_callgraph_edges": chunks_with_callgraph_edges,
        },
        "limits": {
            "max_chunks_per_repo": max_chunks_per_repo,
            "max_file_bytes": max_file_bytes,
            "max_record_code_chars": max_record_code_chars,
        },
        "files": {
            "functions": str(functions_path),
            "nodes": str(nodes_path),
            "edges": str(edges_path),
            "train_pairs": str(train_path),
            "embedding_model": str(model_path),
            "vector_db": str(vector_db_path) if make_vector_db else None,
            "faiss_index": str(faiss_index_path) if faiss_index_path else None,
            "faiss_metadata": str(output_dir / "vectors.faiss.jsonl") if faiss_index_path else None,
        },
    }
    (architecture_dir / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    if vector_connection is not None:
        vector_connection.commit()
        vector_connection.close()


def architecture_dataset_path(dataset_dir: Path, name: str) -> Path:
    dataset_dir = Path(dataset_dir)
    architecture_path = dataset_dir.parent / "architecture" / name if dataset_dir.name == "scim" else dataset_dir / "architecture" / name
    if architecture_path.exists():
        return architecture_path
    return dataset_dir / name


def cosine(left: list[float], right: list[float]) -> float:
    return sum(a * b for a, b in zip(left, right))


def cosine_np(left: np.ndarray, right: np.ndarray) -> float:
    denominator = float(np.linalg.norm(left) * np.linalg.norm(right))
    if not denominator:
        return 0.0
    return float(np.dot(left, right) / denominator)


def search_dataset(dataset_dir: Path, query: str, limit: int) -> None:
    dataset_dir = resolve_dataset_dir(dataset_dir)
    model_path = dataset_dir / "embedding_model.json"
    if model_path.exists():
        model = EmbeddingModel.load(model_path)
        query_embedding = model.embed_query(query)
    else:
        query_embedding = hashed_embedding(tokenize_code(query), CODE_DIM, "code") + hashed_embedding(
            tokenize_code(query), GRAPH_DIM, "graph"
        )

    vector_db_path = dataset_dir / "vectors.sqlite"
    faiss_index_path = dataset_dir / "vectors.faiss"
    faiss_metadata_path = dataset_dir / "vectors.faiss.jsonl"
    if faiss is not None and faiss_index_path.exists() and faiss_metadata_path.exists():
        query_vector = np.asarray([query_embedding], dtype=np.float32)
        faiss.normalize_L2(query_vector)
        index = faiss.read_index(str(faiss_index_path))
        scores, indices = index.search(query_vector, limit)
        metadata: list[dict] = []
        with faiss_metadata_path.open("r", encoding="utf-8") as handle:
            for line in handle:
                metadata.append(json.loads(line))
        for score, index_id in zip(scores[0], indices[0]):
            if index_id < 0:
                continue
            record = metadata[int(index_id)]
            print(f"{float(score):.4f}  {record['repo_id']}  {record['symbol']}  {record['path']}:{record['start_line']}")
        return

    if vector_db_path.exists():
        query_vector = np.asarray(query_embedding, dtype=np.float32)
        scored = []
        with sqlite3.connect(vector_db_path) as connection:
            rows = connection.execute(
                "SELECT repo_id, symbol, path, start_line, embedding FROM vectors"
            )
            for repo_id, symbol, path, start_line, blob in rows:
                scored.append((cosine_np(query_vector, blob_to_vector(blob)), repo_id, symbol, path, start_line))
        for score, repo_id, symbol, path, start_line in sorted(scored, key=lambda item: item[0], reverse=True)[:limit]:
            print(f"{score:.4f}  {repo_id}  {symbol}  {path}:{start_line}")
        return

    scored = []
    with (dataset_dir / "functions.jsonl").open("r", encoding="utf-8") as handle:
        for line in handle:
            record = json.loads(line)
            scored.append((cosine(query_embedding, record["fused_embedding"]), record))
    for score, record in sorted(scored, key=lambda item: item[0], reverse=True)[:limit]:
        print(f"{score:.4f}  {record['repo_id']}  {record['symbol']}  {record['path']}:{record['start_line']}")


SCIM_FEATURE_CATALOG_RECORD_LIMIT = int(os.getenv("SCIM_FEATURE_CATALOG_RECORD_LIMIT", "1500") or "1500")
SCIM_FEATURE_HYPOTHESIS_RECORD_LIMIT = int(os.getenv("SCIM_FEATURE_HYPOTHESIS_RECORD_LIMIT", "600") or "600")
SCIM_FEATURE_HYPOTHESIS_LIMIT = int(os.getenv("SCIM_FEATURE_HYPOTHESIS_LIMIT", "40") or "40")
SCIM_FEATURE_RECORD_CODE_CHARS = int(os.getenv("SCIM_FEATURE_RECORD_CODE_CHARS", "900") or "900")


def feature_record_priority(record: dict) -> tuple[int, int, int, int]:
    path = str(record.get("path", "")).lower()
    symbol = str(record.get("symbol", "")).lower()
    method_name = str(record.get("method_name", "")).lower()
    code = str(record.get("code", ""))[:500]
    degree = int(record.get("in_degree", 0) or 0) + int(record.get("out_degree", 0) or 0)
    ui_or_api = int(
        path.endswith((".html", ".htm", ".jsx", ".tsx", ".vue", ".svelte", ".xml"))
        or bool(re.search(r"(?m)^\s*@\s*(app|router)\s*\.\s*(get|post|put|delete|patch|route|websocket)\s*\(", code))
        or bool(re.search(r"\b(route|endpoint|controller|handler|component|view|page|panel|dashboard|screen)\b", f"{path} {symbol} {method_name}"))
    )
    file_anchor = int(symbol.endswith(".<file>") or method_name == "<file>")
    line_count = int(record.get("line_count", 0) or 0)
    return (ui_or_api, degree, file_anchor, -line_count)


def load_feature_records(dataset_dir: Path, repo_id: str | None, include_embeddings: bool = False) -> list[dict]:
    dataset_dir = resolve_dataset_dir(dataset_dir)
    records: list[dict] = []
    max_records = 0 if include_embeddings else max(0, SCIM_FEATURE_CATALOG_RECORD_LIMIT)
    min_priority: tuple[int, int, int, int] | None = None
    min_index = -1

    def add_record(record: dict):
        nonlocal min_priority, min_index
        if not include_embeddings:
            record.pop("fused_embedding", None)
            record.pop("embedding", None)
            record.pop("cfg_embedding", None)
            record.pop("text_embedding", None)
            if SCIM_FEATURE_RECORD_CODE_CHARS >= 0:
                record["code"] = str(record.get("code", ""))[:SCIM_FEATURE_RECORD_CODE_CHARS]
        if not max_records or len(records) < max_records:
            records.append(record)
            priority = feature_record_priority(record)
            if min_priority is None or priority < min_priority:
                min_priority = priority
                min_index = len(records) - 1
            return
        priority = feature_record_priority(record)
        if min_priority is None or priority <= min_priority:
            return
        records[min_index] = record
        min_priority = None
        min_index = -1
        for index, existing in enumerate(records):
            existing_priority = feature_record_priority(existing)
            if min_priority is None or existing_priority < min_priority:
                min_priority = existing_priority
                min_index = index

    with (dataset_dir / "functions.jsonl").open("r", encoding="utf-8") as handle:
        for line in handle:
            record = json.loads(line)
            if repo_id is None or record["repo_id"] == repo_id:
                add_record(record)

    if not records:
        available = sorted(
            {
                json.loads(line)["repo_id"]
                for line in (dataset_dir / "functions.jsonl").open("r", encoding="utf-8")
            }
        )
        raise ValueError(f"No records found for repo={repo_id!r}. Available repos: {', '.join(available[:30])}")
    if max_records and len(records) >= max_records:
        records.sort(key=feature_record_priority, reverse=True)
    return records


def infer_product_name(records: list[dict], repo_id: str | None, repo_context: dict | None = None) -> tuple[str, str, str]:
    path_counts: Counter[str] = Counter()
    term_counts: Counter[str] = Counter()
    for record in records:
        path = str(record["path"]).replace("\\", "/")
        first_part = path.split("/", 1)[0]
        if first_part:
            path_counts[first_part] += 1
        term_counts.update(feature_terms(record))
    term_counts.update(tokenize_feature_text(repo_context_text(repo_context)))

    context_name, context_source = product_name_from_context(repo_context)
    raw_name = repo_id or (path_counts.most_common(1)[0][0] if path_counts else "Unknown product")
    name_source = "repo_id"
    if context_name:
        product_name = context_name
        name_source = context_source
    elif path_counts:
        raw_name = path_counts.most_common(1)[0][0]
        product_name = humanize_repo_name(raw_name)
        name_source = "source_root_folder"
    else:
        product_name = humanize_repo_name(raw_name) or (repo_id or "Unknown product")

    game_terms = {
        "game",
        "pygame",
        "level",
        "scene",
        "sprite",
        "player",
        "enemy",
        "score",
        "collide",
        "collision",
        "keyboard",
        "mouse",
        "draw",
        "screen",
        "map",
        "board",
        "ai",
        "sound",
        "music",
    }
    dungeon_terms = {"dungeon", "hero", "mob", "weapon", "armor", "quest", "room"}
    library_terms = {"util", "stream", "buffer", "api", "client", "server", "flow", "okio", "guava"}
    java_utility_terms = {
        "string",
        "charsequence",
        "array",
        "object",
        "validate",
        "reflect",
        "method",
        "field",
        "constructor",
        "date",
        "duration",
        "calendar",
        "random",
        "lang",
        "commons",
    }
    card_terms = {"card", "cards", "poker", "blackjack", "dealer", "hand"}
    ui_component_terms = {"progress", "progressbar", "bar", "view", "widget", "canvas", "drawable", "attrs"}
    code_analysis_terms = {
        "ast",
        "parser",
        "parse",
        "graph",
        "callgraph",
        "embedding",
        "vector",
        "github",
        "dashboard",
        "cytoscape",
        "scim",
        "javalang",
        "joern",
    }
    code_analysis_signature_terms = {
        "ast",
        "callgraph",
        "embedding",
        "github",
        "cytoscape",
        "scim",
        "javalang",
        "joern",
        "fastapi",
        "dashboard",
    }
    raw_name_key = raw_name.lower().replace(" ", "").replace("-", "")
    code_analysis_signature_score = sum(term_counts[term] for term in code_analysis_signature_terms)
    code_analysis_score = sum(term_counts[term] for term in code_analysis_terms)
    game_score = sum(term_counts[term] for term in game_terms)
    dungeon_score = sum(term_counts[term] for term in dungeon_terms)
    java_utility_score = sum(term_counts[term] for term in java_utility_terms)
    game_path_score = term_counts["games"] + term_counts["pygame"] + term_counts["cpgames"]
    if "codeval" in raw_name_key or (code_analysis_signature_score >= 8 and code_analysis_score >= 18):
        product_type = "code analysis tool"
    elif dungeon_score >= 20:
        product_type = "game / dungeon crawler"
    elif game_score >= 12 or game_path_score >= 5 or "games" in raw_name_key or "pygame" in term_counts:
        product_type = "game project"
    elif sum(term_counts[term] for term in card_terms) >= 5:
        product_type = "card game"
    elif "commonslang" in raw_name_key or java_utility_score >= 12:
        product_type = "Java utility library"
    elif sum(term_counts[term] for term in ui_component_terms) >= 3 or "progressbar" in raw_name.lower().replace(" ", ""):
        product_type = "UI component library"
    elif sum(term_counts[term] for term in library_terms) >= 10:
        product_type = "software library"
    else:
        product_type = "software project"
    return product_name, product_type, name_source


# TODO Show neighors for a node only when the user clicks on the node. 
# At first just show the most important nodes and maybe <20 nodes and then
# When the user clicks on any of these nodes you show the links and neighbors for that node. This way you can explore the graph without getting overwhelmed by the complexity. You can also show some summary statistics for each node when the user clicks on it, like its degree, pagerank, component, etc.
# That way even if you don't have space the graph can grow slowly. Low Priority
# Focus on fixing Search first and then maybe add this as a nice to have.

def catalog_for_product_type(product_type: str) -> tuple[list[tuple[str, set[str]]], dict[str, list[tuple[str, set[str]]]]]:
    if product_type == "code analysis tool":
        return CODE_ANALYSIS_FEATURE_CATALOG, CODE_ANALYSIS_SUBFEATURE_CATALOG
    if product_type == "Java utility library":
        return JAVA_UTILITY_FEATURE_CATALOG, JAVA_UTILITY_SUBFEATURE_CATALOG
    if product_type == "game / dungeon crawler":
        return FEATURE_CATALOG, SUBFEATURE_CATALOG
    if product_type == "game project":
        return GENERIC_GAME_FEATURE_CATALOG, GENERIC_GAME_SUBFEATURE_CATALOG
    if product_type == "UI component library":
        return UI_COMPONENT_FEATURE_CATALOG, UI_COMPONENT_SUBFEATURE_CATALOG
    if product_type == "card game":
        return CARD_GAME_FEATURE_CATALOG, CARD_GAME_SUBFEATURE_CATALOG
    if product_type == "software library":
        return LIBRARY_FEATURE_CATALOG, LIBRARY_SUBFEATURE_CATALOG
    return DEFAULT_FEATURE_CATALOG, DEFAULT_SUBFEATURE_CATALOG


DERIVED_FEATURE_PATH_NOISE = {
    "charles",
    "pikachu",
    "cpgames",
    "core",
    "modules",
    "module",
    "interface",
    "interfaces",
    "sprites",
    "sprite",
    "resources",
    "assets",
    "utils",
    "utility",
    "common",
    "commons",
    "src",
    "main",
    "test",
    "tests",
    "lib",
    "libs",
    "package",
    "packages",
    "component",
    "components",
    "service",
    "services",
    "helper",
    "helpers",
    "base",
    "impl",
    "internal",
}

DERIVED_FEATURE_BODY_NOISE = {
    "def",
    "self",
    "return",
    "true",
    "false",
    "none",
    "null",
    "new",
    "class",
    "public",
    "private",
    "protected",
    "static",
    "final",
    "void",
    "int",
    "str",
    "string",
    "object",
    "array",
    "list",
    "dict",
    "map",
    "set",
    "get",
}

DOMAIN_ANCHOR_ALIASES = {
    "games": "game",
    "game": "game",
    "parsers": "parser",
    "parser": "parser",
    "search": "search",
    "dashboard": "dashboard",
    "reports": "report",
    "report": "report",
    "auth": "auth",
    "authentication": "authentication",
    "payments": "payment",
    "payment": "payment",
    "api": "api",
    "routes": "route",
    "views": "view",
    "pages": "page",
}


def derive_feature_catalog_from_repo(records: list[dict], product_type: str) -> tuple[list[tuple[str, set[str]]], dict[str, list[tuple[str, set[str]]]], str]:
    """Derive feature names from the built SCIM index records.

    This intentionally does NOT use product-type feature templates.  The old
    implementation leaked hardcoded game labels like "movement and collisions"
    into unrelated repos.  Here a feature is derived from evidence already in
    functions.jsonl: symbols, paths, code tokens, graph degrees, anchor type,
    and fused embeddings when available.
    """

    if not records:
        return [], {}, ""

    product_tokens = set(tokenize_feature_text(" ".join(str(record.get("repo_id", "")) for record in records[:20])))
    product_tokens.update(tokenize_feature_text(product_type))
    feature_name_noise = {
        *FEATURE_STOPWORDS,
        *DERIVED_FEATURE_PATH_NOISE,
        *DERIVED_FEATURE_BODY_NOISE,
        *product_tokens,
        "html", "css", "font", "color", "border", "width", "height", "style", "static",
        "true", "false", "none", "null", "data", "value", "values", "item", "items",
        "name", "names", "path", "paths", "file", "files", "line", "lines",
    }

    def meaningful(token: str) -> bool:
        token = str(token).lower().strip()
        return len(token) >= 3 and token not in feature_name_noise and not re.fullmatch(r"[0-9a-f]{6,}", token)

    def record_index_terms(record: dict) -> list[str]:
        """Terms from the SCIM index row, weighted toward real code symbols."""
        text = " ".join(
            str(record.get(key, ""))
            for key in ("symbol", "class_name", "method_name", "path")
        )
        terms = [term for term in tokenize_feature_text(text) if meaningful(term)]
        # Code body is useful, but keep it lower influence than identifiers.
        body_terms = [term for term in tokenize_feature_text(str(record.get("code", ""))[:2500]) if meaningful(term)]
        return terms + body_terms[:80]

    def anchor_rank(record: dict) -> int:
        anchor_type = feature_anchor_type(record)
        rank_by_type = {
            "api_route": 100,
            "html_ui": 90,
            "frontend_ui_component": 85,
            "ui_logic": 80,
            "android_ui_xml": 70,
            "function": 40,
            "file_anchor": 10,
        }
        return rank_by_type.get(anchor_type, 30) + int(record.get("in_degree", 0) or 0) + int(record.get("out_degree", 0) or 0)

    def feature_key_from_record(record: dict) -> str:
        """Pick a stable grouping key from a real SCIM record, not a product template."""
        symbol_terms = [term for term in tokenize_feature_text(str(record.get("symbol", ""))) if meaningful(term)]
        method_terms = [term for term in tokenize_feature_text(str(record.get("method_name", ""))) if meaningful(term)]
        path_terms = [term for term in record_path_only_terms(record) if meaningful(term)]
        code_terms = [term for term in tokenize_feature_text(str(record.get("code", ""))[:1200]) if meaningful(term)]

        anchor_type = feature_anchor_type(record)
        candidates: list[str] = []
        if anchor_type == "api_route":
            candidates.extend(method_terms)
            candidates.extend(symbol_terms[-3:])
            candidates.extend(path_terms[-4:])
        elif anchor_type in {"html_ui", "frontend_ui_component", "ui_logic", "android_ui_xml"}:
            candidates.extend(path_terms[-4:])
            candidates.extend(symbol_terms[-3:])
            candidates.extend(code_terms[:8])
        else:
            candidates.extend(symbol_terms[-3:])
            candidates.extend(method_terms)
            candidates.extend(path_terms[-3:])
            candidates.extend(code_terms[:6])

        # Prefer concrete product-action nouns over generic wrappers.
        generic_candidates = {"main", "index", "app", "server", "client", "utils", "helpers", "base", "config"}
        for candidate in candidates:
            if candidate not in generic_candidates:
                return candidate
        return candidates[0] if candidates else ""

    def name_from_group(group_records: list[dict], fallback_key: str) -> str:
        term_counts: Counter[str] = Counter()
        method_counts: Counter[str] = Counter()
        for record in group_records:
            terms = record_index_terms(record)
            term_counts.update(terms)
            method_counts.update(term for term in tokenize_feature_text(str(record.get("method_name", ""))) if meaningful(term))

        top_terms = [term for term, _ in term_counts.most_common(10) if meaningful(term)]
        top_methods = [term for term, _ in method_counts.most_common(5) if meaningful(term)]
        anchors = {feature_anchor_type(record) for record in group_records}

        # Use terms that are actually present in the SCIM index.  These suffixes
        # are descriptive only when supported by detected tokens.
        suffix = ""
        group_term_set = set(top_terms)
        if {"search", "query", "result"} & group_term_set:
            suffix = " search"
        elif {"graph", "callgraph", "cytoscape", "edge", "node"} & group_term_set:
            suffix = " graph"
        elif {"analyze", "analysis", "parse", "parser", "ast"} & group_term_set:
            suffix = " analysis"
        elif {"download", "extract", "zip", "github"} & group_term_set:
            suffix = " ingestion"
        elif {"dashboard", "display", "html", "report", "render"} & group_term_set or anchors & {"html_ui", "frontend_ui_component", "ui_logic"}:
            suffix = " display"
        elif {"api", "route", "request", "response"} & group_term_set or "api_route" in anchors:
            suffix = " API"

        seed_terms = []
        for term in [fallback_key, *top_methods, *top_terms]:
            if meaningful(term) and term not in seed_terms:
                seed_terms.append(term)
            if len(seed_terms) >= 3:
                break
        if not seed_terms:
            return "Unnamed feature"

        # Avoid names that are only the repo/product/file token.
        label = humanize_feature_token(" ".join(seed_terms[:3]))
        if suffix and suffix.strip().lower() not in {word.lower() for word in label.split()}:
            label = f"{label}{suffix}"
        return label.strip()

    # 1) Group around real entrypoints first: API routes, UI pages/components, and UI logic.
    grouped_records: dict[str, list[dict]] = defaultdict(list)
    ranked_records = sorted(records, key=anchor_rank, reverse=True)
    for record in ranked_records:
        key = feature_key_from_record(record)
        if not key or not meaningful(key):
            continue
        grouped_records[key].append(record)

    # 2) If there are too few entry-derived groups, use embedding clusters from the SCIM model index.
    if len(grouped_records) < 3 and KMeans is not None and len(records) >= 3 and records[0].get("fused_embedding"):
        cluster_count = max(2, min(12, int(math.sqrt(len(records))) or 2, len(records)))
        matrix = np.asarray([record["fused_embedding"] for record in records], dtype=np.float32)
        norms = np.linalg.norm(matrix, axis=1, keepdims=True)
        matrix = matrix / np.maximum(norms, 1e-9)
        labels = KMeans(n_clusters=cluster_count, random_state=7, n_init=10).fit_predict(matrix)
        grouped_records.clear()
        for cluster_id in range(cluster_count):
            members = [records[index] for index, label in enumerate(labels) if int(label) == cluster_id]
            if not members:
                continue
            term_counts: Counter[str] = Counter()
            for record in members:
                term_counts.update(record_index_terms(record))
            key = next((term for term, _ in term_counts.most_common(12) if meaningful(term)), f"cluster_{cluster_id}")
            grouped_records[key].extend(members)

    if not grouped_records:
        return [], {}, ""

    catalog: list[tuple[str, set[str]]] = []
    used_labels: set[str] = set()
    for key, group_records in sorted(grouped_records.items(), key=lambda item: (len(item[1]), max(anchor_rank(r) for r in item[1])), reverse=True):
        # One strong UI/API anchor or a file anchor is enough; otherwise require at least two records to avoid file-name noise.
        has_strong_anchor = any(
            feature_anchor_type(record)
            in {"api_route", "html_ui", "frontend_ui_component", "ui_logic", "android_ui_xml", "file_anchor"}
            for record in group_records
        )
        if len(group_records) < 2 and not has_strong_anchor:
            continue

        term_counts: Counter[str] = Counter()
        for record in group_records:
            term_counts.update(record_index_terms(record))
        top_terms = [term for term, _ in term_counts.most_common(12) if meaningful(term)]
        if not top_terms:
            continue

        label = name_from_group(group_records, key)
        if label in used_labels:
            continue
        used_labels.add(label)

        # Required key keeps evidence tied to the cluster.  Other terms improve recall.
        keywords = {f"required:{key}", key, *top_terms[:8]}
        catalog.append((label, keywords))
        if len(catalog) >= 12:
            break

    return catalog, {}, "scim_index_derived_feature_catalog"


def select_feature_catalog(records: list[dict], product_type: str) -> tuple[list[tuple[str, set[str]]], dict[str, list[tuple[str, set[str]]]], str]:
    # Feature names must come from the built SCIM index, not from hardcoded
    # product-type catalogs.  If the index cannot produce a feature, return no
    # feature rather than inventing one.
    derived_catalog, derived_subfeatures, source = derive_feature_catalog_from_repo(records, product_type)
    if derived_catalog:
        return derived_catalog, derived_subfeatures, source
    return [], {}, "no_scim_index_feature_evidence"


def match_records(records: list[dict], keywords: set[str]) -> list[tuple[int, dict]]:
    matches = []
    required_keywords = {keyword.split(":", 1)[1] for keyword in keywords if keyword.startswith("required:")}
    scoring_keywords = {keyword for keyword in keywords if not keyword.startswith("required:")}
    for record in records:
        term_counts = Counter(feature_terms(record))
        if required_keywords and not all(term_counts[keyword] for keyword in required_keywords):
            continue
        score = sum(term_counts[keyword] for keyword in scoring_keywords)
        if score:
            matches.append((score, record))
    matches.sort(
        key=lambda item: (
            item[0],
            item[1].get("in_degree", 0) + item[1].get("out_degree", 0),
            -item[1].get("line_count", 0),
        ),
        reverse=True,
    )
    return matches


def matched_feature_terms(record: dict, keywords: set[str]) -> list[str]:
    term_counts = Counter(feature_terms(record))
    return sorted(keyword for keyword in keywords if not keyword.startswith("required:") and term_counts[keyword] > 0)


def has_api_route_decorator(code: str) -> bool:
    return bool(re.search(r"(?m)^\s*@\s*(app|router)\s*\.\s*(get|post|put|delete|patch|route|websocket)\s*\(", code))


def has_api_route_path_signal(record: dict) -> bool:
    path = str(record.get("path", "")).replace("\\", "/").lower()
    symbol = str(record.get("symbol", "")).lower()
    method = str(record.get("method_name", "")).lower()
    if re.search(r"(^|/)(api|routes?|controllers?|handlers?)(/|$)", path):
        return True
    if re.search(r"(^|/)(route|controller|handler)\.(js|jsx|ts|tsx|py|java|cs|go|rb|php)$", path):
        return True
    if method in {"get", "post", "put", "patch", "delete", "options", "head"} and "/api/" in path:
        return True
    return bool(re.search(r"\b(api|route|controller|handler)\b", symbol))


def has_ui_source_signal(record: dict) -> bool:
    path = str(record.get("path", "")).lower()
    symbol = str(record.get("symbol", "")).lower()
    code = str(record.get("code", ""))
    if path.endswith((".html", ".htm", ".js", ".jsx", ".ts", ".tsx", ".css", ".xml", ".xhtml")):
        return True
    identity = " ".join(source_path_parts(record) + [symbol]).lower()
    ui_identity = bool(re.search(r"\b(activity|fragment|view|layout|screen|page|panel|dialog|window|component|widget)\b", identity))
    ui_code = bool(re.search(r"\b(JButton|JPanel|JFrame|JDialog|Activity|Fragment|View|paintComponent|render|addEventListener)\b", code))
    return ui_identity and ui_code


def record_visibility(record: dict) -> str:
    path = str(record.get("path", "")).lower()
    code = str(record.get("code", "")).lower()
    if has_api_route_decorator(code) or has_api_route_path_signal(record):
        return "API-visible"
    if path.endswith((".html", ".htm", ".js", ".jsx", ".ts", ".tsx", ".css", ".xml", ".xhtml")):
        return "UI-visible"
    if has_ui_source_signal(record):
        return "UI-visible"
    return "backend/internal"


def record_reachability(record: dict) -> str:
    visibility = record_visibility(record)
    in_degree = int(record.get("in_degree", 0) or 0)
    out_degree = int(record.get("out_degree", 0) or 0)
    if visibility in {"UI-visible", "API-visible"}:
        return "entrypoint or user-facing"
    if in_degree > 0:
        return "reached by extracted graph"
    if out_degree > 0:
        return "source/root in extracted graph"
    return "not reached in extracted graph"


def aggregate_visibility(records: list[dict]) -> str:
    labels = {record_visibility(record) for record in records}
    ordered = [label for label in ("UI-visible", "API-visible", "backend/internal") if label in labels]
    return ", ".join(ordered) if ordered else "unknown"


def aggregate_reachability(records: list[dict]) -> str:
    labels = {record_reachability(record) for record in records}
    if "entrypoint or user-facing" in labels:
        return "has UI/API entrypoint evidence"
    if "reached by extracted graph" in labels:
        return "reached by extracted graph"
    if "source/root in extracted graph" in labels:
        return "source/root in extracted graph"
    return "not reached in extracted graph"


def evidence_payload(score: int, record: dict, keywords: set[str]) -> dict:
    return {
        "symbol": record["symbol"],
        "path": record["path"],
        "start_line": record["start_line"],
        "score": score,
        "matched_terms": matched_feature_terms(record, keywords)[:8],
        "visibility": record_visibility(record),
        "reachability": record_reachability(record),
        "evidence_meaning": "Static match from function name, path, body tokens, and extracted graph metadata.",
    }


def graph_health_counts(records: list[dict]) -> dict[str, int]:
    return {
        "functions": len(records),
        "with_callers": sum(1 for record in records if int(record.get("in_degree", 0)) > 0),
        "with_callees": sum(1 for record in records if int(record.get("out_degree", 0)) > 0),
        "uncalled_in_extracted_graph": sum(1 for record in records if int(record.get("in_degree", 0)) == 0),
        "no_outgoing_calls_in_extracted_graph": sum(1 for record in records if int(record.get("out_degree", 0)) == 0),
        "isolated_in_extracted_graph": sum(
            1
            for record in records
            if int(record.get("in_degree", 0)) == 0 and int(record.get("out_degree", 0)) == 0
        ),
        "large_functions_100_plus_lines": sum(1 for record in records if int(record.get("line_count", 0)) >= 100),
    }


def feature_anchor_type(record: dict) -> str:
    path = str(record.get("path", "")).lower()
    symbol = str(record.get("symbol", "")).lower()
    code = str(record.get("code", "")).lower()
    if path.endswith((".html", ".htm", ".xhtml")):
        return "html_ui"
    if path.endswith(".xml"):
        if any(token in path for token in ("/layout/", "res/layout", "android")):
            return "android_ui_xml"
        return "xml_config_or_ui"
    if path.endswith((".jsx", ".tsx", ".vue", ".svelte")):
        return "frontend_ui_component"
    if path.endswith((".md", ".txt", ".rst", ".adoc")):
        return "documentation"
    if has_api_route_decorator(code) or has_api_route_path_signal(record):
        return "api_route"
    if has_ui_source_signal(record):
        return "ui_logic"
    if symbol.endswith(".<file>") or str(record.get("method_name", "")) == "<file>":
        return "file_anchor"
    return "function"


def feature_anchor_payload(record: dict) -> dict:
    return {
        "type": feature_anchor_type(record),
        "symbol": record.get("symbol", ""),
        "path": record.get("path", ""),
        "start_line": record.get("start_line", 1),
        "visibility": record_visibility(record),
        "reachability": record_reachability(record),
    }


def feature_anchor_summary(records: list[dict], limit: int = 18) -> dict:
    anchors_by_type: dict[str, list[dict]] = defaultdict(list)
    for record in records:
        anchor_type = feature_anchor_type(record)
        if len(anchors_by_type[anchor_type]) < limit:
            anchors_by_type[anchor_type].append(feature_anchor_payload(record))
    return dict(sorted(anchors_by_type.items()))


FEATURE_ENTRYPOINT_TYPES = {"api_route", "html_ui", "frontend_ui_component", "ui_logic", "android_ui_xml"}


def feature_entrypoint_records(records: list[dict], limit: int = 8) -> list[dict]:
    ranked = sorted(
        records,
        key=lambda record: (
            feature_anchor_type(record) in FEATURE_ENTRYPOINT_TYPES,
            record_visibility(record) in {"UI-visible", "API-visible"},
            int(record.get("out_degree", 0) or 0),
            int(record.get("in_degree", 0) or 0),
        ),
        reverse=True,
    )
    entrypoints = []
    seen = set()
    for record in ranked:
        anchor_type = feature_anchor_type(record)
        if anchor_type not in FEATURE_ENTRYPOINT_TYPES and record_visibility(record) not in {"UI-visible", "API-visible"}:
            continue
        symbol = str(record.get("symbol", ""))
        if not symbol or symbol in seen:
            continue
        seen.add(symbol)
        payload = feature_anchor_payload(record)
        payload["entrypoint_kind"] = anchor_type
        payload["callees"] = list(record.get("callees") or [])[:8]
        entrypoints.append(payload)
        if len(entrypoints) >= limit:
            break
    return entrypoints


def feature_callgraph_boundary(records: list[dict], limit: int = 24) -> dict:
    by_symbol = {str(record.get("symbol", "")): record for record in records if record.get("symbol")}
    entrypoints = feature_entrypoint_records(records)
    seeds = [item.get("symbol", "") for item in entrypoints if item.get("symbol")]
    if not seeds:
        seeds = [
            symbol for symbol, record in sorted(
                by_symbol.items(),
                key=lambda item: (
                    int(item[1].get("out_degree", 0) or 0),
                    int(item[1].get("in_degree", 0) or 0),
                ),
                reverse=True,
            )[:3]
        ]

    visited = []
    seen = set()
    queue = deque((seed, 0) for seed in seeds)
    while queue and len(visited) < limit:
        symbol, depth = queue.popleft()
        if symbol in seen:
            continue
        seen.add(symbol)
        record = by_symbol.get(symbol)
        if not record:
            continue
        visited.append({
            "symbol": symbol,
            "path": record.get("path", ""),
            "start_line": record.get("start_line", 1),
            "depth": depth,
            "anchor_type": feature_anchor_type(record),
            "visibility": record_visibility(record),
            "callees": list(record.get("callees") or [])[:8],
        })
        if depth >= 2:
            continue
        for callee in list(record.get("callees") or [])[:12]:
            if callee in by_symbol and callee not in seen:
                queue.append((callee, depth + 1))

    return {
        "strategy": "entrypoint_callgraph_walk" if entrypoints else "degree_seed_callgraph_walk",
        "entrypoints": entrypoints,
        "nodes": visited,
        "node_count": len(visited),
    }


def feature_callgraph_clusters(records: list[dict], limit: int = 8) -> list[dict]:
    by_component: dict[int, list[dict]] = defaultdict(list)
    for record in records:
        try:
            component_id = int(record.get("component_id", -1))
        except (TypeError, ValueError):
            component_id = -1
        by_component[component_id].append(record)
    clusters = []
    for component_id, rows in sorted(by_component.items(), key=lambda item: len(item[1]), reverse=True):
        if component_id < 0:
            continue
        clusters.append({
            "component_id": component_id,
            "node_count": len(rows),
            "entrypoint_count": len(feature_entrypoint_records(rows)),
            "top_symbols": [
                row.get("symbol", "")
                for row in sorted(
                    rows,
                    key=lambda record: int(record.get("in_degree", 0) or 0) + int(record.get("out_degree", 0) or 0),
                    reverse=True,
                )[:6]
            ],
        })
        if len(clusters) >= limit:
            break
    return clusters


def incomplete_feature_signals(records: list[dict], limit: int = 12) -> list[dict]:
    signals = []
    for record in records:
        anchor_type = feature_anchor_type(record)
        code = str(record.get("code", ""))
        lower_code = code.lower()
        reasons = []
        in_degree = int(record.get("in_degree", 0) or 0)
        out_degree = int(record.get("out_degree", 0) or 0)
        if in_degree == 0 and record_visibility(record) == "backend/internal" and anchor_type == "function":
            reasons.append("not called by extracted graph and not UI/API-visible")
        if out_degree == 0 and int(record.get("line_count", 0) or 0) <= 3 and anchor_type == "function":
            reasons.append("short function with no outgoing calls")
        if re.search(r"\b(pass|todo|fixme|notimplemented|not implemented|stub)\b", lower_code):
            reasons.append("stub/TODO marker found in implementation text")
        if lower_code.rstrip().endswith(("pass", "todo", "stub")):
            reasons.append("implementation appears to stop at a placeholder")
        if reasons:
            signals.append({
                "symbol": record.get("symbol", ""),
                "path": record.get("path", ""),
                "start_line": record.get("start_line", 1),
                "reasons": reasons,
            })
        if len(signals) >= limit:
            break
    return signals


def comment_evidence_for_feature(feature_records: list[dict], repo_context: dict | None, keywords: set[str], limit: int = 8) -> list[dict]:
    if not isinstance(repo_context, dict):
        return []
    feature_paths = {str(record.get("path", "")).lower() for record in feature_records}
    normalized_keywords = {keyword.split(":", 1)[-1] for keyword in keywords}
    items = []
    for item in (repo_context.get("document_items", []) or []) + (repo_context.get("readme_items", []) or []):
        if not isinstance(item, dict):
            continue
        text = str(item.get("text", ""))
        file_path = str(item.get("file", "")).lower()
        text_terms = set(tokenize_feature_text(f"{file_path} {text}"))
        path_match = any(file_path and (file_path in path or path in file_path) for path in feature_paths)
        term_match = bool(normalized_keywords & text_terms)
        if path_match or term_match:
            items.append({
                "kind": item.get("kind", "document"),
                "file": item.get("file", ""),
                "line": item.get("line", ""),
                "text": text[:500],
                "matched_terms": sorted(normalized_keywords & text_terms)[:8],
            })
        if len(items) >= limit:
            break
    return items


EVIDENCE_FEATURE_NOISE = {
    *FEATURE_STOPWORDS,
    *DERIVED_FEATURE_PATH_NOISE,
    *DERIVED_FEATURE_BODY_NOISE,
    "application",
    "package",
    "project",
    "repository",
    "source",
    "impl",
    "internal",
    "model",
    "models",
    "entity",
    "entities",
    "util",
    "utils",
    "utility",
    "helper",
    "helpers",
    "common",
    "shared",
    "base",
    "abstract",
    "default",
    "manager",
    "management",
    "handler",
    "handlers",
    "listener",
    "listeners",
    "event",
    "events",
    "data",
    "value",
    "values",
    "item",
    "items",
    "name",
    "names",
    "path",
    "paths",
    "file",
    "files",
    "line",
    "lines",
    "this",
    "that",
    "these",
    "those",
    "there",
    "their",
    "with",
    "without",
    "then",
    "else",
    "case",
    "break",
    "continue",
}


def source_path_parts(record: dict) -> list[str]:
    raw_path = str(record.get("path", "")).replace("\\", "/")
    if not raw_path:
        return []

    lower_path = raw_path.lower()
    candidate = raw_path
    for marker in ("/src/", "_src_", "/app/", "_app_", "/lib/", "_lib_"):
        index = lower_path.rfind(marker)
        if index >= 0:
            candidate = raw_path[index + len(marker) :]
            break

    parts = [part for part in re.split(r"[\\/]+", candidate) if part]
    if len(parts) <= 1 and "_" in candidate:
        parts = [part for part in candidate.split("_") if part]

    cleaned = []
    for part in parts[-8:]:
        stem = part.rsplit(".", 1)[0] if "." in part else part
        stem = re.sub(r"-?[0-9a-f]{7,}$", "", stem, flags=re.IGNORECASE)
        if stem:
            cleaned.append(stem)
    return cleaned


def source_file_stem(record: dict) -> str:
    parts = source_path_parts(record)
    if parts:
        return parts[-1]
    path = str(record.get("path", ""))
    return Path(path.replace("\\", "/")).stem


def source_symbol_tail(record: dict) -> str:
    symbol = str(record.get("symbol", ""))
    if "_" in symbol:
        prefix, tail = symbol.split("_", 1)
        if re.search(r"[0-9a-f]{7,}", prefix, flags=re.IGNORECASE) or "-" in prefix:
            return tail
    return symbol


def evidence_feature_tokens(text: str, product_tokens: set[str] | None = None) -> list[str]:
    product_tokens = product_tokens or set()
    tokens = []
    for token in tokenize_feature_text(text):
        normalized = token.lower()
        if normalized in EVIDENCE_FEATURE_NOISE:
            continue
        if normalized in product_tokens:
            continue
        if re.fullmatch(r"[0-9a-f]{6,}", normalized):
            continue
        tokens.append(normalized)
    return tokens


def expand_product_tokens(tokens: set[str]) -> set[str]:
    expanded = set(tokens)
    for token in list(tokens):
        if token == "butterknife" or "butterknife" in token:
            expanded.update({"butterknife", "butter", "knife"})
        if token == "codeval" or "codeval" in token:
            expanded.update({"codeval", "code", "val"})
    return expanded


def record_identity_tokens(record: dict, product_tokens: set[str]) -> list[str]:
    values = [
        str(record.get("class_name", "")),
        str(record.get("method_name", "")),
        source_symbol_tail(record),
        " ".join(source_path_parts(record)),
    ]
    return evidence_feature_tokens(" ".join(values), product_tokens)


FEATURE_ACTION_TERMS = {
    "add", "analyze", "analyse", "ask", "auth", "build", "cache", "click", "connect",
    "create", "delete", "download", "edit", "export", "fetch", "fix", "generate",
    "import", "index", "load", "login", "map", "open", "parse", "persist", "publish",
    "read", "register", "render", "restore", "run", "save", "search", "select",
    "send", "setup", "show", "store", "sync", "track", "upload", "validate", "view",
}

UI_SEED_MATCH_NOISE = {
    "app", "button", "card", "content", "dashboard", "dialog", "display", "form",
    "html", "label", "link", "main", "modal", "nav", "page", "panel", "screen",
    "section", "static", "tab", "tile", "ui", "view", "widget",
}


def compact_feature_phrase(text: str, product_tokens: set[str], max_terms: int = 5) -> str:
    terms = evidence_feature_tokens(text, product_tokens)
    if not terms:
        return ""
    compact = []
    for term in terms:
        if term not in compact:
            compact.append(term)
        if len(compact) >= max_terms:
            break
    return " ".join(compact)


def human_facing_feature_hypotheses(repo_context: dict | None, product_tokens: set[str], limit: int = 80) -> list[dict]:
    """Extract repo-agnostic feature hypotheses from user-facing text.

    UI/product repos usually expose features through labels, headings, docs,
    routes, examples, or README text.  Library repos expose them through public
    APIs and examples.  This function only creates hypotheses; implementation
    evidence is attached later from code records.
    """
    if not isinstance(repo_context, dict):
        return []
    items = []
    seeded_hypotheses = []
    seen_seed_labels = set()
    for seed in repo_context.get("ui_feature_seeds", []) or []:
        label = re.sub(r"\s+", " ", str(seed or "")).strip()
        if not label or len(label) < 3 or len(label) > 80:
            continue
        key = label.lower()
        if key in seen_seed_labels:
            continue
        terms = set(evidence_feature_tokens(label, product_tokens))
        if not terms:
            continue
        seen_seed_labels.add(key)
        seeded_hypotheses.append({
            "key": label,
            "label": label,
            "keywords": terms,
            "source": "ui_feature_seed",
            "confidence": 0.95,
            "text_evidence": [{
                "file": "ui_feature_seeds",
                "line": 1,
                "text": label,
            }],
        })

    for key in ("readme_items", "document_items"):
        value = repo_context.get(key) or []
        if isinstance(value, list):
            items.extend(item for item in value if isinstance(item, dict))
    for key in ("readme_text", "document_text", "github_description"):
        value = str(repo_context.get(key) or "").strip()
        if value:
            items.append({"file": key, "line": 1, "text": value})

    phrase_counts: Counter[str] = Counter()
    phrase_sources: dict[str, list[dict]] = defaultdict(list)
    phrase_split = re.compile(r"[\n\r|•·]+|(?<=[.!?;])\s+")
    for item in items:
        file_name = str(item.get("file") or item.get("path") or "")
        line = item.get("line", 1)
        text = str(item.get("text") or "")
        for raw_phrase in phrase_split.split(text[:8000]):
            phrase = re.sub(r"\s+", " ", raw_phrase).strip(" -:*#\t")
            if not phrase or len(phrase) > 120:
                continue
            terms = evidence_feature_tokens(phrase, product_tokens)
            if len(terms) < 1 or len(terms) > 8:
                continue
            if len(terms) == 1 and terms[0] not in FEATURE_ACTION_TERMS:
                continue
            if not (set(terms) & FEATURE_ACTION_TERMS or len(terms) >= 2):
                continue
            key = " ".join(dict.fromkeys(terms[:5]))
            if not key:
                continue
            phrase_counts[key] += 1
            if len(phrase_sources[key]) < 5:
                phrase_sources[key].append({
                    "file": file_name,
                    "line": line,
                    "text": phrase[:220],
                })

    hypotheses = list(seeded_hypotheses)
    for key, count in phrase_counts.most_common(limit):
        if any(item.get("key", "").lower() == key.lower() for item in hypotheses):
            continue
        terms = set(evidence_feature_tokens(key, product_tokens))
        if not terms:
            continue
        hypotheses.append({
            "key": key,
            "label": humanize_feature_token(key),
            "keywords": terms,
            "source": "human_facing_text",
            "confidence": min(1.0, 0.35 + count * 0.08),
            "text_evidence": phrase_sources.get(key, []),
        })
    return hypotheses[:limit]


def distinctive_feature_keywords(keywords: set[str]) -> set[str]:
    return {keyword for keyword in keywords if keyword not in UI_SEED_MATCH_NOISE and len(keyword) >= 4}


def record_matches_feature_keywords(record: dict, keywords: set[str], product_tokens: set[str]) -> int:
    if not keywords:
        return 0
    terms = set(record_identity_tokens(record, product_tokens))
    terms.update(record_path_only_terms(record))
    score = len(terms & keywords) * 10
    method_terms = set(evidence_feature_tokens(str(record.get("method_name", "")), product_tokens))
    class_terms = set(evidence_feature_tokens(str(record.get("class_name", "")), product_tokens))
    path_terms = set(record_path_only_terms(record))
    score += len(method_terms & keywords) * 6
    score += len(class_terms & keywords) * 4
    score += len(path_terms & keywords) * 4
    code = str(record.get("code", ""))[:1800].lower()
    for keyword in keywords:
        if len(keyword) >= 4 and keyword in code:
            score += 2
    return score


def records_by_source_file(records: list[dict]) -> dict[str, list[dict]]:
    grouped: dict[str, list[dict]] = defaultdict(list)
    for record in records:
        grouped[str(record.get("path", ""))].append(record)
    for rows in grouped.values():
        rows.sort(key=lambda item: int(item.get("start_line", 0) or 0))
    return grouped


def nearby_same_file_records(anchor: dict, by_file: dict[str, list[dict]], max_distance: int = 120, max_items: int = 6) -> list[dict]:
    path = str(anchor.get("path", ""))
    start = int(anchor.get("start_line", 0) or 0)
    if not path or not start:
        return []
    candidates = []
    for record in by_file.get(path, []):
        symbol = str(record.get("symbol", ""))
        if not symbol or symbol == str(anchor.get("symbol", "")):
            continue
        record_start = int(record.get("start_line", 0) or 0)
        distance = abs(record_start - start)
        if distance <= max_distance:
            candidates.append((distance, record))
    candidates.sort(key=lambda item: item[0])
    return [record for _, record in candidates[:max_items]]


def downstream_callgraph_records(anchor: dict, by_symbol: dict[str, dict], max_depth: int = 2, max_items: int = 16) -> list[dict]:
    if not by_symbol:
        return []
    rows = []
    seen = {str(anchor.get("symbol", ""))}
    queue = deque((callee, 1) for callee in (anchor.get("callees") or [])[:12])
    while queue and len(rows) < max_items:
        symbol, depth = queue.popleft()
        if symbol in seen:
            continue
        seen.add(symbol)
        record = by_symbol.get(symbol)
        if not record:
            continue
        rows.append(record)
        if depth >= max_depth:
            continue
        for callee in (record.get("callees") or [])[:12]:
            if callee not in seen:
                queue.append((callee, depth + 1))
    return rows


def record_feature_group_key(record: dict, product_tokens: set[str], product_type: str) -> str:
    """Choose the feature cluster key from file/class/route evidence first."""

    anchor_type = feature_anchor_type(record)
    class_name = str(record.get("class_name", "") or "").strip()
    method_name = str(record.get("method_name", "") or "").strip()
    file_stem = source_file_stem(record)
    path_parts = source_path_parts(record)

    path_terms = evidence_feature_tokens(" ".join(path_parts), product_tokens)
    class_terms = evidence_feature_tokens(class_name, product_tokens)
    file_terms = evidence_feature_tokens(file_stem, product_tokens)
    method_terms = evidence_feature_tokens(method_name, product_tokens)

    if product_type == "game project":
        lower_parts = [part.lower() for part in path_parts]
        for marker in ("games", "game"):
            if marker in lower_parts:
                index = lower_parts.index(marker)
                for part in lower_parts[index + 1 :]:
                    terms = evidence_feature_tokens(part, product_tokens)
                    if terms:
                        return " ".join(terms[:3])

    if anchor_type == "api_route" and method_terms:
        return " ".join(method_terms[:3])

    if anchor_type in {"html_ui", "frontend_ui_component", "android_ui_xml", "ui_logic"}:
        if file_terms:
            return " ".join(file_terms[:4])
        if method_terms:
            return " ".join(method_terms[:3])

    if class_terms and class_name not in {"<file>", method_name}:
        return " ".join(class_terms[:4])
    if file_terms:
        return " ".join(file_terms[:4])
    if method_terms:
        return " ".join(method_terms[:3])
    if path_terms:
        return " ".join(path_terms[-4:])
    return ""


def feature_label_from_evidence(key: str, records: list[dict], product_type: str) -> str:
    key_terms = evidence_feature_tokens(key)
    record_terms: Counter[str] = Counter()
    method_terms: Counter[str] = Counter()
    anchors = {feature_anchor_type(record) for record in records}
    for record in records:
        record_terms.update(record_identity_tokens(record, set()))
        method_terms.update(evidence_feature_tokens(str(record.get("method_name", ""))))

    term_set = set(key_terms)
    supporting_terms = set(record_terms)
    joined_key = "".join(key_terms)
    method_set = set(method_terms)

    if product_type == "game project":
        game_name = humanize_repo_feature_key(joined_key, product_type)
        if game_name and game_name != humanize_feature_token(joined_key):
            return game_name

    if "dialog" in term_set:
        base = [term for term in key_terms if term != "dialog"] or [term for term, _ in method_terms.most_common(2)]
        return f"{humanize_feature_token(' '.join(base[:2]))} dialog".strip().capitalize()
    if "window" in term_set or "appwindow" in joined_key:
        return "Application window"
    if "panel" in term_set:
        base = [term for term in key_terms if term != "panel"] or ["game"]
        return f"{humanize_feature_token(' '.join(base[:2]))} panel".strip()
    if "table" in term_set:
        base = [term for term in key_terms if term != "table"] or ["game"]
        return f"{humanize_feature_token(' '.join(base[:2]))} table".strip()
    if "deck" in term_set:
        return "Deck management"
    if "dealer" in term_set:
        return "Dealer behavior"
    if "hand" in term_set:
        return "Hand management"
    if "player" in term_set:
        if {"save", "open", "load"} & set(method_terms):
            return "Player save and load"
        return "Player management"
    if "card" in term_set or "cards" in term_set or {"face", "suit", "ace"} & term_set:
        return "Card model"
    if "binding" in term_set and ("compiler" in term_set or "compiler" in supporting_terms):
        return "Binding code generation"
    if "view" in term_set and "binding" in term_set:
        return "View binding"
    if "bind" in term_set and "view" in term_set:
        return "View binding annotations"
    if "unbinder" in term_set or "unbind" in term_set:
        return "Unbinding lifecycle"
    if "processor" in term_set:
        return "Annotation processor"
    if ("click" in term_set or "click" in supporting_terms) and "long" in term_set:
        return "Long-click event binding"
    if "click" in term_set:
        return "Click event binding"
    if "touch" in term_set:
        return "Touch event binding"
    if "selected" in term_set or "select" in term_set:
        return "Item selection binding"
    if "collections" in term_set and "view" in term_set:
        return "View collection helpers"
    if "manifest" in term_set:
        return "Android manifest configuration"
    if ({"bind", "try", "invoke", "validate"} & method_set) and ({"butter", "knife", "butterknife"} & supporting_terms):
        return "Runtime binding API"
    if "javalang" in term_set:
        return "Java parser"
    if {"tree", "sitter"} <= term_set:
        return "Tree-sitter Java parser"
    if "python" in term_set and ({"call", "visitor", "ast", "chunk"} & term_set):
        return "Python code parser"
    if "joern" in term_set:
        return "Joern parser"
    if {"parser", "parse", "ast"} & term_set:
        if len(key_terms) > 1:
            return f"{humanize_feature_token(' '.join(key_terms[:3]))} parser"
        return "Parser support"
    if "embedding" in term_set or {"tfidf", "projector"} & term_set:
        return "Embedding model"
    if "analyzer" in term_set:
        return "Code analyzer"
    if "visitor" in term_set and "call" in supporting_terms:
        return "Code graph visitor"
    if "search" in term_set or "query" in term_set:
        return "Search"
    if "dashboard" in term_set or anchors & {"html_ui", "frontend_ui_component", "ui_logic", "android_ui_xml"}:
        return humanize_feature_token(" ".join(key_terms[:2])) or "User interface"
    if "supabase" in term_set:
        return "Supabase integration"
    if "cytoscape" in term_set:
        return "Cytoscape graph"
    if "autotrack" in term_set:
        return "Autotrack instrumentation"
    if "google" in term_set and "analytics" in term_set:
        return "Google Analytics"
    if "api_route" in anchors:
        return f"{humanize_feature_token(' '.join(key_terms[:2]))} API".strip()

    label_terms = []
    for term in [*key_terms, *(term for term, _ in record_terms.most_common(5))]:
        if term not in label_terms:
            label_terms.append(term)
        if len(label_terms) >= 3:
            break
    return humanize_feature_token(" ".join(label_terms)) or "Unnamed feature"


def evidence_record_payload(record: dict, matched_terms: set[str]) -> dict:
    degree = int(record.get("in_degree", 0) or 0) + int(record.get("out_degree", 0) or 0)
    terms = set(feature_terms(record)) | set(record_path_only_terms(record))
    return {
        "symbol": record.get("symbol", ""),
        "path": record.get("path", ""),
        "start_line": record.get("start_line", 1),
        "score": degree + len(terms & matched_terms),
        "matched_terms": sorted(terms & matched_terms)[:8],
        "visibility": record_visibility(record),
        "reachability": record_reachability(record),
        "evidence_meaning": "Feature evidence from file/class/function names, UI/API anchors, comments/docs, and extracted graph metadata.",
    }


def feature_candidate_score(records: list[dict], comment_hits: int) -> int:
    score = len(records) * 3 + comment_hits * 5
    for record in records:
        anchor_type = feature_anchor_type(record)
        if anchor_type in {"api_route", "html_ui", "frontend_ui_component", "android_ui_xml", "ui_logic"}:
            score += 12
        elif anchor_type == "documentation":
            score += 6
        score += min(8, int(record.get("in_degree", 0) or 0) + int(record.get("out_degree", 0) or 0))
        if record_visibility(record) != "backend/internal":
            score += 5
    return score


def build_evidence_subfeatures(records: list[dict], product_tokens: set[str], examples: int) -> list[dict]:
    groups: dict[str, list[dict]] = defaultdict(list)
    for record in records:
        method_name = str(record.get("method_name", ""))
        terms = evidence_feature_tokens(method_name, product_tokens)
        if not terms:
            continue
        action_terms = [term for term in terms if term not in {"init", "constructor"}]
        if not action_terms:
            continue
        key = " ".join(action_terms[:3])
        groups[key].append(record)

    rows = []
    for key, group_records in groups.items():
        if len(group_records) < 1:
            continue
        keywords = set(evidence_feature_tokens(key, product_tokens))
        rows.append({
            "name": humanize_feature_token(key),
            "status": "implemented",
            "visibility": aggregate_visibility(group_records),
            "reachability": aggregate_reachability(group_records),
            "match_count": len(group_records),
            "evidence": [
                evidence_record_payload(record, keywords)
                for record in sorted(
                    group_records,
                    key=lambda row: int(row.get("in_degree", 0) or 0) + int(row.get("out_degree", 0) or 0),
                    reverse=True,
                )[: max(1, min(3, examples))]
            ],
        })
    rows.sort(key=lambda row: row["match_count"], reverse=True)
    return rows[:6]


def evidence_feature_candidates(
    records: list[dict],
    product_name: str,
    product_type: str,
    examples: int,
    repo_context: dict | None,
) -> list[dict]:
    if len(records) > SCIM_FEATURE_CATALOG_RECORD_LIMIT:
        records = sorted(
            records,
            key=lambda record: (
                feature_anchor_type(record) in {"api_route", "html_ui", "frontend_ui_component", "android_ui_xml", "ui_logic", "file_anchor"},
                int(record.get("in_degree", 0) or 0) + int(record.get("out_degree", 0) or 0),
                -int(record.get("start_line", 0) or 0),
            ),
            reverse=True,
        )[:SCIM_FEATURE_CATALOG_RECORD_LIMIT]
    product_tokens = set(evidence_feature_tokens(product_name))
    product_tokens.update(evidence_feature_tokens(str(repo_context.get("github_repo", ""))) if isinstance(repo_context, dict) else [])
    product_tokens.update(evidence_feature_tokens(str(repo_context.get("github_owner", ""))) if isinstance(repo_context, dict) else [])
    for record in records[:50]:
        product_tokens.update(evidence_feature_tokens(str(record.get("repo_id", ""))))
        raw_path = str(record.get("path", ""))
        prefix = re.split(r"[_/\\]", raw_path, maxsplit=1)[0]
        product_tokens.update(evidence_feature_tokens(prefix))
    product_tokens = expand_product_tokens(product_tokens)
    by_file = records_by_source_file(records)
    text_hypotheses = human_facing_feature_hypotheses(
        repo_context,
        product_tokens,
        limit=SCIM_FEATURE_HYPOTHESIS_LIMIT,
    )
    hypothesis_records = sorted(
        records,
        key=lambda record: (
            feature_anchor_type(record) in {"api_route", "html_ui", "frontend_ui_component", "android_ui_xml", "ui_logic", "file_anchor"},
            int(record.get("in_degree", 0) or 0) + int(record.get("out_degree", 0) or 0),
            int(record.get("line_count", 0) or 0),
        ),
        reverse=True,
    )[:SCIM_FEATURE_HYPOTHESIS_RECORD_LIMIT]
    by_symbol = {str(record.get("symbol", "")): record for record in records if record.get("symbol")}

    grouped: dict[str, list[dict]] = defaultdict(list)
    hypothesis_evidence: dict[str, list[dict]] = defaultdict(list)
    hypothesis_labels: dict[str, str] = {}
    hypothesis_sources: dict[str, str] = {}
    hypothesis_confidence: dict[str, float] = {}
    for hypothesis in text_hypotheses:
        key = str(hypothesis.get("key") or "")
        keywords = set(hypothesis.get("keywords") or [])
        if not key or not keywords:
            continue
        hypothesis_labels[key] = str(hypothesis.get("label") or key)
        hypothesis_sources[key] = str(hypothesis.get("source") or "")
        hypothesis_confidence[key] = float(hypothesis.get("confidence") or 0)
        scored_records = []
        distinctive_keywords = distinctive_feature_keywords(keywords)
        for record in hypothesis_records:
            score = record_matches_feature_keywords(record, keywords, product_tokens)
            if score and hypothesis_sources[key] == "ui_feature_seed" and distinctive_keywords:
                record_text = " ".join(
                    str(record.get(field, ""))
                    for field in ("symbol", "class_name", "method_name", "path", "code")
                ).lower()
                if not any(keyword in record_text for keyword in distinctive_keywords):
                    score = 0
            anchor_type = feature_anchor_type(record)
            if score and anchor_type in {"api_route", "html_ui", "frontend_ui_component", "android_ui_xml", "ui_logic"}:
                score += 6
            if score:
                scored_records.append((score, record))
        scored_records.sort(
            key=lambda item: (
                item[0],
                int(item[1].get("in_degree", 0) or 0) + int(item[1].get("out_degree", 0) or 0),
            ),
            reverse=True,
        )
        for _, record in scored_records[:18]:
            grouped[key].append(record)
            if feature_anchor_type(record) in {"api_route", "html_ui", "frontend_ui_component", "android_ui_xml", "ui_logic"}:
                grouped[key].extend(nearby_same_file_records(record, by_file))
                grouped[key].extend(downstream_callgraph_records(record, by_symbol))
        hypothesis_evidence[key].extend(hypothesis.get("text_evidence") or [])

    for record in records:
        key = record_feature_group_key(record, product_tokens, product_type)
        if key:
            grouped[key].append(record)
            if feature_anchor_type(record) in {"api_route", "html_ui", "frontend_ui_component", "android_ui_xml", "ui_logic"}:
                grouped[key].extend(nearby_same_file_records(record, by_file))
                grouped[key].extend(downstream_callgraph_records(record, by_symbol))

    by_label: dict[str, list[dict]] = defaultdict(list)
    label_keys: dict[str, set[str]] = defaultdict(set)
    label_sources: dict[str, set[str]] = defaultdict(set)
    label_confidence: dict[str, float] = defaultdict(float)
    for key, group_records in grouped.items():
        if len(group_records) == 1:
            record = group_records[0]
            if (
                feature_anchor_type(record) not in {"api_route", "html_ui", "frontend_ui_component", "android_ui_xml", "ui_logic", "file_anchor"}
                and int(record.get("in_degree", 0) or 0) == 0
                and int(record.get("out_degree", 0) or 0) == 0
            ):
                continue
        source = hypothesis_sources.get(key, "")
        if source in {"ui_feature_seed", "human_facing_text"} and hypothesis_labels.get(key):
            label = hypothesis_labels[key]
        else:
            label = feature_label_from_evidence(key, group_records, product_type)
        if not label or label.lower() in {"unnamed feature", "source", "project"}:
            continue
        by_label[label].extend(group_records)
        label_keys[label].add(key)
        if source:
            label_sources[label].add(source)
            label_confidence[label] = max(label_confidence[label], hypothesis_confidence.get(key, 0))

    candidates = []
    seen_symbols_by_label: dict[str, set[str]] = defaultdict(set)
    candidate_labels = set()
    for label, group_records in by_label.items():
        unique_records = []
        for record in group_records:
            symbol = str(record.get("symbol", ""))
            if symbol in seen_symbols_by_label[label]:
                continue
            seen_symbols_by_label[label].add(symbol)
            unique_records.append(record)
        if not unique_records:
            continue

        keywords = set()
        for key in label_keys[label]:
            keywords.update(evidence_feature_tokens(key, product_tokens))
        keywords.update(evidence_feature_tokens(label, product_tokens))
        if not keywords:
            keywords.update(record_identity_tokens(unique_records[0], product_tokens)[:4])

        comment_evidence = comment_evidence_for_feature(unique_records, repo_context, keywords)
        for key in label_keys[label]:
            comment_evidence.extend(hypothesis_evidence.get(key, []))
        deduped_comment_evidence = []
        seen_comment_keys = set()
        for item in comment_evidence:
            item_key = (item.get("file"), item.get("line"), item.get("text"))
            if item_key in seen_comment_keys:
                continue
            seen_comment_keys.add(item_key)
            deduped_comment_evidence.append(item)
        comment_evidence = deduped_comment_evidence[:8]
        source_set = label_sources.get(label, set())
        primary_source = (
            "ui_feature_seed" if "ui_feature_seed" in source_set
            else "human_facing_text" if "human_facing_text" in source_set
            else "code_evidence"
        )
        score = feature_candidate_score(unique_records, len(comment_evidence))
        if primary_source == "ui_feature_seed":
            score += 1000 + int(label_confidence.get(label, 0.95) * 100)
        elif primary_source == "human_facing_text":
            score += 500 + int(label_confidence.get(label, 0.5) * 100)
        ranked_records = sorted(
            unique_records,
            key=lambda record: (
                feature_anchor_type(record) in {"api_route", "html_ui", "frontend_ui_component", "android_ui_xml", "ui_logic"},
                int(record.get("in_degree", 0) or 0) + int(record.get("out_degree", 0) or 0),
                int(record.get("line_count", 0) or 0),
            ),
            reverse=True,
        )
        candidates.append({
            "_score": score,
            "feature": label,
            "status": "implemented",
            "visibility": aggregate_visibility(unique_records),
            "reachability": aggregate_reachability(unique_records),
            "feature_extraction": {
                "name_source": primary_source,
                "name_role": "UI/text seed for naming only" if primary_source in {"ui_feature_seed", "human_facing_text"} else "code evidence derived name",
                "boundary_source": "entrypoints plus callgraph walk",
                "cluster_source": "callgraph component grouping",
            },
            "match_count": len(unique_records),
            "static_counts": graph_health_counts(unique_records),
            "anchors": feature_anchor_summary(unique_records),
            "feature_entrypoints": feature_entrypoint_records(unique_records),
            "implementation_boundary": feature_callgraph_boundary(unique_records),
            "callgraph_clusters": feature_callgraph_clusters(unique_records),
            "ui_evidence": [
                feature_anchor_payload(record)
                for record in unique_records
                if feature_anchor_type(record) in {"html_ui", "android_ui_xml", "frontend_ui_component", "ui_logic"}
            ][:8],
            "incomplete_signals": incomplete_feature_signals(unique_records),
            "comment_evidence": comment_evidence,
            "evidence": [
                evidence_record_payload(record, keywords)
                for record in ranked_records[:examples]
            ],
            "subfeatures": build_evidence_subfeatures(unique_records, product_tokens, examples),
            "source": primary_source,
            "matched_terms": sorted(keywords)[:8],
        })
        candidate_labels.add(label.lower())

    for hypothesis in text_hypotheses:
        if hypothesis.get("source") != "ui_feature_seed":
            continue
        label = str(hypothesis.get("label") or hypothesis.get("key") or "").strip()
        if not label or label.lower() in candidate_labels:
            continue
        keywords = set(hypothesis.get("keywords") or [])
        candidates.append({
            "_score": int(90 * float(hypothesis.get("confidence") or 0.95)),
            "feature": label,
            "status": "detected_from_ui",
            "visibility": "UI-visible",
            "reachability": "UI label found in HTML/dashboard text",
            "feature_extraction": {
                "name_source": "ui_feature_seed",
                "name_role": "UI seed for naming only; no implementation boundary found yet",
                "boundary_source": "ui_label_only",
                "cluster_source": "none",
            },
            "match_count": 0,
            "static_counts": graph_health_counts([]),
            "anchors": {},
            "feature_entrypoints": [],
            "implementation_boundary": {"strategy": "ui_seed_only", "entrypoints": [], "nodes": [], "node_count": 0},
            "callgraph_clusters": [],
            "ui_evidence": [],
            "incomplete_signals": [],
            "comment_evidence": hypothesis.get("text_evidence") or [],
            "evidence": [],
            "subfeatures": [],
            "source": "ui_feature_seed",
            "matched_terms": sorted(keywords)[:8],
        })
        candidate_labels.add(label.lower())

    ui_candidates = [row for row in candidates if row.get("source") in {"ui_feature_seed", "human_facing_text"}]
    if len(ui_candidates) >= 5:
        code_candidates = [row for row in candidates if row.get("source") not in {"ui_feature_seed", "human_facing_text"}]
        ui_candidates.sort(key=lambda row: (row["_score"], row["match_count"]), reverse=True)
        code_candidates.sort(key=lambda row: (row["_score"], row["match_count"]), reverse=True)
        candidates = ui_candidates[:12] + code_candidates[: max(0, 12 - len(ui_candidates[:12]))]
    else:
        candidates.sort(key=lambda row: (row["_score"], row["match_count"]), reverse=True)
    for row in candidates:
        row.pop("_score", None)
    return candidates[:12]


def print_health_counts(prefix: str, counts: dict[str, int]) -> None:
    total = max(1, counts["functions"])
    print(f"{prefix}functions: {counts['functions']}")
    print(
        f"{prefix}uncalled in extracted graph: {counts['uncalled_in_extracted_graph']} "
        f"({counts['uncalled_in_extracted_graph'] / total:.1%})"
    )
    print(
        f"{prefix}no outgoing calls in extracted graph: {counts['no_outgoing_calls_in_extracted_graph']} "
        f"({counts['no_outgoing_calls_in_extracted_graph'] / total:.1%})"
    )
    print(
        f"{prefix}isolated in extracted graph: {counts['isolated_in_extracted_graph']} "
        f"({counts['isolated_in_extracted_graph'] / total:.1%})"
    )
    print(f"{prefix}large functions >=100 lines: {counts['large_functions_100_plus_lines']}")


def feature_health_label(counts: dict[str, int], subfeatures_present: int, subfeatures_total: int) -> str:
    if counts["functions"] == 0:
        return "no detected implementation"
    isolated_ratio = counts["isolated_in_extracted_graph"] / max(1, counts["functions"])
    subfeature_ratio = subfeatures_present / max(1, subfeatures_total)
    if isolated_ratio <= 0.15 and subfeature_ratio >= 0.75:
        return "lower static risk"
    if isolated_ratio <= 0.35 and subfeature_ratio >= 0.50:
        return "medium static risk"
    return "higher static risk"


def list_feature_health_estimate(dataset_dir: Path, repo_id: str | None, examples: int) -> None:
    records = load_feature_records(dataset_dir, repo_id)
    product_name, product_type, _ = infer_product_name(records, repo_id)
    feature_catalog, subfeature_catalog, _ = select_feature_catalog(records, product_type)

    title_repo = repo_id or "all repos"
    print("Feature health estimate")
    print("Important: this is NOT a correctness proof. It reports measurable static facts from extracted code and callgraphs.")
    print("Terms like 'uncalled' mean uncalled in the extracted graph, not guaranteed dead code.")
    print()
    print(f"Product: {product_name}")
    print(f"Type: {product_type}")
    print(f"Repo: {title_repo}")
    print(f"Functions analyzed: {len(records)}")

    for index, (label, keywords) in enumerate(feature_catalog, start=1):
        matches = match_records(records, keywords)
        if not matches:
            continue
        feature_records = [record for _, record in matches]
        counts = graph_health_counts(feature_records)

        subfeatures = subfeature_catalog.get(label, [])
        present_subfeatures = []
        missing_subfeatures = []
        for sub_label, sub_keywords in subfeatures:
            sub_matches = match_records(records, sub_keywords)
            if sub_matches:
                present_subfeatures.append((sub_label, len(sub_matches)))
            else:
                missing_subfeatures.append(sub_label)

        label_estimate = feature_health_label(counts, len(present_subfeatures), len(subfeatures))
        print()
        print(f"{index}. {label}")
        print(f"   Estimate label: {label_estimate}")
        print_health_counts("   ", counts)
        if subfeatures:
            print(f"   subfeatures detected: {len(present_subfeatures)}/{len(subfeatures)}")
            if present_subfeatures:
                present_text = ", ".join(f"{name} [{count}]" for name, count in present_subfeatures)
                print(f"   present: {present_text}")
            if missing_subfeatures:
                print(f"   not detected by keywords: {', '.join(missing_subfeatures)}")

        central = sorted(
            feature_records,
            key=lambda record: int(record.get("in_degree", 0)) + int(record.get("out_degree", 0)),
            reverse=True,
        )[:examples]
        if central:
            print("   most connected functions:")
            for record in central:
                degree = int(record.get("in_degree", 0)) + int(record.get("out_degree", 0))
                print(f"   - {record['symbol']} degree={degree}")


def list_feature_catalog(dataset_dir: Path, repo_id: str | None, examples: int, subfeatures: bool, verbose: bool) -> None:
    records = load_feature_records(dataset_dir, repo_id)
    product_name, product_type, _ = infer_product_name(records, repo_id)
    feature_catalog, subfeature_catalog, _ = select_feature_catalog(records, product_type)
    scored_features = []
    for label, keywords in feature_catalog:
        matches = match_records(records, keywords)
        if not matches:
            continue
        scored_features.append((len(matches), label, matches[:examples]))

    scored_features.sort(key=lambda item: item[0], reverse=True)

    title_repo = repo_id or "all repos"
    print(f"Product: {product_name}")
    print(f"Type: {product_type}")
    print(f"Repo: {title_repo}")
    print(f"Feature catalog: {len(records)} functions")
    for index, (size, label, matches) in enumerate(scored_features, start=1):
        print()
        print(f"{index}. {label}  [{size} matching functions]")
        if verbose:
            for score, record in matches:
                print(f"   - {record['symbol']}  {record['path']}:{record['start_line']}  score={score}")
        if subfeatures:
            subfeature_rows = []
            for sub_label, sub_keywords in subfeature_catalog.get(label, []):
                sub_matches = match_records(records, sub_keywords)
                if sub_matches:
                    subfeature_rows.append((len(sub_matches), sub_label, sub_matches[: max(1, min(3, examples))]))
            if subfeature_rows:
                print("   Subfeatures:")
                for sub_size, sub_label, sub_matches in sorted(subfeature_rows, key=lambda row: row[0], reverse=True):
                    if verbose:
                        sample = "; ".join(
                            f"{record['symbol']}:{record['start_line']}" for _, record in sub_matches[:2]
                        )
                        print(f"   - {sub_label} [{sub_size}] {sample}")
                    else:
                        print(f"   - {sub_label} [{sub_size}]")


def feature_catalog_payload(dataset_dir: Path, repo_id: str | None = None, examples: int = 5, repo_context: dict | None = None) -> dict:
    return {
        "features": [],
        "feature_count": 0,
        "disabled": True,
        "reason": "Feature catalog generation is disabled; CODE.md publishes deterministic truth-index artifacts only.",
    }
    records = load_feature_records(dataset_dir, repo_id)
    product_name, product_type, product_name_source = infer_product_name(records, repo_id, repo_context)
    evidence_features = evidence_feature_candidates(records, product_name, product_type, examples, repo_context)
    if evidence_features:
        return {
            "source": "evidence_feature_candidates",
            "note": "Evidence-backed feature candidates built from README/docs/text, UI/API anchors, functions, paths, and extracted graph metadata. Names are deterministic input for later summary generation; they are not LLM guesses. Reachability is based on the extracted graph and UI/API hints, not runtime proof.",
            "product_name": product_name,
            "product_name_source": product_name_source,
            "product_type": product_type,
            "ui_feature_seeds": (repo_context or {}).get("ui_feature_seeds", []) if isinstance(repo_context, dict) else [],
            "readme_evidence": (repo_context or {}).get("readme_items", [])[:12] if isinstance(repo_context, dict) else [],
            "document_evidence": (repo_context or {}).get("document_items", [])[:20] if isinstance(repo_context, dict) else [],
            "repo_id": repo_id,
            "functions_analyzed": len(records),
            "features": evidence_features,
        }

    feature_catalog, subfeature_catalog, catalog_source = select_feature_catalog(records, product_type)
    features = []

    for label, keywords in feature_catalog:
        matches = match_records(records, keywords)
        if not matches:
            continue

        feature_records = [record for _, record in matches]
        counts = graph_health_counts(feature_records)
        evidence = [
            evidence_payload(score, record, keywords)
            for score, record in matches[:examples]
        ]

        subfeatures = []
        for sub_label, sub_keywords in subfeature_catalog.get(label, []):
            sub_matches = match_records(records, sub_keywords)
            if not sub_matches:
                continue
            subfeatures.append({
                "name": sub_label,
                "status": "implemented",
                "visibility": aggregate_visibility([record for _, record in sub_matches]),
                "reachability": aggregate_reachability([record for _, record in sub_matches]),
                "match_count": len(sub_matches),
                "evidence": [
                    evidence_payload(score, record, sub_keywords)
                    for score, record in sub_matches[: max(1, min(3, examples))]
                ],
            })

        features.append({
            "feature": label,
            "status": "implemented",
            "visibility": aggregate_visibility(feature_records),
            "reachability": aggregate_reachability(feature_records),
            "feature_extraction": {
                "name_source": catalog_source,
                "name_role": "code evidence derived name",
                "boundary_source": "entrypoints plus callgraph walk",
                "cluster_source": "callgraph component grouping",
            },
            "match_count": len(matches),
            "static_counts": counts,
            "anchors": feature_anchor_summary(feature_records),
            "feature_entrypoints": feature_entrypoint_records(feature_records),
            "implementation_boundary": feature_callgraph_boundary(feature_records),
            "callgraph_clusters": feature_callgraph_clusters(feature_records),
            "ui_evidence": [
                feature_anchor_payload(record)
                for record in feature_records
                if feature_anchor_type(record) in {"html_ui", "android_ui_xml", "frontend_ui_component", "ui_logic"}
            ][:8],
            "incomplete_signals": incomplete_feature_signals(feature_records),
            "comment_evidence": comment_evidence_for_feature(feature_records, repo_context, keywords),
            "evidence": evidence,
            "subfeatures": sorted(subfeatures, key=lambda row: row["match_count"], reverse=True),
        })

    features.sort(key=lambda row: row["match_count"], reverse=True)
    return {
        "source": catalog_source,
        "note": "Evidence-only feature clusters. Path and identifier clusters are preferred as input for later summary generation; static keyword catalogs are used only as fallback. Status means matching implementation evidence was found. Reachability is based on the extracted graph and UI/API entrypoint hints; it is not a runtime proof.",
        "product_name": product_name,
        "product_name_source": product_name_source,
        "product_type": product_type,
        "ui_feature_seeds": (repo_context or {}).get("ui_feature_seeds", []) if isinstance(repo_context, dict) else [],
        "readme_evidence": (repo_context or {}).get("readme_items", [])[:12] if isinstance(repo_context, dict) else [],
        "document_evidence": (repo_context or {}).get("document_items", [])[:20] if isinstance(repo_context, dict) else [],
        "repo_id": repo_id,
        "functions_analyzed": len(records),
        "features": features,
    }


def list_feature_clusters(dataset_dir: Path, repo_id: str | None, clusters: int, examples: int) -> None:
    records = load_feature_records(dataset_dir, repo_id, include_embeddings=True)

    if KMeans is None:
        raise RuntimeError("scikit-learn is not installed, so feature clustering is unavailable.")

    cluster_count = max(1, min(clusters, len(records)))
    matrix = np.asarray([record["fused_embedding"] for record in records], dtype=np.float32)
    norms = np.linalg.norm(matrix, axis=1, keepdims=True)
    matrix = matrix / np.maximum(norms, 1e-9)

    kmeans = KMeans(n_clusters=cluster_count, random_state=7, n_init=10)
    labels = kmeans.fit_predict(matrix)
    centers = kmeans.cluster_centers_

    feature_rows = []
    for cluster_id in range(cluster_count):
        member_indices = np.where(labels == cluster_id)[0]
        if not len(member_indices):
            continue
        term_counts: Counter[str] = Counter()
        for index in member_indices:
            record = records[int(index)]
            term_counts.update(feature_terms(record))

        center = centers[cluster_id]
        distances = np.linalg.norm(matrix[member_indices] - center, axis=1)
        representative_indices = member_indices[np.argsort(distances)[:examples]]
        top_terms = [term for term, _ in term_counts.most_common(6)]
        feature_rows.append((len(member_indices), top_terms, representative_indices))

    feature_rows.sort(key=lambda row: row[0], reverse=True)

    title_repo = repo_id or "all repos"
    print(f"Feature clusters for {title_repo} ({len(records)} functions, {len(feature_rows)} clusters)")
    for feature_number, (size, terms, representative_indices) in enumerate(feature_rows, start=1):
        label = " / ".join(terms[:4]) if terms else "misc"
        print()
        print(f"{feature_number}. {label}  [{size} functions]")
        if len(terms) > 4:
            print(f"   terms: {', '.join(terms)}")
        for index in representative_indices:
            record = records[int(index)]
            print(f"   - {record['symbol']}  {record['path']}:{record['start_line']}")


def sigmoid(values: np.ndarray) -> np.ndarray:
    return 1.0 / (1.0 + np.exp(-np.clip(values, -40, 40)))


def pair_features(left: np.ndarray, right: np.ndarray) -> np.ndarray:
    return np.concatenate([np.abs(left - right), left * right]).astype(np.float32)


def train_link_model(dataset_dir: Path, epochs: int, negatives: int, learning_rate: float) -> None:
    dataset_dir = resolve_dataset_dir(dataset_dir)
    symbol_vectors: dict[str, np.ndarray] = {}
    with (dataset_dir / "functions.jsonl").open("r", encoding="utf-8") as handle:
        for line in handle:
            record = json.loads(line)
            symbol_vectors.setdefault(record["symbol"], np.asarray(record["fused_embedding"], dtype=np.float32))

    positive_pairs: list[tuple[str, str]] = []
    with architecture_dataset_path(dataset_dir, "edges.csv").open("r", encoding="utf-8", newline="") as handle:
        for row in csv.DictReader(handle):
            if row["source"] in symbol_vectors and row["target"] in symbol_vectors:
                positive_pairs.append((row["source"], row["target"]))

    if not positive_pairs:
        raise ValueError("No trainable graph edges found where both endpoints have embeddings.")

    random.seed(7)
    symbols = list(symbol_vectors)
    negative_pairs: list[tuple[str, str]] = []
    positive_set = set(positive_pairs)
    while len(negative_pairs) < len(positive_pairs) * negatives:
        source = random.choice(symbols)
        target = random.choice(symbols)
        if source != target and (source, target) not in positive_set:
            negative_pairs.append((source, target))

    pairs = positive_pairs + negative_pairs
    labels = np.asarray([1.0] * len(positive_pairs) + [0.0] * len(negative_pairs), dtype=np.float32)
    features = np.vstack([pair_features(symbol_vectors[source], symbol_vectors[target]) for source, target in pairs])

    order = np.arange(len(labels))
    rng = np.random.default_rng(7)
    rng.shuffle(order)
    split = max(1, int(len(order) * 0.8))
    train_idx = order[:split]
    test_idx = order[split:]

    weights = np.zeros(features.shape[1], dtype=np.float32)
    bias = 0.0
    train_labels = labels[train_idx]
    positive_rate = float(np.mean(train_labels))
    class_weights = np.where(
        train_labels > 0.5,
        0.5 / max(1e-6, positive_rate),
        0.5 / max(1e-6, 1.0 - positive_rate),
    )
    for _ in range(epochs):
        logits = features[train_idx] @ weights + bias
        predictions = sigmoid(logits)
        errors = (predictions - train_labels) * class_weights
        weights -= learning_rate * ((features[train_idx].T @ errors) / len(train_idx))
        bias -= learning_rate * float(np.mean(errors))

    test_logits = features[test_idx] @ weights + bias if len(test_idx) else features[train_idx] @ weights + bias
    test_labels = labels[test_idx] if len(test_idx) else labels[train_idx]
    test_predictions = sigmoid(test_logits)
    accuracy = float(np.mean((test_predictions >= 0.5) == test_labels))

    model = {
        "kind": "scim_link_predictor_logistic_regression",
        "feature": "concat(abs(a-b), a*b)",
        "epochs": epochs,
        "learning_rate": learning_rate,
        "positive_pairs": len(positive_pairs),
        "negative_pairs": len(negative_pairs),
        "accuracy": accuracy,
        "bias": bias,
        "weights": weights.astype(float).tolist(),
    }
    model_path = dataset_dir / "link_model.json"
    model_path.write_text(json.dumps(model), encoding="utf-8")
    manifest_path = architecture_dataset_path(dataset_dir, "manifest.json")
    if manifest_path.exists():
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest.setdefault("files", {})["link_model"] = str(model_path)
        manifest["link_model"] = {
            "kind": model["kind"],
            "positive_pairs": model["positive_pairs"],
            "negative_pairs": model["negative_pairs"],
            "accuracy": model["accuracy"],
        }
        manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(f"Wrote link prediction model to {model_path}")
    print(f"Held-out accuracy: {accuracy:.3f} on {len(test_labels)} examples")


def predict_link(dataset_dir: Path, source: str, target: str) -> None:
    dataset_dir = resolve_dataset_dir(dataset_dir)
    model_path = dataset_dir / "link_model.json"

    vectors: dict[str, np.ndarray] = {}
    with (dataset_dir / "functions.jsonl").open("r", encoding="utf-8") as handle:
        for line in handle:
            record = json.loads(line)
            if record["symbol"] in {source, target}:
                vectors[record["symbol"]] = np.asarray(record["fused_embedding"], dtype=np.float32)

    missing = [symbol for symbol in (source, target) if symbol not in vectors]
    if missing:
        raise ValueError(f"Could not find embeddings for: {', '.join(missing)}")

    feature = pair_features(vectors[source], vectors[target])

    neural_model_path = dataset_dir / "neural_link_model.pt"
    if neural_model_path.exists():
        if torch is None or nn is None:
            raise RuntimeError("PyTorch is not installed, so the neural link model cannot be loaded.")
        checkpoint = torch.load(neural_model_path, map_location="cpu", weights_only=False)
        model = nn.Sequential(
            nn.Linear(int(checkpoint["input_dim"]), 256),
            nn.ReLU(),
            nn.Dropout(0.1),
            nn.Linear(256, 64),
            nn.ReLU(),
            nn.Linear(64, 1),
        )
        model.load_state_dict(checkpoint["state_dict"])
        model.eval()
        with torch.no_grad():
            tensor = torch.from_numpy(feature.reshape(1, -1))
            probability = float(torch.sigmoid(model(tensor))[0, 0].item())
        print(f"{probability:.4f}  {source} -> {target}  neural")
        return

    if not model_path.exists():
        raise FileNotFoundError(
            f"No link model found at {model_path} or {neural_model_path}. "
            "Run train-link-model or train-neural-link-model first."
        )

    model = json.loads(model_path.read_text(encoding="utf-8"))
    weights = np.asarray(model["weights"], dtype=np.float32)
    bias = float(model["bias"])
    probability = float(sigmoid(np.asarray([feature @ weights + bias], dtype=np.float32))[0])
    print(f"{probability:.4f}  {source} -> {target}")


def load_symbol_vectors_and_edges(dataset_dir: Path) -> tuple[dict[str, np.ndarray], list[tuple[str, str]]]:
    dataset_dir = resolve_dataset_dir(dataset_dir)
    symbol_vectors: dict[str, np.ndarray] = {}
    with (dataset_dir / "functions.jsonl").open("r", encoding="utf-8") as handle:
        for line in handle:
            record = json.loads(line)
            symbol_vectors.setdefault(record["symbol"], np.asarray(record["fused_embedding"], dtype=np.float32))

    positive_pairs: list[tuple[str, str]] = []
    with architecture_dataset_path(dataset_dir, "edges.csv").open("r", encoding="utf-8", newline="") as handle:
        for row in csv.DictReader(handle):
            if row["source"] in symbol_vectors and row["target"] in symbol_vectors:
                positive_pairs.append((row["source"], row["target"]))
    return symbol_vectors, positive_pairs


def make_pair_dataset(
    symbol_vectors: dict[str, np.ndarray],
    positive_pairs: list[tuple[str, str]],
    negatives: int,
) -> tuple[np.ndarray, np.ndarray]:
    if not positive_pairs:
        raise ValueError("No trainable graph edges found where both endpoints have embeddings.")

    random.seed(7)
    symbols = list(symbol_vectors)
    positive_set = set(positive_pairs)
    negative_pairs: list[tuple[str, str]] = []
    while len(negative_pairs) < len(positive_pairs) * negatives:
        source = random.choice(symbols)
        target = random.choice(symbols)
        if source != target and (source, target) not in positive_set:
            negative_pairs.append((source, target))

    pairs = positive_pairs + negative_pairs
    labels = np.asarray([1.0] * len(positive_pairs) + [0.0] * len(negative_pairs), dtype=np.float32)
    features = np.vstack([pair_features(symbol_vectors[source], symbol_vectors[target]) for source, target in pairs])
    return features, labels


def train_neural_link_model(dataset_dir: Path, epochs: int, negatives: int, learning_rate: float, batch_size: int) -> None:
    dataset_dir = resolve_dataset_dir(dataset_dir)
    if torch is None or nn is None:
        raise RuntimeError("PyTorch is not installed. Install torch or use train-link-model.")

    symbol_vectors, positive_pairs = load_symbol_vectors_and_edges(dataset_dir)
    features, labels = make_pair_dataset(symbol_vectors, positive_pairs, negatives)

    rng = np.random.default_rng(7)
    order = np.arange(len(labels))
    rng.shuffle(order)
    split = max(1, int(len(order) * 0.8))
    train_idx = order[:split]
    test_idx = order[split:]

    train_x = torch.from_numpy(features[train_idx])
    train_y = torch.from_numpy(labels[train_idx]).reshape(-1, 1)
    test_x = torch.from_numpy(features[test_idx])
    test_y = torch.from_numpy(labels[test_idx]).reshape(-1, 1)

    model = nn.Sequential(
        nn.Linear(features.shape[1], 256),
        nn.ReLU(),
        nn.Dropout(0.1),
        nn.Linear(256, 64),
        nn.ReLU(),
        nn.Linear(64, 1),
    )
    positive_rate = float(train_y.mean().item())
    pos_weight = torch.tensor([(1.0 - positive_rate) / max(1e-6, positive_rate)], dtype=torch.float32)
    loss_fn = nn.BCEWithLogitsLoss(pos_weight=pos_weight)
    optimizer = torch.optim.AdamW(model.parameters(), lr=learning_rate, weight_decay=1e-4)

    generator = torch.Generator().manual_seed(7)
    for epoch in range(1, epochs + 1):
        permutation = torch.randperm(train_x.shape[0], generator=generator)
        model.train()
        total_loss = 0.0
        for start in range(0, train_x.shape[0], batch_size):
            batch_idx = permutation[start : start + batch_size]
            logits = model(train_x[batch_idx])
            loss = loss_fn(logits, train_y[batch_idx])
            optimizer.zero_grad()
            loss.backward()
            optimizer.step()
            total_loss += float(loss.item()) * len(batch_idx)
        if epoch == 1 or epoch == epochs or epoch % max(1, epochs // 5) == 0:
            print(f"epoch {epoch}/{epochs} loss={total_loss / train_x.shape[0]:.4f}")

    model.eval()
    with torch.no_grad():
        probabilities = torch.sigmoid(model(test_x))
        accuracy = float(((probabilities >= 0.5) == test_y.bool()).float().mean().item())

    model_path = dataset_dir / "neural_link_model.pt"
    metadata_path = dataset_dir / "neural_link_model.json"
    torch.save(
        {
            "state_dict": model.state_dict(),
            "input_dim": features.shape[1],
            "architecture": "Linear-ReLU-Dropout-Linear-ReLU-Linear",
        },
        model_path,
    )
    metadata = {
        "kind": "scim_neural_link_predictor",
        "framework": "pytorch",
        "epochs": epochs,
        "learning_rate": learning_rate,
        "positive_pairs": len(positive_pairs),
        "negative_pairs": len(labels) - len(positive_pairs),
        "accuracy": accuracy,
        "model": str(model_path),
    }
    metadata_path.write_text(json.dumps(metadata, indent=2), encoding="utf-8")

    manifest_path = architecture_dataset_path(dataset_dir, "manifest.json")
    if manifest_path.exists():
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest.setdefault("files", {})["neural_link_model"] = str(model_path)
        manifest.setdefault("files", {})["neural_link_model_metadata"] = str(metadata_path)
        manifest["neural_link_model"] = metadata
        manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    print(f"Wrote neural link model to {model_path}")
    print(f"Held-out accuracy: {accuracy:.3f} on {len(test_idx)} examples")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build a fused code + callgraph dataset from extracted repos.")
    subparsers = parser.add_subparsers(dest="command")

    build = subparsers.add_parser("build", help="Build JSONL/CSV model artifacts.")
    build.add_argument("--input", type=Path, default=DEFAULT_INPUT, help="Output root or a single extracted repo folder.")
    build.add_argument("--output", type=Path, default=DEFAULT_OUTPUT, help="Dataset output folder.")
    build.add_argument("--include-code", action="store_true", help="Store raw code inside JSONL records.")
    build.add_argument("--backend", choices=["tfidf", "sbert"], default="tfidf", help="Embedding backend.")
    build.add_argument("--sbert-model", default=DEFAULT_SBERT_MODEL, help="SentenceTransformer model for --backend sbert.")
    build.add_argument("--batch-size", type=int, default=32, help="Embedding batch size for transformer backends.")
    build.add_argument("--no-vector-db", action="store_true", help="Skip writing vectors.sqlite.")
    build.add_argument("--no-faiss", action="store_true", help="Skip writing vectors.faiss.")

    generic = subparsers.add_parser("build-generic", help="Build a broader multi-repo fitted embedding model.")
    generic.add_argument("--input", type=Path, default=DEFAULT_INPUT, help="Output root containing extracted repo folders.")
    generic.add_argument("--output", type=Path, default=Path("scim_dataset_generic"), help="Generic dataset output folder.")
    generic.add_argument("--include-code", action="store_true", help="Store raw code inside JSONL records.")
    generic.add_argument("--backend", choices=["tfidf", "sbert"], default="sbert", help="Embedding backend.")
    generic.add_argument("--sbert-model", default=DEFAULT_SBERT_MODEL, help="SentenceTransformer model for --backend sbert.")
    generic.add_argument("--batch-size", type=int, default=32, help="Embedding batch size for transformer backends.")
    generic.add_argument("--no-vector-db", action="store_true", help="Skip writing vectors.sqlite.")
    generic.add_argument("--no-faiss", action="store_true", help="Skip writing vectors.faiss.")

    search = subparsers.add_parser("search", help="Search the fused embedding dataset.")
    search.add_argument("query", help="Natural language or code-ish query.")
    search.add_argument("--dataset", type=Path, default=DEFAULT_OUTPUT, help="Dataset folder created by build.")
    search.add_argument("--limit", type=int, default=10, help="Number of results to print.")

    features = subparsers.add_parser("features", help="Cluster functions into likely feature areas.")
    features.add_argument("--dataset", type=Path, default=DEFAULT_OUTPUT, help="Dataset folder created by build.")
    features.add_argument("--repo", help="Repo id to analyze. Omit to cluster all repos together.")
    features.add_argument("--mode", choices=["catalog", "clusters"], default="catalog", help="Feature catalog or raw embedding clusters.")
    features.add_argument("--clusters", type=int, default=12, help="Number of feature clusters to produce.")
    features.add_argument("--examples", type=int, default=5, help="Representative functions per cluster.")
    features.add_argument("--no-subfeatures", action="store_true", help="Hide subfeature breakdowns in catalog mode.")
    features.add_argument("--verbose", action="store_true", help="Show representative functions and file locations.")
    features.add_argument(
        "--health-estimate",
        action="store_true",
        help="Show measurable static feature health signals. This is explicitly an estimate, not a correctness proof.",
    )

    train = subparsers.add_parser("train-link-model", help="Train a graph-aware link predictor from fused embeddings.")
    train.add_argument("--dataset", type=Path, default=DEFAULT_OUTPUT, help="Dataset folder created by build.")
    train.add_argument("--epochs", type=int, default=250, help="Training epochs.")
    train.add_argument("--negatives", type=int, default=2, help="Negative samples per positive edge.")
    train.add_argument("--learning-rate", type=float, default=0.5, help="Gradient descent learning rate.")

    predict = subparsers.add_parser("predict-link", help="Score whether one function likely calls/depends on another.")
    predict.add_argument("source", help="Source symbol, e.g. Dungeon.resetLevel.")
    predict.add_argument("target", help="Target symbol, e.g. Dungeon.switchLevel.")
    predict.add_argument("--dataset", type=Path, default=DEFAULT_OUTPUT, help="Dataset folder created by build.")

    neural = subparsers.add_parser("train-neural-link-model", help="Train a PyTorch MLP on fused embeddings and graph edges.")
    neural.add_argument("--dataset", type=Path, default=DEFAULT_OUTPUT, help="Dataset folder created by build.")
    neural.add_argument("--epochs", type=int, default=8, help="Training epochs.")
    neural.add_argument("--negatives", type=int, default=2, help="Negative samples per positive edge.")
    neural.add_argument("--learning-rate", type=float, default=0.001, help="AdamW learning rate.")
    neural.add_argument("--batch-size", type=int, default=1024, help="Training batch size.")

    parser.set_defaults(command="build")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if args.command == "search":
        search_dataset(args.dataset, args.query, args.limit)
        return
    if args.command == "features":
        if args.health_estimate:
            list_feature_health_estimate(args.dataset, args.repo, args.examples)
            return
        if args.mode == "clusters":
            list_feature_clusters(args.dataset, args.repo, args.clusters, args.examples)
        else:
            list_feature_catalog(args.dataset, args.repo, args.examples, not args.no_subfeatures, args.verbose)
        return
    if args.command == "train-link-model":
        train_link_model(args.dataset, args.epochs, args.negatives, args.learning_rate)
        return
    if args.command == "predict-link":
        predict_link(args.dataset, args.source, args.target)
        return
    if args.command == "train-neural-link-model":
        train_neural_link_model(args.dataset, args.epochs, args.negatives, args.learning_rate, args.batch_size)
        return
    if args.command == "build-generic":
        write_dataset(
            args.input,
            args.output,
            args.include_code,
            args.backend,
            not args.no_vector_db,
            not args.no_faiss,
            args.sbert_model,
            args.batch_size,
            True,
        )
        print(f"Wrote generic SCIM dataset to {args.output.resolve()}")
        print(f"Open {architecture_dataset_path(args.output, 'manifest.json')} for counts and artifact paths.")
        return
    write_dataset(
        args.input,
        args.output,
        args.include_code,
        args.backend,
        not args.no_vector_db,
        not args.no_faiss,
        args.sbert_model,
        args.batch_size,
    )
    print(f"Wrote SCIM dataset to {args.output.resolve()}")
    print(f"Open {architecture_dataset_path(args.output, 'manifest.json')} for counts and artifact paths.")


if __name__ == "__main__":
    main()
