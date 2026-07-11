import ast
from pathlib import Path
from warnings import filters

from libcst.matchers import matches
import networkx as nx

from .ast_indexer import ASTSymbolIndexer

#from .pycg_parser import PyCGParser
from .pyan3_parser import PyCGParser  # ← switch to this more stable PyCG wrapper


class PythonAnalyzer:

    def __init__(self, repo_root):

        self.repo_root = Path(repo_root)

        self.symbol_index = {}

        self.function_graph = nx.DiGraph()

        self.file_graph = nx.DiGraph()

        self.per_file_graphs = {}

    # ----------------------------------------
    # filepath -> module
    # ----------------------------------------

    def filepath_to_module(self, filepath):
        
        p = Path(filepath)

        if p.suffix != ".py":
            raise ValueError(
                f"filepath_to_module called on non-Python file: {filepath}"
            )

        #relative = Path(filepath).relative_to(self.repo_root)

        relative = p.relative_to(self.repo_root)

        parts = list(relative.parts)

        #parts[-1] = parts[-1].replace(".py", "")
        parts[-1] = parts[-1].removesuffix(".py")  # suffix-only, not substring
        
        # drop leading 'src' if present, matching pycg's package rooting
        if parts and parts[0] == "src":
            parts = parts[1:]
        
        return ".".join(parts)

    # ----------------------------------------
    # AST metadata indexing
    # ----------------------------------------

    def build_symbol_index(self):

        #py_files = list(
        #    self.repo_root.rglob("*.py")
        #)

        #discover_python_files() vs build_symbol_index() use different file lists
        #PyCGParser.discover_python_files() filters aggressively (skips venv, build, etc.), 
        # but build_symbol_index() in PythonAnalyzer does a raw rglob("*.py") with no filtering.
        # This means: The symbol index has nodes named like venv.requests.models.Response
        # PyCG never saw those files, so those nodes never appear in the call graph
        # enrich_graph_nodes() finds no metadata matches → build_file_graph() skips those edges
        # Fix: Extract the skip logic into a shared utility, or have PythonAnalyzer.build_symbol_index() use PyCGParser.discover_python_files() directly:

        pycg_helper = PyCGParser(self.repo_root)
        py_files = pycg_helper.discover_python_files()  # same filtered list

        for filepath in py_files:

            module_name = self.filepath_to_module(
                filepath
            )

            try:
                source = Path(filepath).read_text(
                    encoding="utf-8",
                    errors="ignore"
                )

                tree = ast.parse(source)
            except Exception:
                continue

            indexer = ASTSymbolIndexer(
                module_name,
                filepath
            )

            indexer.visit(tree)

            self.symbol_index.update(
                indexer.symbols
            )

    # ----------------------------------------
    # PyCG callgraph
    # ----------------------------------------

    def build_callgraph(self):

        pycg = PyCGParser(self.repo_root)

        self.function_graph = pycg.analyze()


    # ----------------------------------------
    # find entry point
    # ----------------------------------------
    def find_entrypoint_nodes(self):

        entry_filenames = {"main", "app", "run", "server", "start", "__main__"}

        candidates = [
            node for node in self.function_graph.nodes()
            if node.split(".")[0] in entry_filenames
        ]

        if candidates:
            return candidates

        # fallback: nodes with no incoming edges
        return [
            node for node in self.function_graph.nodes()
            if self.function_graph.in_degree(node) == 0
        ]



    def root_graph_at_entrypoint(self):
        # find the entry point node — look for main.py's top-level calls
        #entry_nodes = [
        #    node for node in self.function_graph.nodes()
        #    if node.startswith("main.")
        #]

        entry_nodes = self.find_entrypoint_nodes()

        if not entry_nodes:
            return  # no main.py found, keep full graph
        # BFS/DFS from all main.py nodes to find reachable nodes
        reachable = set()
        for entry in entry_nodes:
            reachable.update(nx.descendants(self.function_graph, entry))
            reachable.add(entry)
        # remove unreachable nodes
        unreachable = set(self.function_graph.nodes()) - reachable
        self.function_graph.remove_nodes_from(unreachable)
        print(f"[DEBUG] entry nodes: {entry_nodes[:3]}")
        print(f"[DEBUG] reachable nodes: {len(reachable)}")
        print(f"[DEBUG] pruned unreachable: {len(unreachable)}")


    # ----------------------------------------
    # enrich nodes
    # ----------------------------------------

    def enrich_graph_nodes(self):

        for node in self.function_graph.nodes():

            metadata = self.symbol_index.get(node)

            if metadata:

                self.function_graph.nodes[node].update(
                    metadata
                )

    # ----------------------------------------
    # build file graph
    # ----------------------------------------

    
    def build_file_graph(self):
        for src, dst in self.function_graph.edges():
            # extract module from node name e.g.
            # entities__Mario__Mario____init__ → entities/Mario.py
            src_file = self.module_to_filepath(src)
            dst_file = self.module_to_filepath(dst)
            if src_file and dst_file and src_file != dst_file:
                self.file_graph.add_edge(src_file, dst_file)

    def module_to_filepath(self, node_name):
        # pyan3 uses double underscores as separators
        # entities__Mario__Mario____init__ → entities.Mario
        parts = node_name.split('__')
        # first two parts are module path e.g. ['entities', 'Mario', 'Mario', '', 'init', '']
        if len(parts) < 2:
            return None
        # reconstruct file path from first two parts
        candidate = Path(self.repo_root) / Path(*parts[:2]).with_suffix('.py')
        if candidate.exists():
            return str(candidate.relative_to(self.repo_root)).replace('\\', '/')
        # try just first part as directory + second as file
        return None



    # ----------------------------------------
    # build per-file graphs
    # ----------------------------------------




    def build_per_file_graphs(self):

        grouped = {}

        for src, dst in self.function_graph.edges():

            src_meta = self.function_graph.nodes.get(
                src,
                {}
            )

            filepath = src_meta.get("file")

            if not filepath:
                continue

            grouped.setdefault(filepath, []).append(
                (src, dst)
            )

        for filepath, edges in grouped.items():

            graph = nx.DiGraph()

            for src, dst in edges:

                graph.add_edge(src, dst)

            self.per_file_graphs[filepath] = graph

    # ----------------------------------------
    # analyze repo
    # ----------------------------------------
    def analyze(self):
        # ------------------------------------
        # PASS 1
        # AST METADATA
        # ------------------------------------

        self.build_symbol_index()

        # ------------------------------------
        # PASS 2
        # PYCG CALLGRAPH
        # ------------------------------------

        self.build_callgraph()

        # Your filepath_to_module produces src.myapp.utils but pycg might produce 
        # myapp.utils depending on where it roots from. 
        # This causes enrich_graph_nodes() to find zero matches even when both graphs are populated.
        graph_nodes = set(self.function_graph.nodes())
        index_keys  = set(self.symbol_index.keys())
        overlap = graph_nodes & index_keys
        print(f"Graph nodes: {len(graph_nodes)}, Symbol index: {len(index_keys)}, Overlap: {len(overlap)}")

        # TODO - Added new entry point main.py?
        self.root_graph_at_entrypoint()  # ← add this

        # ------------------------------------
        # MERGE
        # ------------------------------------

        self.enrich_graph_nodes()

        self.build_file_graph()

        self.build_per_file_graphs()

        return {
            "function_graph": self.function_graph,
            "file_graph": self.file_graph,
            "per_file_graphs": self.per_file_graphs,
            "symbol_index": self.symbol_index
            #"py_file_count": len(py_files),  # ← add this
        }
