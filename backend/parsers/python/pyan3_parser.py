from pathlib import Path

import networkx as nx
from pyparsing import line

import re

class PyCGParser:

    def __init__(self, repo_root):

        self.repo_root = Path(repo_root)

        self.function_graph = nx.DiGraph()

    # ----------------------------------------
    # discover files
    # ----------------------------------------

    def discover_python_files(self):
        skip_parts = {
            ".git", ".github", ".idea", ".vscode", "__pycache__",
            ".pytest_cache", ".venv", "venv", "env", "node_modules",
            "dist", "build", "target", "vendor", "vendors", "output",
        }
        return [
            str(p)
            for p in self.repo_root.rglob("*.py")
            if not any(
                part.lower() in skip_parts or
                part.lower().startswith(("output_", "output-", "output%"))
                for part in p.relative_to(self.repo_root).parts
            )
        ]

    # ----------------------------------------
    # generate graph
    # ----------------------------------------

    def analyze(self):

        py_files = self.discover_python_files()

        print(f"[DEBUG] PyCGParser repo_root: {self.repo_root}")
        print(f"[DEBUG] PyCGParser py_files found: {len(py_files)}")
        print(f"[DEBUG] First 3 files: {py_files[:3]}")

        if not py_files:
            return self.function_graph

        try:
            import pyan
            callgraph = pyan.create_callgraph(
                filenames=py_files,
                root=str(self.repo_root),
                format="dot"
                #draw_defines=False,
                #draw_calls=True,
                #colored=False,
                #grouped=False,
            )

            # pyan returns a GraphViz dot string — parse edges from it
            for line in callgraph.splitlines():
                line = line.strip()
                
                # skip empty, graph declarations, attributes
                if not line or line.startswith(('digraph', 'graph', '{', '}', '//')):
                    continue

                # skip dashed nodes (unresolved/external references)  ← HERE
                if 'dashed' in line:
                    continue
                
                if "->" not in line:
                    continue
                
                # strip ALL bracket attributes e.g. [style="solid", color="#000000"]
                line = re.sub(r'\[.*?\]', '', line).strip().rstrip(';').strip()

                # lines look like: "module_func1" -> "module_func2"
                parts = line.split("->")
                if len(parts) != 2:
                    continue
                src = parts[0].strip().strip('"').strip()
                dst = parts[1].strip().strip('"').strip()
                if src and dst:
                    self.function_graph.add_node(src)
                    self.function_graph.add_node(dst)
                    self.function_graph.add_edge(src, dst)

            print(f"[DEBUG] pyan3 edges found: {self.function_graph.number_of_edges()}")

        except SyntaxError as e:
            print(f"[DEBUG] pyan3 SyntaxError (Python 2 repo?): {e}")
        except Exception as e:
            print(f"[DEBUG] pyan3 exception: {type(e).__name__}: {e}")

        return self.function_graph