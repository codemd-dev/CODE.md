from pathlib import Path

import networkx as nx

from pycg.pycg import CallGraphGenerator

import ast
import sys

# PyCG compatibility shim for Python 3.9+
# Unparser was moved out of _ast_unparse in newer versions
if sys.version_info >= (3, 9):
    try:
        import ast as _ast_mod
        import _ast_unparse
        if not hasattr(_ast_unparse, 'Unparser'):
            _ast_unparse.Unparser = _ast_mod._Unparser
    except Exception:
        pass

from pycg.pycg import CallGraphGenerator


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
                for part in p.relative_to(self.repo_root).parts  # ← relative only
            )
        ]

    # ----------------------------------------
    # generate graph
    # ----------------------------------------

    def analyze(self):

        py_files = self.discover_python_files()

        print(f"[DEBUG] PyCGParser repo_root: {self.repo_root}")
        print(f"[DEBUG] PyCGParser repo_root exists: {self.repo_root.exists()}")
        print(f"[DEBUG] PyCGParser py_files found: {len(py_files)}")
        print(f"[DEBUG] First 3 files: {py_files[:3]}")

        if not py_files:
            return self.function_graph

        try:
            cg = CallGraphGenerator(
                py_files,
                package=str(self.repo_root),
                max_iter=5,
                operation="call-graph",
            )
            cg.analyze()
            output = cg.output()
            print(f"[DEBUG] PyCG output keys: {len(output)}")
        except Exception as e:
            print(f"[DEBUG] [PyCGParser] CallGraphGenerator failed: {e}")
            return self.function_graph
        
        for caller, callees in output.items():

            self.function_graph.add_node(caller)

            for callee in callees:

                self.function_graph.add_node(callee)

                self.function_graph.add_edge(
                    caller,
                    callee
                )

        return self.function_graph
