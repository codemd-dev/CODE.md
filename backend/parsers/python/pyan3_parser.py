import logging
from pathlib import Path

import networkx as nx
from pyparsing import line

import re

logger = logging.getLogger(__name__)


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

        logger.debug("PyCGParser repo_root: %s", self.repo_root)
        logger.debug("PyCGParser py_files found: %d", len(py_files))
        logger.debug("First 3 files: %s", py_files[:3])

        if not py_files:
            return self.function_graph

        noisy_loggers = [logging.getLogger("pyan"), logging.getLogger("pyan.analyzer")]
        previous_levels = [item.level for item in noisy_loggers]
        try:
            for item in noisy_loggers:
                item.setLevel(logging.WARNING)
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

            logger.debug("pyan3 edges found: %d", self.function_graph.number_of_edges())

        except SyntaxError as e:
            logger.debug("pyan3 SyntaxError (Python 2 repo?): %s", e)
        except Exception as e:
            logger.debug("pyan3 exception: %s: %s", type(e).__name__, e)
        finally:
            for item, level in zip(noisy_loggers, previous_levels):
                item.setLevel(level)

        return self.function_graph
