# Responsibilities:
#   - Parse HTML/HTM/XHTML for user-facing UI feature labels
#   - Walk UI containers in document order
#   - Return candidate feature names, not implementation notes

import os
import json
import re

from bs4 import BeautifulSoup


HEADING_TAGS = ["h1", "h2", "h3", "h4", "h5", "h6", "h7"]
SECTION_TAGS = {
    "section", "article", "main",
    "form", "fieldset", "dialog",
}
SECTION_ROLES = {
    "region", "main", "navigation", "form", "dialog", "tabpanel",
    "complementary", "contentinfo", "banner", "search",
}
CONTROL_TAGS = {"button", "a", "label", "option", "summary", "legend"}
INPUT_TAGS = {"input", "textarea", "select"}
NAV_ITEM_ROLES = {"menuitem", "tab", "treeitem", "option"}
TITLE_ATTRS = (
    "aria-label", "aria-labelledby", "data-title", "data-label",
    "data-name", "data-section", "data-feature", "title",
)
CONTAINER_WORD_RE = re.compile(
    r"\b(section|panel|card|module|widget|feature|tool|block|tile|view|page|screen|"
    r"summary|settings|nav|tab|modal|dialog|hero|banner|content|step|workflow|item)\b",
    re.IGNORECASE,
)
TITLE_WORD_RE = re.compile(r"\b(title|heading|headline|label|caption|name)\b", re.IGNORECASE)
CODE_OR_DOC_NOTE_RE = re.compile(
    r"^\s*(from\s+\S+\s+import|import\s+\S+|todo\s*[-:]|fixme\b|added\s+new\s+import|"
    r"def\s+|class\s+|const\s+|let\s+|var\s+)",
    re.IGNORECASE,
)
CONFIG_SECTION_RE = re.compile(
    r"\{\s*id\s*:\s*(['\"])(?P<id>[^'\"]{1,120})\1(?P<body>[^{}]{0,600}?)\btitle\s*:\s*(['\"])(?P<title>[^'\"]{3,100})\4",
    re.IGNORECASE | re.DOTALL,
)


def _clean_text(value: str, max_len: int = 100) -> str:
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    text = text.strip("*_`#")
    text = re.sub(r"^[^\w]+", "", text, flags=re.UNICODE).strip()
    if not text or len(text) < 3 or len(text) > max_len:
        return ""
    lower = text.lower()
    if lower.startswith(("open ", "open to ", "run a search ", "choose ", "helper ", "optional:", "http://", "https://", "/api/", "#", "javascript:")):
        return ""
    word_count = len(re.findall(r"[A-Za-z]+", text))
    if re.search(r"[.!?…]\s*$", text):
        return ""
    if word_count > 7:
        return ""
    if word_count > 5 and re.search(r"\bto\b", lower):
        return ""
    if CODE_OR_DOC_NOTE_RE.search(text):
        return ""
    if re.search(r"[{}();=<>]", text):
        return ""
    return text


def _class_text(tag) -> str:
    classes = tag.get("class") or []
    if isinstance(classes, str):
        return classes
    return " ".join(str(item) for item in classes)


def _id_text_map(soup: BeautifulSoup) -> dict[str, str]:
    return {
        str(tag.get("id")): tag.get_text(" ", strip=True)
        for tag in soup.find_all(attrs={"id": True})
    }


def _attr_label(tag, id_text: dict[str, str]) -> str:
    labelledby = tag.get("aria-labelledby")
    if labelledby:
        label = " ".join(id_text.get(part, "") for part in str(labelledby).split())
        cleaned = _clean_text(label)
        if cleaned:
            return cleaned
    for attr in TITLE_ATTRS:
        if attr == "aria-labelledby":
            continue
        cleaned = _clean_text(tag.get(attr))
        if cleaned:
            return cleaned
    return ""


def _is_titleish(tag) -> bool:
    if not getattr(tag, "name", None):
        return False
    if tag.name.lower() in HEADING_TAGS:
        return True
    return bool(TITLE_WORD_RE.search(" ".join([_class_text(tag), str(tag.get("id") or "")])))


def _direct_titleish_label(tag, id_text: dict[str, str]) -> str:
    for child in tag.find_all(True, recursive=False):
        if _is_titleish(child):
            cleaned = _clean_text(child.get_text(" ", strip=True) or _attr_label(child, id_text))
            if cleaned:
                return cleaned
    first_heading = tag.find(HEADING_TAGS)
    if first_heading:
        return _clean_text(first_heading.get_text(" ", strip=True))
    first_legend = tag.find(["legend", "summary"])
    if first_legend:
        return _clean_text(first_legend.get_text(" ", strip=True))
    titleish = tag.find(lambda child: getattr(child, "name", None) and TITLE_WORD_RE.search(" ".join([_class_text(child), str(child.get("id") or "")])))
    if titleish:
        return _clean_text(titleish.get_text(" ", strip=True) or _attr_label(titleish, id_text))
    return ""


def _is_section_container(tag, id_text: dict[str, str]) -> bool:
    if not getattr(tag, "name", None):
        return False
    tag_name = tag.name.lower()
    if tag_name in {"html", "body", "script", "style", "template", "svg"}:
        return False
    if tag_name in CONTROL_TAGS or tag_name in INPUT_TAGS:
        return False
    if tag_name in {"aside", "nav", "header", "footer"} and not (_attr_label(tag, id_text) or str(tag.get("role") or "").lower() in {"region", "tabpanel", "dialog", "form"}):
        return False
    if re.search(r"\b(stat|metric|kpi|counter|badge)\b", " ".join([_class_text(tag), str(tag.get("id") or "")]), re.IGNORECASE):
        return False
    if tag_name in SECTION_TAGS:
        return True
    if str(tag.get("role") or "").lower() in SECTION_ROLES:
        return True
    if _attr_label(tag, id_text):
        return True
    return bool(CONTAINER_WORD_RE.search(" ".join([tag_name, _class_text(tag), str(tag.get("id") or "")])))


def _section_label(tag, id_text: dict[str, str]) -> str:
    return _direct_titleish_label(tag, id_text) or _attr_label(tag, id_text)


def _has_section_ancestor(tag, selected: set[int]) -> bool:
    parent = tag.parent
    while parent is not None and getattr(parent, "name", None):
        if id(parent) in selected:
            return True
        parent = parent.parent
    return False


def _section_child_count(tag, id_text: dict[str, str]) -> int:
    count = 0
    for child in tag.find_all(True):
        if child is tag:
            continue
        if _is_section_container(child, id_text) and _section_label(child, id_text):
            count += 1
    return count


def _control_label(tag, id_text: dict[str, str]) -> str:
    label = _attr_label(tag, id_text)
    if label:
        return label
    if tag.name.lower() in INPUT_TAGS:
        return _clean_text(tag.get("placeholder") or tag.get("name"))
    return _clean_text(tag.get_text(" ", strip=True))


def _is_navigation_root(tag) -> bool:
    if not getattr(tag, "name", None):
        return False
    tag_name = tag.name.lower()
    role = str(tag.get("role") or "").lower()
    if tag_name in {"nav", "aside"} or role in {"navigation", "menubar", "menu", "tablist", "toolbar", "tree"}:
        return True
    return bool(re.search(r"\b(nav|navigation|menu|tabs|tab-list|sidebar)\b", " ".join([_class_text(tag), str(tag.get("id") or "")]), re.IGNORECASE))


def _is_navigation_item(tag) -> bool:
    if not getattr(tag, "name", None):
        return False
    tag_name = tag.name.lower()
    role = str(tag.get("role") or "").lower()
    if role in NAV_ITEM_ROLES:
        return True
    if tag_name in {"a", "button"}:
        return True
    return bool(re.search(r"\b(nav-item|menu-item|tab|sidebar-item)\b", " ".join([_class_text(tag), str(tag.get("id") or "")]), re.IGNORECASE))


def extract_navigation_sections(soup: BeautifulSoup, id_text: dict[str, str]) -> list[dict]:
    sections = []
    seen = set()
    for root in soup.find_all(lambda tag: _is_navigation_root(tag)):
        for item in root.find_all(lambda tag: _is_navigation_item(tag)):
            if item.find(lambda child: child is not item and _is_navigation_item(child)):
                continue
            label = _control_label(item, id_text)
            key = label.lower()
            if not label or key in seen:
                continue
            seen.add(key)
            context = []
            for attr in ("href", "aria-controls", "data-target", "data-view-link"):
                cleaned = _clean_text(item.get(attr), max_len=140)
                if cleaned and cleaned.lower() != key and cleaned not in context:
                    context.append(cleaned)
            sections.append({
                "name": label,
                "context": context,
                "tag": item.name.lower(),
                "id": item.get("id") or "",
                "role": item.get("role") or "",
                "source": "navigation",
            })
    return sections


def extract_config_sections(html) -> list[dict]:
    """Generic fallback for client-rendered UIs with section config objects."""
    sections = []
    seen = set()
    for match in CONFIG_SECTION_RE.finditer(str(html or "")):
        section_id = _clean_text(match.group("id"), max_len=140)
        label = _clean_text(match.group("title"))
        key = (section_id.lower(), label.lower())
        if section_id and label and key not in seen:
            seen.add(key)
            sections.append({"id": section_id, "name": label})
    return sections


def extract_html_feature_sections(html) -> list[dict]:
    """Return UI sections in document order.

    Algorithm:
    1. Parse HTML with BeautifulSoup and ignore non-visible implementation tags.
    2. Walk elements top-to-bottom.
    3. Treat semantic containers, ARIA regions, titled cards/panels, forms,
       dialogs, navs, tabs, and similar blocks as candidate feature sections.
    4. Use the container's own heading/legend/summary/ARIA/data title as the
       feature name.
    5. Do not emit broad parents when their direct children are already
       labelled sections.
    6. Keep nested controls as context, not as separate feature names.
    """
    config_sections = extract_config_sections(html)
    soup = BeautifulSoup(html or "", "html.parser")
    for tag in soup.find_all(["script", "style", "template", "svg", "noscript"]):
        tag.decompose()

    id_text = _id_text_map(soup)
    sections = []
    selected_ids: set[int] = set()
    seen = set()

    for nav_section in extract_navigation_sections(soup, id_text):
        key = nav_section["name"].lower()
        if key in seen:
            continue
        seen.add(key)
        sections.append(nav_section)

    for config in config_sections:
        tag = soup.find(id=config["id"])
        label = _clean_text(config["name"])
        key = label.lower()
        if not tag or not label or key in seen:
            continue
        selected_ids.add(id(tag))
        seen.add(key)
        context = []
        for child in tag.find_all(True):
            child_name = child.name.lower()
            value = ""
            if child_name in HEADING_TAGS or child_name in CONTROL_TAGS:
                value = child.get_text(" ", strip=True)
            elif child_name in INPUT_TAGS:
                value = child.get("placeholder") or child.get("aria-label") or child.get("title") or child.get("name")
            elif _is_titleish(child):
                value = child.get_text(" ", strip=True)
            cleaned = _clean_text(value)
            if cleaned and cleaned.lower() != key and cleaned not in context:
                context.append(cleaned)
        sections.append({
            "name": label,
            "context": context[:20],
            "tag": tag.name.lower(),
            "id": tag.get("id") or "",
            "role": tag.get("role") or "",
        })

    for tag in soup.find_all(True):
        if not _is_section_container(tag, id_text):
            continue
        if _has_section_ancestor(tag, selected_ids):
            continue
        label = _section_label(tag, id_text)
        if not label:
            continue
        if _section_child_count(tag, id_text) > 1 and tag.name.lower() in {"main", "section", "article", "div"}:
            continue
        key = label.lower()
        if key in seen:
            continue
        seen.add(key)
        selected_ids.add(id(tag))
        context = []
        for child in tag.find_all(True):
            child_name = child.name.lower()
            value = ""
            if child_name in HEADING_TAGS or child_name in CONTROL_TAGS:
                value = child.get_text(" ", strip=True)
            elif child_name in INPUT_TAGS:
                value = child.get("placeholder") or child.get("aria-label") or child.get("title") or child.get("name")
            elif _is_titleish(child):
                value = child.get_text(" ", strip=True)
            cleaned = _clean_text(value)
            if cleaned and cleaned.lower() != key and cleaned not in context:
                context.append(cleaned)
        sections.append({
            "name": label,
            "context": context[:20],
            "tag": tag.name.lower(),
            "id": tag.get("id") or "",
            "role": tag.get("role") or "",
        })

    if sections:
        return sections

    fallback = []
    seen_fallback = set()
    for tag in soup.find_all(HEADING_TAGS + list(CONTROL_TAGS)):
        label = _clean_text(tag.get_text(" ", strip=True))
        key = label.lower()
        if label and key not in seen_fallback:
            seen_fallback.add(key)
            fallback.append({"name": label, "context": [], "tag": tag.name.lower(), "id": tag.get("id") or "", "role": tag.get("role") or ""})
    return fallback


def extract_html_features_text(html, max_chars=20000):
    lines = []
    seen = set()

    def add(value):
        label = _clean_text(value)
        key = label.lower()
        if label and key not in seen:
            seen.add(key)
            lines.append(label)

    for section in extract_html_feature_sections(html):
        add(section.get("name"))

    return "\n".join(lines)[:max_chars]


def _html_files(root: str):
    if not root or not os.path.exists(root):
        return
    if os.path.isfile(root):
        if os.path.splitext(root)[1].lower() in {".html", ".htm", ".xhtml"}:
            yield root
        return
    skip_dirs = {
        ".git", ".hg", ".svn", "__pycache__", "node_modules", "vendor",
        "dist", "build", ".next", ".nuxt", "coverage", ".venv", "venv",
    }
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [name for name in dirnames if name not in skip_dirs and not name.startswith(".")]
        for filename in sorted(filenames):
            if os.path.splitext(filename)[1].lower() in {".html", ".htm", ".xhtml"}:
                yield os.path.join(dirpath, filename)


def _extract_button_records(soup: BeautifulSoup, rel_path: str, id_text: dict[str, str]) -> list[dict]:
    records = []
    seen = set()
    for tag in soup.find_all(["button", "a", "input"]):
        tag_name = tag.name.lower()
        if tag_name == "input":
            input_type = str(tag.get("type") or "").lower()
            if input_type and input_type not in {"button", "submit", "reset"}:
                continue
        label = _control_label(tag, id_text)
        key = label.lower()
        if not label or key in seen:
            continue
        seen.add(key)
        records.append({
            "label": label,
            "file": rel_path,
            "tag": tag_name,
            "id": tag.get("id") or "",
            "role": tag.get("role") or "",
        })
    return records


def _extract_route_records(soup: BeautifulSoup, html: str, rel_path: str) -> list[dict]:
    records = []
    seen = set()

    def add(endpoint, source):
        endpoint = str(endpoint or "").strip()
        if not endpoint or endpoint.startswith(("#", "javascript:", "mailto:", "tel:")):
            return
        if not re.search(r"^(/|https?://|\./|\../)", endpoint):
            return
        key = endpoint.lower()
        if key in seen:
            return
        seen.add(key)
        records.append({"endpoint": endpoint, "file": rel_path, "source": source})

    for tag in soup.find_all(["form", "a"]):
        add(tag.get("action") or tag.get("href"), tag.name.lower())
    for attr in ("data-url", "data-endpoint", "data-api", "data-action", "data-href"):
        for tag in soup.find_all(attrs={attr: True}):
            add(tag.get(attr), attr)
    for match in re.finditer(r"\bfetch\(\s*['\"]([^'\"]+)['\"]", str(html or "")):
        add(match.group(1), "fetch")
    for match in re.finditer(r"\b(?:axios|client)\.(?:get|post|put|patch|delete)\(\s*['\"]([^'\"]+)['\"]", str(html or ""), re.IGNORECASE):
        add(match.group(1), "http_client")
    return records


def extract_features(repo_root: str, output_file: str | None = None) -> dict:
    """Compatibility API used by the HTML UI graph builder.

    Returns generic UI feature records extracted from every HTML-like file under
    repo_root. The shape keeps legacy `buttons` and `routes` keys while exposing
    section-level `features` from the current parser.
    """
    root = os.path.abspath(repo_root or "")
    feature_rows = []
    buttons = []
    routes = []
    files = []
    seen_features = set()

    for path in _html_files(root):
        try:
            with open(path, "r", encoding="utf-8", errors="ignore") as handle:
                html = handle.read()
        except OSError:
            continue
        rel_path = os.path.relpath(path, root).replace("\\", "/") if os.path.isdir(root) else os.path.basename(path)
        files.append(rel_path)
        soup = BeautifulSoup(html or "", "html.parser")
        id_text = _id_text_map(soup)
        for section in extract_html_feature_sections(html):
            name = _clean_text(section.get("name"), max_len=120)
            if not name:
                continue
            key = (rel_path.lower(), name.lower())
            if key in seen_features:
                continue
            seen_features.add(key)
            feature_rows.append({
                "name": name,
                "file": rel_path,
                "context": section.get("context") or [],
                "tag": section.get("tag") or "",
                "id": section.get("id") or "",
                "role": section.get("role") or "",
                "source": section.get("source") or "html_section",
            })
        buttons.extend(_extract_button_records(soup, rel_path, id_text))
        routes.extend(_extract_route_records(soup, html, rel_path))

    payload = {
        "features": feature_rows,
        "buttons": buttons,
        "routes": routes,
        "files": files,
        "feature_count": len(feature_rows),
        "button_count": len(buttons),
        "route_count": len(routes),
    }
    if output_file:
        os.makedirs(os.path.dirname(os.path.abspath(output_file)), exist_ok=True)
        with open(output_file, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)
    return payload


def parse_html_labels(path: str) -> list[str]:
    if not os.path.exists(path):
        return []

    with open(path, "r", encoding="utf-8", errors="ignore") as f:
        html = f.read()

    return extract_html_features_text(html, max_chars=200000).splitlines()
