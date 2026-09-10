import json
import os
import re
from pathlib import Path

from parsers.common import iter_supported_repo_files, write_ordered_call_sequence

CSHARP_CALL_KEYWORDS = {
    "if", "for", "foreach", "while", "switch", "catch", "using", "lock", "return",
    "throw", "new", "typeof", "nameof", "sizeof", "default", "checked", "unchecked",
}


def strip_csharp_comments_and_strings(text: str) -> str:
    result = []
    i = 0
    length = len(text)
    state = "code"
    while i < length:
        ch = text[i]
        nxt = text[i + 1] if i + 1 < length else ""
        if state == "code":
            if ch == "/" and nxt == "/":
                result.extend("  ")
                i += 2
                state = "line_comment"
                continue
            if ch == "/" and nxt == "*":
                result.extend("  ")
                i += 2
                state = "block_comment"
                continue
            if ch == "@":
                result.append(" ")
                i += 1
                if i < length and text[i] == '"':
                    result.append(" ")
                    i += 1
                    state = "verbatim_string"
                continue
            if ch == '"':
                result.append(" ")
                i += 1
                state = "string"
                continue
            if ch == "'":
                result.append(" ")
                i += 1
                state = "char"
                continue
            result.append(ch)
            i += 1
        elif state == "line_comment":
            result.append("\n" if ch == "\n" else " ")
            state = "code" if ch == "\n" else state
            i += 1
        elif state == "block_comment":
            if ch == "*" and nxt == "/":
                result.extend("  ")
                i += 2
                state = "code"
            else:
                result.append("\n" if ch == "\n" else " ")
                i += 1
        elif state == "string":
            if ch == "\\" and nxt:
                result.extend("  ")
                i += 2
            else:
                result.append("\n" if ch == "\n" else " ")
                state = "code" if ch == '"' else state
                i += 1
        elif state == "verbatim_string":
            if ch == '"' and nxt == '"':
                result.extend("  ")
                i += 2
            else:
                result.append("\n" if ch == "\n" else " ")
                state = "code" if ch == '"' else state
                i += 1
        elif state == "char":
            if ch == "\\" and nxt:
                result.extend("  ")
                i += 2
            else:
                result.append("\n" if ch == "\n" else " ")
                state = "code" if ch == "'" else state
                i += 1
    return "".join(result)


def find_matching_brace(text: str, open_index: int) -> int:
    depth = 0
    for index in range(open_index, len(text)):
        if text[index] == "{":
            depth += 1
        elif text[index] == "}":
            depth -= 1
            if depth == 0:
                return index
    return -1


def build_csharp_callgraph(repo_src, output_dir, progress_callback=None):
    method_decl = re.compile(
        r"(?m)^\s*(?:\[[^\]]+\]\s*)*"
        r"(?:(?:public|private|protected|internal|static|virtual|override|async|sealed|partial|extern|unsafe|new)\s+)*"
        r"(?:(?P<return_type>[\w<>\[\],?.]+\s+)+)?"
        r"(?P<name>[A-Za-z_][A-Za-z0-9_]*)\s*"
        r"(?:<[^>{};=]*>\s*)?\([^;{}]*\)\s*"
        r"(?:where\s+[^{]+)?\{"
    )
    class_decl = re.compile(r"\b(?:class|struct|record|interface)\s+([A-Za-z_][A-Za-z0-9_]*)[^{;]*\{")
    call_pattern = re.compile(r"(?:\b([A-Za-z_][A-Za-z0-9_]*)\s*\.\s*)?\b([A-Za-z_][A-Za-z0-9_]*)\s*\(")
    namespace_block = re.compile(r"\bnamespace\s+([A-Za-z_][\w.]*)\s*\{")
    namespace_file = re.compile(r"(?m)^\s*namespace\s+([A-Za-z_][\w.]*)\s*;")

    nodes = set()
    edges = set()
    edge_meta = {}
    ordered_calls = []
    function_files = {}
    method_records = []

    def report_progress(message, current_file=None):
        if not progress_callback:
            return
        try:
            progress_callback(message, current_file=current_file)
        except TypeError:
            progress_callback(message)

    cs_files = []
    for path in iter_supported_repo_files(repo_src, {".cs"}):
        cs_files.append(path)
    cs_files.sort()

    for path in cs_files:
        rel_path = os.path.relpath(path, repo_src).replace("\\", "/")
        report_progress("Parsing C# files.", rel_path)
        raw_text = Path(path).read_text(encoding="utf-8", errors="ignore")
        text = strip_csharp_comments_and_strings(raw_text)
        namespaces = []
        file_namespace_match = namespace_file.search(text)
        file_namespace = file_namespace_match.group(1) if file_namespace_match else ""
        for match in namespace_block.finditer(text):
            open_index = text.find("{", match.end() - 1)
            close_index = find_matching_brace(text, open_index)
            if close_index > open_index:
                namespaces.append((match.start(), close_index, match.group(1)))
        classes = []
        for match in class_decl.finditer(text):
            open_index = text.find("{", match.end() - 1)
            close_index = find_matching_brace(text, open_index)
            if close_index > open_index:
                classes.append((match.start(), close_index, match.group(1)))
        for match in method_decl.finditer(text):
            name = match.group("name")
            if name in CSHARP_CALL_KEYWORDS:
                continue
            open_index = text.find("{", match.end() - 1)
            close_index = find_matching_brace(text, open_index)
            if close_index <= open_index:
                continue
            containing_class = next((item for item in classes if item[0] <= match.start() <= item[1]), None)
            class_name = containing_class[2] if containing_class else Path(path).stem
            namespace_name = file_namespace or next((item[2] for item in namespaces if item[0] <= match.start() <= item[1]), "")
            full_name = ".".join(part for part in (namespace_name, class_name, name) if part)
            body = text[open_index + 1:close_index]
            start_line = raw_text.count("\n", 0, match.start()) + 1
            record = {
                "symbol": full_name,
                "name": name,
                "class_name": class_name,
                "namespace": namespace_name,
                "path": rel_path,
                "body": body,
                "body_offset": open_index + 1,
                "start_line": start_line,
            }
            method_records.append(record)
            nodes.add(full_name)
            function_files[full_name] = rel_path

    by_class_method = {}
    for record in method_records:
        by_class_method[(record["class_name"], record["name"])] = record["symbol"]

    edge_order = 1
    for record in method_records:
        caller = record["symbol"]
        for match in call_pattern.finditer(record["body"]):
            qualifier, call_name = match.groups()
            if call_name in CSHARP_CALL_KEYWORDS or call_name == record["name"]:
                continue
            target = ""
            if qualifier:
                target = by_class_method.get((qualifier, call_name), "")
            if not target:
                target = by_class_method.get((record["class_name"], call_name), "")
            if not target or target == caller:
                continue
            line = record["body"][:match.start()].count("\n") + record["start_line"]
            edge = (caller, target)
            edges.add(edge)
            previous = edge_meta.get(edge)
            if previous is None or edge_order < (previous.get("order") or edge_order):
                edge_meta[edge] = {"order": edge_order, "line": line}
            ordered_calls.append({
                "caller": caller,
                "callee": target,
                "order": edge_order,
                "line": line,
                "file": record["path"],
                "call_text": call_name,
            })
            edge_order += 1

    os.makedirs(output_dir, exist_ok=True)
    json_path = os.path.join(output_dir, "csharp_callgraph.json")
    graph = {
        "mode": "csharp_regex_callgraph",
        "parser": "csharp-regex",
        "nodes": sorted(nodes),
        "edges": [
            [src, dst, edge_meta.get((src, dst), {}).get("order"), edge_meta.get((src, dst), {}).get("line")]
            for src, dst in sorted(edges, key=lambda edge: (
                edge_meta.get(edge, {}).get("order") if edge_meta.get(edge, {}).get("order") is not None else 10**12,
                edge[0],
                edge[1],
            ))
        ],
        "function_files": function_files,
        "file_count": len(cs_files),
    }
    Path(json_path).write_text(json.dumps(graph, separators=(",", ":")), encoding="utf-8")
    ordered_path = os.path.join(output_dir, "csharp_ordered_call_sequence.json")
    if ordered_calls:
        write_ordered_call_sequence(
            ordered_calls,
            ordered_path,
            parser="csharp-regex",
            source_callgraph=os.path.basename(json_path),
        )
    return json_path, "", ordered_path if ordered_calls else ""
